import { createGeminiAiProvider } from "./gemini-ai-provider.mjs";

const isProduction = () => process.env.NODE_ENV === "production" || process.env.CONTEXT === "production";
const providerError = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });

export const createMockAiProvider = () => ({
  id: "development-mock-ai",
  isConfigured: () => !isProduction(),
  async open({ messages }) { return { message: messages.at(-1)?.content || "" }; },
  async *events({ message }) {
    const answer = `Development mock mode: I received “${message}”. Configure GEMINI_API_KEY to use a real AI provider.`;
    yield { type: "delta", delta: answer };
    yield { type: "complete", answer, developmentMock: true };
  },
});

export const createAiGateway = ({ primary = createGeminiAiProvider(), fallback = null } = {}) => ({
  isConfigured: () => Boolean(primary?.isConfigured?.() || fallback?.isConfigured?.()),
  providerId: () => primary?.isConfigured?.() ? primary.id : fallback?.isConfigured?.() ? fallback.id : null,
  async open(request, { signal } = {}) {
    const provider = primary?.isConfigured?.() ? primary : fallback?.isConfigured?.() ? fallback : null;
    if (!provider) throw providerError(503, "AI chat has not been configured for this site yet.", { code: "missing_api_key" });
    try { return { provider, body: await provider.open(request, { signal }) }; } catch (caught) {
      if (!fallback || provider === fallback || [400, 401, 403].includes(caught?.status)) throw caught;
      return { provider: fallback, body: await fallback.open(request, { signal }) };
    }
  },
  events: ({ provider, body }) => provider.events(body),
});

export const createConfiguredAiGateway = ({ env = process.env } = {}) => {
  const requested = env.AI_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "mock");
  const fallbackRequested = env.AI_FALLBACK_PROVIDER;
  const gemini = createGeminiAiProvider();
  const mock = createMockAiProvider();
  const resolve = (name) => name === "mock" ? mock : name === "gemini" ? gemini : null;
  return createAiGateway({ primary: resolve(requested), fallback: resolve(fallbackRequested) });
};
