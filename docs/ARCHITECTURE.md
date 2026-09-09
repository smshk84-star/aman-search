# AMAN OS architecture

```text
Browser UI
  ├─ Command Center / Projects / Tasks / Files / Agents
  ├─ browser-local workspace store
  ├─ Search UI ────────────────> /.netlify/functions/search
  └─ AI Chat ──────────────────> /.netlify/functions/ai
                                      │
                              Provider gateways
                              ├─ Gemini Search grounding adapter
                              ├─ Gemini AI chat adapter
                              └─ development mock adapters
                                      │
                                Gemini API (server only)
```

## Boundaries

- `lib/os/`: browser-local workspace state, safe file validation, and deterministic agent orchestration. It contains no provider credential or server secret.
- `netlify/functions/search.mjs`: request validation/rate limit/SSE boundary for live web search.
- `netlify/functions/ai.mjs`: request validation/rate limit/SSE boundary for AI chat.
- `netlify/functions/lib/*gateway.mjs`: provider selection and fallback boundary.
- Provider adapters are isolated from frontend and workspace business logic.

## Persistence

The MVP uses browser `localStorage` under a versioned AMAN OS key. This intentionally avoids pretending there is multi-user server persistence. A future server-backed workspace can replace this store behind the same UI actions.
