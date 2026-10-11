import { createGeminiAiProvider, DEFAULT_AI_MODEL } from "./gemini-ai-provider.mjs";
import { createOllamaAiProvider, DEFAULT_OLLAMA_MODEL } from "./ollama-provider.mjs";

const isProduction = (env) => env.NODE_ENV === "production" || env.CONTEXT === "production";
const providerError = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });

export const createMockAiProvider = ({ env = process.env } = {}) => ({
  id: "development-mock-ai",
  isConfigured: () => !isProduction(env),
  async open({ messages }, { signal } = {}) {
    signal?.throwIfAborted();
    if (isProduction(env)) throw providerError(503, "AI chat has not been configured for this site yet.", { code: "missing_api_key" });
    return { message: messages.at(-1)?.content || "" };
  },
  async *events({ message }, { signal } = {}) {
    signal?.throwIfAborted();
    const answer = `Development mock mode: I received “${message}”. Configure GEMINI_API_KEY to use a real AI provider.`;
    yield { type: "delta", delta: answer };
    signal?.throwIfAborted();
    yield { type: "complete", answer, developmentMock: true };
  },
});

export const createAiGateway = ({ primary = createGeminiAiProvider(), fallback = null } = {}) => ({
  isConfigured: () => Boolean(primary?.isConfigured?.() || fallback?.isConfigured?.()),
  providerId: () => primary?.isConfigured?.() ? primary.id : fallback?.isConfigured?.() ? fallback.id : null,
  async open(request, { signal } = {}) {
    signal?.throwIfAborted();
    const provider = primary?.isConfigured?.() ? primary : fallback?.isConfigured?.() ? fallback : null;
    if (!provider) throw providerError(503, "AI chat has not been configured for this site yet.", { code: "missing_api_key" });
    try { return { provider, body: await provider.open(request, { signal }) }; } catch (caught) {
      if (signal?.aborted || caught?.name === "AbortError" || !fallback?.isConfigured?.() || provider === fallback || [400, 401, 403].includes(caught?.status)) throw caught;
      return { provider: fallback, body: await fallback.open(request, { signal }) };
    }
  },
  events: ({ provider, body }, options = {}) => provider.events(body, options),
});

export const createConfiguredAiGateway = ({ env = process.env } = {}) => {
  const requested = env.AI_PROVIDER || (env.GEMINI_API_KEY?.trim() ? "gemini" : "mock");
  const fallbackRequested = env.AI_FALLBACK_PROVIDER;
  const gemini = createGeminiAiProvider({ getApiKey: () => env.GEMINI_API_KEY, getModel: () => env.AI_MODEL || DEFAULT_AI_MODEL });
  const ollama = createOllamaAiProvider({ getBaseUrl: () => env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", getModel: () => env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL });
  const mock = createMockAiProvider({ env });
  const resolve = (name) => name === "mock" ? mock : name === "gemini" ? gemini : name === "ollama" ? ollama : null;
  return createAiGateway({ primary: resolve(requested), fallback: resolve(fallbackRequested) });
};
