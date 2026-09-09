import { parseGeminiSse, publicApiError } from "./search-utils.mjs";

export const DEFAULT_AI_MODEL = "gemini-3.6-flash";
const endpointFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
const error = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });

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
        let payload = null;
        try { payload = await response.json(); } catch { /* intentionally hidden */ }
        throw error(response.status, publicApiError(response.status, payload), { retryAfter: response.headers.get("retry-after") || undefined });
      }
      if (!response.body) throw error(502, "The AI chat service returned an empty response.");
      return response.body;
    } catch (caught) {
      if (controller.signal.aborted || caught?.name === "TimeoutError") throw error(504, "The AI chat request timed out. Please try again.");
      if (caught instanceof TypeError) throw error(502, "Unable to reach the AI chat service. Please try again.");
      throw caught;
    } finally {
      clearTimeout(timer);
    }
  },
  async *events(body) {
    let answer = "";
    for await (const chunk of parseGeminiSse(body)) {
      const delta = (chunk?.candidates?.[0]?.content?.parts || [])
        .filter((part) => typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!delta) continue;
      answer += delta;
      yield { type: "delta", delta };
    }
    if (!answer) throw error(502, "The AI chat service returned no answer.");
    yield { type: "complete", answer };
  },
});
