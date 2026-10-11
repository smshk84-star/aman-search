export const DEFAULT_OLLAMA_MODEL = "qwen3:4b";
const endpointFor = (baseUrl) => `${String(baseUrl).replace(/\/+$/, "")}/api/chat`;
const error = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });

const messagesToOllama = (messages) => messages
  .filter((message) => ["system", "user", "assistant"].includes(message?.role))
  .map((message) => ({ role: message.role, content: String(message.content || "") }));

const parseNdjsonLine = (line) => {
  if (!line.trim()) return null;
  let payload;
  try { payload = JSON.parse(line); } catch { throw error(502, "The local AI model returned an unexpected response."); }
  if (payload?.error) throw error(502, `Local AI error: ${payload.error}`);
  return payload;
};

export const createOllamaAiProvider = ({
  fetchImpl = fetch,
  getBaseUrl = () => process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  getModel = () => process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
  timeoutMs = 120_000,
} = {}) => ({
  id: "ollama",
  isConfigured: () => true,
  async open({ messages }, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(endpointFor(getBaseUrl()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: getModel(), messages: messagesToOllama(messages), stream: true, think: false }),
        signal: combined,
      });
      if (!response.ok) throw error(response.status === 404 ? 404 : 502, response.status === 404
        ? `The model "${getModel()}" was not found locally. Run: ollama pull ${getModel()}`
        : "The local AI service rejected the request.");
      if (!response.body) throw error(502, "The local AI service returned an empty response.");
      return response.body;
    } catch (caught) {
      if (caught?.status) throw caught;
      if (signal?.aborted) throw Object.assign(new Error("The AI request was cancelled."), { status: 499, name: "AbortError" });
      if (controller.signal.aborted || caught?.name === "TimeoutError") throw error(504, "The local AI model took too long to respond. Please try again.");
      throw error(502, "The local Ollama server is not reachable. Start Ollama and try again.");
    } finally {
      clearTimeout(timer);
    }
  },
  async *events(body, { signal } = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let answer = "";
    let buffer = "";
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      while (true) {
        const { value, done } = await reader.read();
        if (signal?.aborted) break;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const payload = parseNdjsonLine(line);
          const delta = payload?.message?.content;
          if (typeof delta === "string" && delta) { answer += delta; yield { type: "delta", delta }; }
          if (payload?.done) break;
        }
        if (done) break;
      }
      const tail = parseNdjsonLine(buffer);
      const delta = tail?.message?.content;
      if (typeof delta === "string" && delta) { answer += delta; yield { type: "delta", delta }; }
      if (signal?.aborted) return;
      if (!answer.trim()) throw error(502, "The local AI model returned no answer. It may still be loading — try again.");
      yield { type: "complete", answer };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try { await reader.cancel(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  },
});
