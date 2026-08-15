# AMAN Search

AMAN Search is a static PWA with a secure Netlify Function that calls the Google Gemini API (`gemini-3.6-flash`) with Google Search grounding. The existing AMAN interface is retained; answers stream into the page, then show linked citations and a source list derived from Gemini's `groundingMetadata`.

## Architecture

- `index.html` and `app.js`: the existing AMAN interface and streaming search client. Unchanged.
- `netlify/functions/search.mjs`: server-only Gemini API proxy. It is the only file that reads `GEMINI_API_KEY`. Calls `streamGenerateContent` with the `google_search` grounding tool and streams `delta`, `sources`, and `done` SSE events to the browser.
- `netlify/functions/lib/search-utils.mjs`: request validation, Gemini SSE parsing, `groundingMetadata` → citations/sources conversion, and a per-instance rate limiter.
- `sw.js`: PWA app-shell caching. API requests (`/.netlify/functions/*`) are always network-only and never cached.

The app has no API key, `.env` file, or Gemini request in any frontend code.

## Required Netlify configuration

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create an API key. The free tier requires no billing information and includes Google Search grounding for `gemini-3.6-flash`.
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

## Free-tier limits (gemini-3.6-flash, Google AI Studio)

| Dimension | Free-tier limit |
|-----------|----------------|
| Requests per minute (RPM) | 10 |
| Requests per day (RPD) | 250 |
| Tokens per minute (TPM) | 250,000 |
| Google Search grounding | Included |

The Netlify function's in-process rate limiter is set to 8 requests per IP per 60-second window, which keeps individual users well within the upstream RPM limit. Because serverless instances do not share memory, this is not a substitute for an edge-level limit on high-traffic deployments.

Before making the site public, create a Netlify security/WAF request-rate rule for `/.netlify/functions/search` to protect against budget exhaustion from concurrent users across multiple serverless instances.

## Public-launch safeguards

The function validates same-origin browser requests, enforces body size and query length limits, and forwards upstream `429 Retry-After` instructions to the browser. The `GEMINI_API_KEY` is read only from the server-side environment and is never present in any response or log.

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

The tests cover `extractGeminiAnswer` (citation mapping, unsafe URL rejection), `parseGeminiSse` (fragmented stream handling), `uniqueSources`, the rate limiter, request validation (405 / 403 / 503), the full Gemini streaming proxy round-trip (verifying upstream request shape, SSE event sequence, and citation data), upstream 429 passthrough, and the no-`finishReason` fallback path. A real end-to-end search can only be tested after `GEMINI_API_KEY` is configured in Netlify or `.env`.
