import { parseGeminiSse } from "./search-utils.mjs";

export const DEFAULT_AI_MODEL = "gemini-3.6-flash";
const endpointFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
const error = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });
const publicChatError = (status) => {
  if (status === 400) return "The AI chat request was invalid.";
  if (status === 401 || status === 403) return "The AI chat service is not configured correctly.";
  if (status === 404) return "The requested AI chat model is unavailable.";
  if (status === 429) return "AI chat is busy right now. Please wait a moment and try again.";
  if (status >= 500) return "The AI chat service is temporarily unavailable. Please try again.";
  return "The AI chat request could not be completed.";
};

const combineSignals = (signals) => {
  const active = signals.filter(Boolean);
  return active.length > 1 ? AbortSignal.any(active) : active[0];
};

const messagesToContents = (messages) => messages
  .filter((message) => message?.role !== "system")
  .map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));

export const createGeminiAiProvider = ({
  fetchImpl = fetch,
  getApiKey = () => process.env.GEMINI_API_KEY,
  getModel = () => process.env.AI_MODEL || DEFAULT_AI_MODEL,
  timeoutMs = 30_000,
} = {}) => ({
  id: "gemini",
  isConfigured: () => Boolean(getApiKey()?.trim()),
  async open({ messages }, { signal } = {}) {
    const key = getApiKey()?.trim();
    if (!key) throw error(503, "AI chat has not been configured for this site yet.", { code: "missing_api_key" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(endpointFor(getModel()), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: messages.find((message) => message?.role === "system")?.content || "You are AMAN OS, a helpful and concise assistant." }] },
          contents: messagesToContents(messages),
        }),
        signal: combineSignals([signal, controller.signal]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw error(response.status, publicChatError(response.status), { retryAfter: response.headers.get("retry-after") || undefined });
      }
      if (!response.body) throw error(502, "The AI chat service returned an empty response.");
      return response.body;
    } catch (caught) {
      if (controller.signal.aborted || signal?.reason?.name === "TimeoutError" || caught?.name === "TimeoutError") throw error(504, "The AI chat request timed out. Please try again.");
      if (signal?.aborted || caught?.name === "AbortError") throw error(499, "The AI chat request was cancelled.");
      if (caught instanceof TypeError) throw error(502, "Unable to reach the AI chat service. Please try again.");
      throw caught;
    } finally {
      clearTimeout(timer);
    }
  },
  async *events(body, { signal } = {}) {
    const reader = body.getReader();
    let finished = false;
    let answer = "";
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      // Own the reader so the shared parser cannot leave it locked on cancellation.
      for await (const chunk of parseGeminiSse({ getReader: () => reader })) {
        signal?.throwIfAborted();
        if (chunk?.error) {
          const code = Number(chunk.error.code);
          const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
          throw error(status, publicChatError(status));
        }
        const candidate = chunk?.candidates?.[0];
        const blocked = chunk?.promptFeedback?.blockReason;
        if ((blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"].includes(candidate?.finishReason)) {
          throw error(422, "The AI chat service blocked this response. Please rephrase your request.");
        }
        if (candidate?.finishReason === "MAX_TOKENS") throw error(502, "The AI chat response was cut short. Please try a shorter request.");
        if (candidate?.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
          throw error(502, "The AI chat service could not complete this response. Please try again.");
        }
        const delta = (candidate?.content?.parts || [])
          .filter((part) => typeof part.text === "string" && !part.thought)
          .map((part) => part.text)
          .join("");
        if (!delta) continue;
        answer += delta;
        yield { type: "delta", delta };
      }
      signal?.throwIfAborted();
      finished = true;
      if (!answer) throw error(502, "The AI chat service returned no answer.");
      yield { type: "complete", answer };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!finished) await reader.cancel(signal?.reason).catch(() => {});
      reader.releaseLock();
    }
  },
});
