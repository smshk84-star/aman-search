# AMAN Search

AMAN Search is a static PWA with a secure Netlify Function that calls the Google Gemini API (`gemini-3.6-flash`) with Google Search grounding. The existing AMAN interface is retained; answers stream into the page, then show linked citations and a source list derived from Gemini's `groundingMetadata`.

## Architecture

- `index.html` and `app.js`: the existing AMAN interface and streaming search client. Unchanged.
- `netlify/functions/search.mjs`: server-only request handler. It validates requests, enforces the in-process rate limit, preserves cancellation, and translates the provider stream into the existing browser SSE contract: `delta`, `sources`, `done`, and `error`.
- `netlify/functions/lib/gemini-provider.mjs`: the active provider adapter. It calls Gemini `gemini-3.6-flash` with the `google_search` grounding tool, sends the key only in `x-goog-api-key`, handles bounded retries/timeouts, and normalizes provider failures.
- `netlify/functions/lib/search-utils.mjs`: request validation, Gemini SSE parsing, `groundingMetadata` → normalized citations/sources conversion, unsafe-URL rejection, and a per-instance rate limiter.
- `sw.js`: PWA app-shell caching. API requests (`/.netlify/functions/*`) are always network-only and never cached. The static cache version is deliberate; increment it only when an app-shell asset changes.

The app has no API key, `.env` file, or Gemini request in any frontend code.

## Required Netlify configuration

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create an API key for a project allowed to use `gemini-3.6-flash` with Google Search grounding. Availability, quota, and billing depend on the Google project, account, and region.
2. In Netlify, open **Project configuration → Environment variables → Add a variable**.
3. Add `GEMINI_API_KEY` with the key from step 1.
4. Select **Production**, **Deploy Previews**, and **Branch deploys** as scopes.
5. Save, then open **Deploys → Trigger deploy → Deploy site**.

Never put the key in GitHub, `index.html`, `app.js`, or an `.env` file committed to the repository. Use `.env.example` as a template for local development with the Netlify CLI.

## How Gemini grounding maps to citations

Gemini returns `groundingMetadata` on the final SSE chunk:

```
groundingChunks[i].web  →  { uri, title }   (source URLs)
groundingSupports[j]    →  { segment: { startIndex, endIndex },
                              groundingChunkIndices: [i, …] }
```

The function converts this to the annotation shape that `app.js` already understands:

```
{ url, title, start_index, end_index }
```

`app.js` uses these offsets to wrap the cited spans in `<a class="citation">` links, and renders a deduplicated source list below the answer. No frontend changes were needed.

## Rate limits and abuse protection

The function's in-process rate limiter is set to 8 requests per IP per 60-second window. It is a useful first layer but serverless instances do not share memory, so it is not a global limit. The handler forwards an upstream `Retry-After` response when Gemini is busy, retries only one transient upstream/network failure, and imposes both per-attempt and overall request timeouts.

Before making the site public, create a Netlify security/WAF request-rate rule for `/.netlify/functions/search` to protect against budget exhaustion from concurrent users across multiple serverless instances.

## Public-launch safeguards

The function validates same-origin browser requests, enforces body size and query length limits, rejects unsafe source URLs, and forwards upstream `429 Retry-After` instructions to the browser. The `GEMINI_API_KEY` is read only from the server-side environment, is never put into a URL, and is never present in a response or log. Netlify security headers add CSP, frame denial, HSTS, referrer restrictions, and browser permission restrictions.

## Local development

Install the [Netlify CLI](https://docs.netlify.com/cli/get-started/), then:

```sh
cp .env.example .env
# add your GEMINI_API_KEY to .env
netlify dev
```

## Development checks

The project uses Node 22, pinned in both `.nvmrc` and `netlify.toml`. It has no third-party runtime dependencies.

```sh
npm run check   # syntax-checks all JS files
npm test        # runs the unit test suite
```

The tests cover citation mapping and unsafe URL rejection, fragmented/malformed SSE, Gemini request shape, provider responses (401 / 403 / 404 / 429 / 5xx), transient retry behavior, timeout/cancellation, missing environment variables, request validation/rate limiting, and the full browser-facing SSE contract. A real end-to-end search can only be tested after `GEMINI_API_KEY` is configured in Netlify or `.env`.
