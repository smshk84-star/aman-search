# AMAN OS

AMAN OS is a personal, browser-local workspace built on the original AMAN Search application. It keeps source-backed web search as a first-class capability and adds a command center, AI chat, projects, conversations, tasks, safe local file storage, and deterministic agent routing.

## What works

- Source-backed search through a server-only provider gateway. Answers stream to the browser with safe linked citations and source cards.
- Provider-neutral search and AI gateways with bounded provider fallback points.
- ChatGPT-style AI workspace with persistent conversation history, streaming responses, Markdown, code blocks with copy actions, regenerate, stop generation, edit-and-resend, conversation search, pin/rename/delete, export, theme preferences, and safe text attachments.
- Browser-local projects, messages, tasks, files, preferences, activity, and AgentRun records. Data persists across refreshes in the same browser profile.
- Command Center routing for search/research, tasks, files, and general AI requests.
- Dedicated web-search mode inside chat, with source cards and grounded citations when the provider is configured.
- Safe file upload boundary: supported document/image types only, filename sanitization, and a 1.5 MB browser-local limit.
- PWA app shell with a network-only policy for Netlify function requests.

## Important data boundary

This MVP is a single-user local workspace: project data is stored in the browser's `localStorage`, not in a cloud database. Clearing site storage or changing browser profiles removes that local workspace data. Do not use it for sensitive files.

## Providers and development mode

Production uses Gemini through server-side Netlify Functions. The browser never receives `GEMINI_API_KEY`.

- With `GEMINI_API_KEY` configured, search uses Google Search grounding and chat uses Gemini streaming.
- Without a key in local development, gateways use clearly labeled development mocks. They never claim to be live web results or real AI output.
- In production, a missing or invalid provider configuration returns an honest error rather than fabricated results.

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for adapter details.

## Local run

Use Node 22. Install the Netlify CLI, then run the app through Netlify so functions are available:

```sh
npm.cmd run check
npm.cmd test
netlify dev
```

For local real-provider testing, create a non-committed `.env` containing `GEMINI_API_KEY`. `.env.example` is safe to copy and contains no secret.

## Netlify deployment

1. In Netlify, open **Project configuration → Environment variables**.
2. Add `GEMINI_API_KEY` for Production (and deploy previews if wanted).
3. Deploy the branch that contains the AMAN OS changes.
4. Verify a search and an AI chat request; responses should stream from `/.netlify/functions/search` and `/.netlify/functions/ai`.

## Android / Play Store packaging

The existing web application is packaged with Capacitor; the Android bridge lives in `android/` and uses the same frontend and Netlify backend. It does not expose provider secrets.

Install Android Studio with an Android SDK and Java, then set the deployed API origin and sync:

```powershell
$env:AMAN_API_ORIGIN = "https://YOUR-NETLIFY-SITE.netlify.app"
npm.cmd run mobile:sync
npm.cmd run mobile:open
```

Build a release bundle from Android Studio or with `npm.cmd run mobile:build` after configuring a private upload keystore. Upload the resulting signed `.aab` to Google Play Console. Store listing, privacy policy, data safety declaration, screenshots, content rating, and developer account verification remain external Play Console requirements. See [mobile/README.md](mobile/README.md).

## Verification

```sh
npm.cmd run check
npm.cmd test
git diff --check
```

The automated suite covers provider error handling, retries, cancellation, SSE parsing, citations, safe URLs, gateway fallback, AI SSE output, Markdown safety, chat context limits, attachment validation, local persistence, conversation operations, safe file validation, task storage, and agent routing.

## Documentation

- [Baseline](docs/AMAN_SEARCH_BASELINE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Providers](docs/PROVIDERS.md)
- [Security](docs/SECURITY.md)
- [Changelog](CHANGELOG.md)
