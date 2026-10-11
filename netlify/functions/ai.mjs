import {
  clientKey,
  createRateLimiter,
  hasAllowedOrigin,
  json,
  sse,
} from "./lib/search-utils.mjs";
import { createConfiguredAiGateway } from "./lib/ai-gateway.mjs";

const MAX_AI_BODY_BYTES = 512_000;
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

const readBody = async (request) => {
  if (!request.body) throw new SyntaxError("Missing request body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AI_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error("AI request is too large."), { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
};

export const createAiHandler = ({ gateway = createConfiguredAiGateway(), limiter = rateLimit } = {}) => async (request) => {
  if (!["GET", "POST"].includes(request.method)) return json(405, { error: "Method not allowed." }, { Allow: "GET, POST" });
  // Browser GETs can omit Origin; Fetch Metadata still identifies other origins.
  if (!hasAllowedOrigin(request) || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site"))) {
    return json(403, { error: "Cross-site AI requests are not allowed." });
  }
  if (request.method === "GET") {
    const provider = gateway.providerId();
    return json(200, { configured: Boolean(provider), developmentMock: provider === "development-mock-ai", provider });
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_AI_BODY_BYTES) return json(413, { error: "AI request is too large." });

  let messages;
  try { ({ messages } = await readBody(request)); } catch (error) {
    return json(error?.status === 413 ? 413 : 400, { error: error?.status === 413 ? "AI request is too large." : "Invalid JSON request body." });
  }
  messages = validateMessages(messages);
  if (!messages) return json(400, { error: "Send between 1 and 20 valid messages." });

  const allowed = limiter(clientKey(request));
  if (!allowed.allowed) return json(429, { error: "Too many AI requests. Please wait a minute and try again." }, { "Retry-After": String(allowed.retryAfter), ...rateHeaders(allowed) });
  if (!gateway.isConfigured()) return json(503, { code: "missing_api_key", error: "AI chat has not been configured for this site yet." }, rateHeaders(allowed));

  const cancellation = new AbortController();
  const signal = combinedSignal([request.signal, cancellation.signal]);
  const timer = setTimeout(() => cancellation.abort(new DOMException("Timed out", "TimeoutError")), 55_000);
  let upstream;
  try {
    upstream = await gateway.open({ messages }, { signal });
  } catch (error) {
    clearTimeout(timer);
    return json(error?.status || 502, { ...(error?.code ? { code: error.code } : {}), error: error?.message || "Unable to reach the AI chat service." }, { ...rateHeaders(allowed), ...(error?.retryAfter ? { "Retry-After": error.retryAfter } : {}) });
  }

  let closed = false;
  let streamController;
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };
  const emit = (type, data) => {
    if (!closed) streamController.enqueue(encoder.encode(sse(type, data)));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    streamController.close();
  };
  const onAbort = () => {
    if (signal.reason?.name === "TimeoutError") emit("error", { error: "The AI chat request timed out. Please try again." });
    close();
  };
  const stream = new ReadableStream({
    async start(controller) {
      streamController = controller;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        for await (const event of gateway.events(upstream, { signal })) {
          if (closed || signal.aborted) break;
          if (event.type === "delta") emit("delta", { delta: event.delta });
          if (event.type === "complete") {
            emit("complete", { answer: event.answer, developmentMock: Boolean(event.developmentMock) });
            emit("done", {});
            close();
            break;
          }
        }
      } catch (error) {
        emit("error", { error: error?.message || "Unable to complete this AI request." });
      } finally {
        close();
      }
    },
    cancel(reason) {
      closed = true;
      cleanup();
      cancellation.abort(reason ?? new DOMException("Cancelled", "AbortError"));
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", ...rateHeaders(allowed) } });
};

export default createAiHandler();
