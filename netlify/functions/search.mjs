import {
  MAX_BODY_BYTES,
  MAX_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
  clientKey,
  createRateLimiter,
  extractGeminiAnswer,
  hasAllowedOrigin,
  json,
  parseGeminiSse,
  publicApiError,
  sse,
} from "./lib/search-utils.mjs";

// ─── Gemini endpoint ──────────────────────────────────────────────────────────
//
// We use streamGenerateContent with ?alt=sse so the response is a plain
// text/event-stream rather than the multipart/x-mixed-replace format.
// The API key is sent as a header (x-goog-api-key) so it never appears in
// the URL and is never logged by Netlify's request log.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";

const rateLimit = createRateLimiter({ limit: 8, windowMs: 60_000 });
const encoder = new TextEncoder();

const rateHeaders = (result) => ({
  "X-RateLimit-Limit": String(result.limit),
  "X-RateLimit-Remaining": String(result.remaining),
});

export const createSearchHandler = ({
  fetchImpl = fetch,
  getApiKey = () => process.env.GEMINI_API_KEY,
  limiter = rateLimit,
} = {}) => async (request) => {

  // ── Method + origin guard ────────────────────────────────────────────────
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." }, { Allow: "POST" });
  }
  if (!hasAllowedOrigin(request)) {
    return json(403, { error: "Cross-site search requests are not allowed." });
  }

  // ── Body size guard ──────────────────────────────────────────────────────
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return json(413, { error: "Search request is too large." });
  }

  // ── Parse + validate query ───────────────────────────────────────────────
  let query;
  try { ({ query } = await request.json()); } catch {
    return json(400, { error: "Invalid JSON request body." });
  }
  query = typeof query === "string" ? query.trim() : "";
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return json(400, { error: "Enter a search query of up to 1,000 characters." });
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  const allowed = limiter(clientKey(request));
  if (!allowed.allowed) {
    return json(429, { error: "Too many searches. Please wait a minute and try again." }, {
      ...rateHeaders(allowed),
      "Retry-After": String(allowed.retryAfter),
    });
  }

  // ── API key guard ────────────────────────────────────────────────────────
  const apiKey = getApiKey();
  if (!apiKey) {
    return json(503, {
      code: "missing_api_key",
      error: "AI search has not been configured for this site yet.",
    }, rateHeaders(allowed));
  }

  // ── Call Gemini ──────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are AMAN Search. Answer the user's question with current web research. Be concise, factual, and cite your sources.",
          }],
        },
        contents: [{
          role: "user",
          parts: [{ text: query }],
        }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 1.0,
        },
      }),
      signal: controller.signal,
    });

    // ── Upstream error ─────────────────────────────────────────────────────
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* upstream body was not JSON */ }
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

    // ── Stream SSE to client ───────────────────────────────────────────────
    //
    // Gemini sends one GenerateContentResponse JSON object per SSE event.
    // Every chunk may carry a text delta in candidates[0].content.parts[].text.
    // The final chunk (finishReason === "STOP") carries groundingMetadata with
    // groundingChunks and groundingSupports for citations.
    //
    // We translate this into the frontend's existing three-event protocol:
    //   delta   → incremental answer text
    //   sources → full answer + annotations + sources (sent once, on finish)
    //   done    → stream complete

    const stream = new ReadableStream({
      async start(controllerStream) {
        let streamedAnswer = "";
        let finalGroundingChunks = [];
        let finalGroundingSupports = [];
        let completed = false;

        try {
          for await (const chunk of parseGeminiSse(response.body)) {
            const candidate = chunk?.candidates?.[0];
            if (!candidate) continue;

            // Accumulate text delta from all content parts in this chunk.
            const parts = candidate.content?.parts ?? [];
            const deltaText = parts
              .filter((p) => typeof p.text === "string")
              .map((p) => p.text)
              .join("");

            if (deltaText) {
              streamedAnswer += deltaText;
              controllerStream.enqueue(
                encoder.encode(sse("delta", { delta: deltaText })),
              );
            }

            // Collect groundingMetadata — it arrives on the last chunk but we
            // always overwrite so we keep whichever chunk is most complete.
            const gm = candidate.groundingMetadata;
            if (gm) {
              if (Array.isArray(gm.groundingChunks) && gm.groundingChunks.length) {
                finalGroundingChunks = gm.groundingChunks;
              }
              if (Array.isArray(gm.groundingSupports) && gm.groundingSupports.length) {
                finalGroundingSupports = gm.groundingSupports;
              }
            }

            // Finish when the model signals STOP (or any terminal reason).
            if (candidate.finishReason && candidate.finishReason !== "OTHER") {
              const answer = streamedAnswer;
              if (!answer) throw new Error("The AI search service returned no answer.");

              const { annotations, sources } = extractGeminiAnswer(
                finalGroundingChunks,
                finalGroundingSupports,
              );

              controllerStream.enqueue(
                encoder.encode(sse("sources", { answer, annotations, sources })),
              );
              controllerStream.enqueue(encoder.encode(sse("done", {})));
              completed = true;
              break;
            }
          }

          // Stream ended without a STOP finishReason — emit what we have.
          if (!completed) {
            if (!streamedAnswer) throw new Error("The AI search service returned no answer.");

            const { annotations, sources } = extractGeminiAnswer(
              finalGroundingChunks,
              finalGroundingSupports,
            );

            controllerStream.enqueue(
              encoder.encode(sse("sources", { answer: streamedAnswer, annotations, sources })),
            );
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
      cancel() {
        clearTimeout(timeout);
        controller.abort();
      },
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
