import {
  MAX_BODY_BYTES,
  MAX_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
  clientKey,
  createRateLimiter,
  hasAllowedOrigin,
  json,
  sse,
} from "./lib/search-utils.mjs";
import { createGeminiProvider } from "./lib/gemini-provider.mjs";

const rateLimit = createRateLimiter({ limit: 8, windowMs: 60_000 });
const encoder = new TextEncoder();

const rateHeaders = (result) => ({
  "X-RateLimit-Limit": String(result.limit),
  "X-RateLimit-Remaining": String(result.remaining),
});

const combinedSignal = (signals) => {
  const active = signals.filter(Boolean);
  return active.length > 1 ? AbortSignal.any(active) : active[0];
};

const errorResponse = (error, headers) => json(error?.status || 502, {
  ...(error?.code ? { code: error.code } : {}),
  error: error?.message || "Unable to reach the AI search service. Please try again.",
}, {
  ...headers,
  ...(error?.retryAfter ? { "Retry-After": error.retryAfter } : {}),
});

export const createSearchHandler = ({
  provider = createGeminiProvider(),
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

  if (!provider.isConfigured()) {
    return json(503, {
      code: "missing_api_key",
      error: "AI search has not been configured for this site yet.",
    }, rateHeaders(allowed));
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new DOMException("Timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );
  const signal = combinedSignal([request.signal, timeoutController.signal]);

  let upstream;
  try {
    upstream = await provider.open(query, { signal });
  } catch (error) {
    clearTimeout(timeout);
    return errorResponse(error, rateHeaders(allowed));
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of provider.events(upstream)) {
          if (event.type === "delta") {
            controller.enqueue(encoder.encode(sse("delta", { delta: event.delta })));
          } else if (event.type === "complete") {
            controller.enqueue(encoder.encode(sse("sources", {
              answer: event.answer,
              annotations: event.annotations,
              sources: event.sources,
            })));
            controller.enqueue(encoder.encode(sse("done", {})));
          }
        }
      } catch (error) {
        const message = error?.name === "TimeoutError"
          ? "The AI search request timed out. Please try again."
          : error?.message || "Unable to reach the AI search service. Please try again.";
        controller.enqueue(encoder.encode(sse("error", { error: message })));
      } finally {
        clearTimeout(timeout);
        controller.close();
      }
    },
    cancel() {
      clearTimeout(timeout);
      timeoutController.abort(new DOMException("Cancelled", "AbortError"));
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
};

export default createSearchHandler();
