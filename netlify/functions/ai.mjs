import {
  MAX_BODY_BYTES,
  clientKey,
  createRateLimiter,
  hasAllowedOrigin,
  json,
  sse,
} from "./lib/search-utils.mjs";
import { createConfiguredAiGateway } from "./lib/ai-gateway.mjs";

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 6_000;
const encoder = new TextEncoder();
const rateLimit = createRateLimiter({ limit: 12, windowMs: 60_000 });
const rateHeaders = (result) => ({ "X-RateLimit-Limit": String(result.limit), "X-RateLimit-Remaining": String(result.remaining) });
const combinedSignal = (signals) => {
  const active = signals.filter(Boolean);
  return active.length > 1 ? AbortSignal.any(active) : active[0];
};

export const validateMessages = (messages) => {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return null;
  const valid = messages.map((message) => ({
    role: message?.role,
    content: typeof message?.content === "string" ? message.content.trim() : "",
  })).filter((message) => ["system", "user", "assistant"].includes(message.role) && message.content && message.content.length <= MAX_MESSAGE_LENGTH);
  return valid.length === messages.length && valid.some((message) => message.role === "user") ? valid : null;
};

export const createAiHandler = ({ gateway = createConfiguredAiGateway(), limiter = rateLimit } = {}) => async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { Allow: "POST" });
  if (!hasAllowedOrigin(request)) return json(403, { error: "Cross-site AI requests are not allowed." });
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json(413, { error: "AI request is too large." });

  let messages;
  try { ({ messages } = await request.json()); } catch { return json(400, { error: "Invalid JSON request body." }); }
  messages = validateMessages(messages);
  if (!messages) return json(400, { error: "Send between 1 and 20 valid messages." });

  const allowed = limiter(clientKey(request));
  if (!allowed.allowed) return json(429, { error: "Too many AI requests. Please wait a minute and try again." }, { "Retry-After": String(allowed.retryAfter), ...rateHeaders(allowed) });
  if (!gateway.isConfigured()) return json(503, { code: "missing_api_key", error: "AI chat has not been configured for this site yet." }, rateHeaders(allowed));

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), 55_000);
  let upstream;
  try {
    upstream = await gateway.open({ messages }, { signal: combinedSignal([request.signal, timeout.signal]) });
  } catch (error) {
    clearTimeout(timer);
    return json(error?.status || 502, { ...(error?.code ? { code: error.code } : {}), error: error?.message || "Unable to reach the AI chat service." }, { ...rateHeaders(allowed), ...(error?.retryAfter ? { "Retry-After": error.retryAfter } : {}) });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of gateway.events(upstream)) {
          if (event.type === "delta") controller.enqueue(encoder.encode(sse("delta", { delta: event.delta })));
          if (event.type === "complete") {
            controller.enqueue(encoder.encode(sse("complete", { answer: event.answer, developmentMock: Boolean(event.developmentMock) })));
            controller.enqueue(encoder.encode(sse("done", {})));
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(sse("error", { error: error?.message || "Unable to complete this AI request." })));
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    cancel() { clearTimeout(timer); timeout.abort(new DOMException("Cancelled", "AbortError")); },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", ...rateHeaders(allowed) } });
};

export default createAiHandler();
