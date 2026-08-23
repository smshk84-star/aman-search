import {
  extractGeminiAnswer,
  parseGeminiSse,
  publicApiError,
} from "./search-utils.mjs";

export const GEMINI_MODEL = "gemini-3.6-flash";
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

const createProviderError = (status, message, options = {}) => Object.assign(new Error(message), {
  status,
  ...options,
});

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason || new DOMException("Aborted", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const combinedSignal = (signals) => {
  const active = signals.filter(Boolean);
  return active.length > 1 ? AbortSignal.any(active) : active[0];
};

const isRetriable = (error) => error?.retryable
  || error?.status >= 500
  || error?.name === "TimeoutError"
  || error instanceof TypeError;

const toProviderError = async (response) => {
  let payload = null;
  try { payload = await response.json(); } catch { /* The provider did not return JSON. */ }
  const retryAfter = response.headers.get("retry-after");
  return createProviderError(response.status, publicApiError(response.status, payload), {
    retryAfter,
    retryable: response.status >= 500,
  });
};

const geminiRequest = (query) => ({
  system_instruction: {
    parts: [{
      text: "You are AMAN Search. Answer the user's question with current web research. Be concise, factual, and cite your sources.",
    }],
  },
  contents: [{ role: "user", parts: [{ text: query }] }],
  tools: [{ google_search: {} }],
});

export const createGeminiProvider = ({
  fetchImpl = fetch,
  getApiKey = () => process.env.GEMINI_API_KEY,
  endpoint = GEMINI_ENDPOINT,
  maxAttempts = 2,
  attemptTimeoutMs = 25_000,
  sleep = delay,
} = {}) => {
  const isConfigured = () => Boolean(getApiKey()?.trim());

  const open = async (query, { signal } = {}) => {
    const apiKey = getApiKey()?.trim();
    if (!apiKey) {
      throw createProviderError(503, "AI search has not been configured for this site yet.", {
        code: "missing_api_key",
      });
    }

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutController = new AbortController();
      const requestSignal = combinedSignal([signal, timeoutController.signal]);
      const timer = setTimeout(
        () => timeoutController.abort(new DOMException("Timed out", "TimeoutError")),
        attemptTimeoutMs,
      );

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(geminiRequest(query)),
          signal: requestSignal,
        });
        clearTimeout(timer);

        if (!response.ok) throw await toProviderError(response);
        if (!response.body) {
          throw createProviderError(502, "The AI search service returned an empty response.");
        }

        return response.body;
      } catch (error) {
        clearTimeout(timer);
        const timedOut = timeoutController.signal.aborted
          || signal?.reason?.name === "TimeoutError"
          || error?.name === "TimeoutError";
        const normalized = timedOut
          ? createProviderError(504, "The AI search request timed out. Please try again.", { retryable: true, name: "TimeoutError" })
          : error instanceof TypeError
            ? createProviderError(502, "Unable to reach the AI search service. Please try again.", { retryable: true })
            : error;
        lastError = normalized;

        if (!isRetriable(normalized) || attempt === maxAttempts || signal?.aborted) break;
        await sleep(250 * attempt, signal);
      }
    }

    if (lastError?.name === "AbortError" || (signal?.aborted && signal.reason?.name !== "TimeoutError")) {
      throw createProviderError(499, "The search request was cancelled.");
    }
    throw lastError || createProviderError(502, "Unable to reach the AI search service. Please try again.");
  };

  const events = async function* (body) {
    let answer = "";
    let groundingChunks = [];
    let groundingSupports = [];
    let complete = false;

    for await (const chunk of parseGeminiSse(body)) {
      const candidate = chunk?.candidates?.[0];
      if (!candidate) continue;
      const delta = (candidate.content?.parts || [])
        .filter((part) => typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (delta) {
        answer += delta;
        yield { type: "delta", delta };
      }

      const metadata = candidate.groundingMetadata;
      if (metadata?.groundingChunks?.length) groundingChunks = metadata.groundingChunks;
      if (metadata?.groundingSupports?.length) groundingSupports = metadata.groundingSupports;

      if (candidate.finishReason && candidate.finishReason !== "OTHER") {
        complete = true;
        break;
      }
    }

    if (!answer) throw createProviderError(502, "The AI search service returned no answer.");
    const { annotations, sources } = extractGeminiAnswer(groundingChunks, groundingSupports);
    yield { type: "complete", answer, annotations, sources, incomplete: !complete };
  };

  return { isConfigured, open, events };
};
