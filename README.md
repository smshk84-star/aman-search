# AMAN Search

AMAN Search is a PWA search assistant with a server-side public-web search adapter. The core search path does not require Gemini, OpenAI, Tavily, or any manually configured provider API key.

## Architecture

- `index.html` and `app.js`: existing AMAN interface, cancellation, streaming client, safe source links and citation mapping.
- `netlify/functions/search.mjs`: server-only search endpoint with validation, rate limiting, timeout/error handling and SSE.
- `netlify/functions/lib/no-key-search.mjs`: public web search adapter, result normalization, deduplication, relevance ranking, source contract and evidence-based synthesis.
- `netlify/functions/lib/search-utils.mjs`: request/source utilities and rate limiter.
- `sw.js`: PWA app-shell caching. Search requests remain network-only.

## Provider independence

The active search path uses public, browser-accessible search-result pages through the server-side adapter. It does not require a private API credential and does not bypass authentication, CAPTCHAs, paywalls, robots restrictions, or private/internal APIs.

The answer engine is intentionally honest: when no actual generative model is configured, AMAN Search presents an evidence-based synthesis of retrieved snippets rather than claiming that a language model generated the answer.

## Result contract

```json
{
  "id": "s1",
  "title": "Example",
  "url": "https://example.com/article",
  "domain": "example.com",
  "snippet": "Retrieved public result text.",
  "retrievedAt": "2026-08-25T00:00:00.000Z"
}
```

## Answer contract

```json
{
  "answer": "Evidence-based answer with [1] citations.",
  "citations": [{ "sourceId": "s1", "url": "https://example.com/article", "title": "Example", "startIndex": 0, "endIndex": 0 }],
  "sources": []
}
```

## SSE contract

The frontend consumes the existing events: `delta`, `sources`, `done`, and `error`.

## Security

Same-origin validation, query-size validation, per-instance rate limiting, timeout handling, HTTP/HTTPS source validation, no credential exposure, no private endpoint access and no provider credentials in frontend code.

## Development checks

Node 22 is pinned in `.nvmrc` and `netlify.toml`.

```sh
npm run check
npm test
```

For a live deployment, Netlify must be connected to this repository and publish the repository root with `netlify/functions` as the functions directory. No provider API-key environment variable is required for the core search path.
