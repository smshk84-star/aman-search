# Providers

## Search gateway

`createSearchGateway` selects a configured provider, opens a request, and exposes normalized streaming events to the Netlify handler. The active Gemini adapter sends Google Search-grounded requests and maps sources/citations to the existing browser SSE contract.

`SEARCH_PROVIDER` may be `gemini` or `mock`; `SEARCH_FALLBACK_PROVIDER` is optional. Mock is allowed only outside production and its output is explicitly marked as development mock output.

## AI gateway

`createAiGateway` follows the same pattern for chat. `AI_PROVIDER` may be `gemini` or `mock`; `AI_MODEL` optionally selects a Gemini model; `AI_FALLBACK_PROVIDER` is optional.

## Credentials

`GEMINI_API_KEY` is read only by Netlify Functions. Do not place it in HTML, browser JavaScript, URLs, or Git. Missing credentials result in either local development mock mode or an honest production configuration error.

## Adding a provider

Create an adapter with `id`, `isConfigured()`, `open(request, options)`, and `events(body)`. Keep vendor request/response mapping inside that adapter, then register it in the relevant configured gateway.
