import { createGeminiProvider } from "./gemini-provider.mjs";

const providerError = (status, message, options = {}) => Object.assign(new Error(message), { status, ...options });
const isProduction = () => process.env.NODE_ENV === "production" || process.env.CONTEXT === "production";

export const createMockSearchProvider = () => ({
  id: "development-mock-search",
  isConfigured: () => !isProduction(),
  async open(query) { return { query }; },
  async *events({ query }) {
    const answer = `Development mock mode is active. AMAN OS received “${query}”, but did not perform a live web search. Configure GEMINI_API_KEY for real web sources.`;
    yield { type: "delta", delta: answer };
    yield { type: "complete", answer, annotations: [], sources: [], developmentMock: true };
  },
});

export const createGeminiSearchProvider = (client = createGeminiProvider()) => ({
  id: "gemini-google-search",
  isConfigured: () => client.isConfigured(),
  open: (query, options) => client.open(query, options),
  events: (body) => client.events(body),
});

export const createSearchGateway = ({
  primary = createGeminiSearchProvider(),
  fallback = null,
} = {}) => {
  const configured = () => [primary, fallback].filter((provider) => provider?.isConfigured?.());
  const chooseFallback = (current) => fallback && fallback !== current && fallback.isConfigured?.() ? fallback : null;

  return {
    isConfigured: () => configured().length > 0,
    providerId: () => configured()[0]?.id || null,
    async open(request, { signal } = {}) {
      const provider = configured()[0];
      if (!provider) throw providerError(503, "AI search has not been configured for this site yet.", { code: "missing_api_key" });
      try {
        return { provider, body: await provider.open(request.query, { signal }) };
      } catch (error) {
        const alternate = chooseFallback(provider);
        if (!alternate || error?.status === 400 || error?.status === 401 || error?.status === 403) throw error;
        return { provider: alternate, body: await alternate.open(request.query, { signal }) };
      }
    },
    events: ({ provider, body }) => provider.events(body),
  };
};

export const createConfiguredSearchGateway = ({ env = process.env } = {}) => {
  const requested = env.SEARCH_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "mock");
  const fallbackRequested = env.SEARCH_FALLBACK_PROVIDER;
  const gemini = createGeminiSearchProvider();
  const mock = createMockSearchProvider();
  const resolve = (name) => name === "mock" ? mock : name === "gemini" ? gemini : null;
  return createSearchGateway({ primary: resolve(requested), fallback: resolve(fallbackRequested) });
};
