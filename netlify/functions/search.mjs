import {
  MAX_BODY_BYTES,
  MAX_QUERY_LENGTH,
  hasAllowedOrigin,
  json,
  clientKey,
  createRateLimiter,
  sse,
} from "./lib/search-utils.mjs";
import { searchWithoutApiKey } from "./lib/no-key-search.mjs";

const rateLimit = createRateLimiter({ limit: 20, windowMs: 60_000 });
const encoder = new TextEncoder();

const rateHeaders = (result) => ({
  "X-RateLimit-Limit": String(result.limit),
  "X-RateLimit-Remaining": String(result.remaining),
});

export const createSearchHandler = ({ fetchImpl = fetch, limiter = rateLimit } = {}) => async (request) => {
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

  try {
    const result = await searchWithoutApiKey(query, { fetchImpl });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse("delta", { delta: result.answer })));
        controller.enqueue(encoder.encode(sse("sources", result)));
        controller.enqueue(encoder.encode(sse("done", {})));
        controller.close();
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
    const message = error?.name === "AbortError"
      ? "Public search sources timed out. Please try again."
      : "No public search source is available right now. Please try again.";
    return json(502, { error: message, code: "search_sources_unavailable" }, rateHeaders(allowed));
  }
};

export default createSearchHandler();
