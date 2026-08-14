import {
  MAX_BODY_BYTES,
  MAX_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
  clientKey,
  createRateLimiter,
  extractAnswer,
  hasAllowedOrigin,
  json,
  parseSse,
  publicApiError,
  sse,
} from "./lib/search-utils.mjs";

const rateLimit = createRateLimiter({ limit: 8, windowMs: 60_000 });
const encoder = new TextEncoder();

const rateHeaders = (result) => ({
  "X-RateLimit-Limit": String(result.limit),
  "X-RateLimit-Remaining": String(result.remaining),
});

const errorMessage = (event) => event?.response?.error?.message || event?.error?.message || "The AI search request failed.";

export const createSearchHandler = ({
  fetchImpl = fetch,
  getApiKey = () => process.env.OPENAI_API_KEY,
  limiter = rateLimit,
} = {}) => async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { Allow: "POST" });
  if (!hasAllowedOrigin(request)) return json(403, { error: "Cross-site search requests are not allowed." });

  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return json(413, { error: "Search request is too large." });
  }

  let query;
  try { ({ query } = await request.json()); } catch { return json(400, { error: "Invalid JSON request body." }); }
  query = typeof query === "string" ? query.trim() : "";
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return json(400, { error: "Enter a search query of up to 1,000 characters." });
  }

  const allowed = limiter(clientKey(request));
  if (!allowed.allowed) {
    return json(429, { error: "Too many searches. Please wait a minute and try again." }, {
      ...rateHeaders(allowed),
      "Retry-After": String(allowed.retryAfter),
    });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return json(503, {
      code: "missing_api_key",
      error: "AI search has not been configured for this site yet.",
    }, rateHeaders(allowed));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        reasoning: { effort: "low" },
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        stream: true,
        instructions: "You are AMAN Search. Answer the user's question with current web research. Be concise, factual, and use the user's language where appropriate. Cite factual claims with the web citations returned by the tool.",
        input: query,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* The upstream response was not JSON. */ }
      const retryAfter = response.headers.get("retry-after");
      clearTimeout(timeout);
      return json(response.status, { error: publicApiError(response.status, payload) }, {
        ...rateHeaders(allowed),
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      });
    }

    if (!response.body) {
      clearTimeout(timeout);
      return json(502, { error: "The AI search service returned an empty response." }, rateHeaders(allowed));
    }

    const stream = new ReadableStream({
      async start(controllerStream) {
        let streamedAnswer = "";
        let completed = false;
        try {
          for await (const event of parseSse(response.body)) {
            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
              streamedAnswer += event.delta;
              controllerStream.enqueue(encoder.encode(sse("delta", { delta: event.delta })));
              continue;
            }

            if (event.type === "response.completed") {
              const result = extractAnswer(event.response || event);
              const answer = result.answer || streamedAnswer;
              if (!answer) throw new Error("The AI search service returned no answer.");
              controllerStream.enqueue(encoder.encode(sse("sources", { ...result, answer })));
              controllerStream.enqueue(encoder.encode(sse("done", {})));
              completed = true;
              break;
            }

            if (event.type === "response.failed" || event.type === "error") {
              throw new Error(errorMessage(event));
            }
          }

          if (!completed) {
            if (!streamedAnswer) throw new Error("The AI search service returned no answer.");
            controllerStream.enqueue(encoder.encode(sse("sources", { answer: streamedAnswer, annotations: [], sources: [] })));
            controllerStream.enqueue(encoder.encode(sse("done", {})));
          }
        } catch (error) {
          const message = error?.name === "TimeoutError"
            ? "The AI search request timed out. Please try again."
            : error?.message || "Unable to reach the AI search service. Please try again.";
          controllerStream.enqueue(encoder.encode(sse("error", { error: message })));
        } finally {
          clearTimeout(timeout);
          controllerStream.close();
        }
      },
      cancel() { clearTimeout(timeout); controller.abort(); },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...rateHeaders(allowed),
      },
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === "TimeoutError") {
      return json(504, { error: "The AI search request timed out. Please try again." }, rateHeaders(allowed));
    }
    return json(502, { error: "Unable to reach the AI search service. Please try again." }, rateHeaders(allowed));
  }
};

export default createSearchHandler();
