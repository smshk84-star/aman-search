# AMAN Search

AMAN Search is a static PWA with a secure Netlify Function that calls the OpenAI Responses API and its `web_search` tool. The existing AMAN interface is retained; answers stream into the page, then show linked citations and a source list.

## Architecture

- `index.html` and `app.js`: the existing AMAN interface and streaming search client.
- `netlify/functions/search.mjs`: server-only Responses API proxy. It is the only file that reads `OPENAI_API_KEY`.
- `netlify/functions/lib/search-utils.mjs`: request validation, response/source parsing, and a per-instance rate limiter.
- `sw.js`: PWA app-shell caching. API requests are always network-only and never cached.

The app deliberately has no API key, `.env` file, or OpenAI request in frontend code.

## Required Netlify configuration

1. In Netlify, open **Project configuration → Environment variables → Add a variable**.
2. Add `OPENAI_API_KEY` with an OpenAI API key that has billing and access to `gpt-5.6-terra` plus web search.
3. Select **Production**, **Deploy Previews**, and **Branch deploys** as scopes.
4. Save, then open **Deploys → Trigger deploy → Deploy site**.

Never put the key in GitHub, `index.html`, `app.js`, or an `.env` file committed to the repository.

## Public-launch safeguards

The function validates same-origin browser requests, limits a runtime instance to 8 searches per IP per minute, rejects oversize bodies, and forwards upstream `429` retry instructions. Serverless instances do not share memory, so this is not a substitute for an edge-level limit.

Before making the site public, create a Netlify security/WAF request-rate rule for `/.netlify/functions/search`. Choose a limit suitable for the available OpenAI budget. Also verify that the Netlify site visibility is public if people should be able to open the app without a Netlify login.

## Development checks

The project uses Node 22, pinned in both `.nvmrc` and `netlify.toml`. It has no third-party runtime dependencies.

```sh
npm run check
npm test
```

The tests cover source/citation handling, upstream SSE parsing, local rate limiting, request validation, the streamed Responses API request shape, and upstream rate-limit errors. A real end-to-end search can only be tested after `OPENAI_API_KEY` is configured in Netlify.
