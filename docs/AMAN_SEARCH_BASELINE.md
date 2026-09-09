# AMAN Search baseline

Recorded before the AMAN OS MVP migration on the `gemini-free` branch.

## Runtime and deployment

- Static HTML/CSS/JavaScript PWA; no frontend framework or runtime dependencies.
- Node.js 22 is required (`.nvmrc`, `package.json`, and `netlify.toml`).
- Netlify publishes the repository root and serves functions from `netlify/functions`.
- The service worker caches only the app shell. Netlify function requests are network-only.

## Existing search flow

`app.js` posts a query to `/.netlify/functions/search`. The Netlify function validates the request and forwards it to the server-side Gemini grounding provider. Provider output is translated to `delta`, `sources`, `done`, and `error` SSE events. The browser streams the answer, renders safe inline citations, and displays a deduplicated source list.

The active provider implementation is `netlify/functions/lib/gemini-provider.mjs`. It uses `GEMINI_API_KEY` only on the server, has bounded retries/timeouts, and converts Gemini grounding metadata into source/citation data through `search-utils.mjs`.

## Existing safeguards

- Same-origin guard, request/query-size limits, per-instance IP rate limit, cancellation, and timeout.
- HTTP-only/HTTPS-only source URLs and escaped frontend rendering.
- CSP, HSTS, frame denial, referrer, permission, and cross-origin response headers through Netlify.
- API credentials are not stored in frontend assets or tracked environment files.

## Existing validation

Before AMAN OS changes:

```sh
npm.cmd run check
npm.cmd test
```

Both commands passed. The existing suite had 19 tests covering the grounding provider, fragmented/malformed SSE, citation mapping, unsafe URLs, rate limits, upstream failure mapping, retries, timeout/cancellation, and the browser SSE contract.

## Known external dependency

A real production search needs `GEMINI_API_KEY` configured in Netlify. The repository intentionally contains no credential. Without it, the server returns an honest configuration error instead of fabricating web-search data.
