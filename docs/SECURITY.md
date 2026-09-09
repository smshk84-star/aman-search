# Security model

- Provider secrets stay server-side in Netlify environment variables; no frontend module reads a secret.
- Search and AI handlers validate same-origin requests, JSON shape, payload sizes, message/query limits, and per-instance rate limits.
- Provider failures are normalized; upstream diagnostics and credentials are not surfaced to the browser.
- Only `http` and `https` source URLs render as links. Browser text is escaped before rendering.
- File uploads are browser-local only, use a type/extension allowlist, sanitize names, reject oversized data, and are never executed.
- The MVP is single-user browser storage. It has no authentication or multi-user authorization layer, so it must not be used for shared/private cloud data.
- Agents have deterministic, bounded actions. They do not execute shell commands, browse private services, or perform destructive operations.
