// Local development server: serves the repository root and runs the Netlify
// function handlers in-process, so chat/search work without the Netlify CLI.
// Usage: npm run dev  (optionally set AI_PROVIDER / OLLAMA_* / GEMINI_API_KEY first)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT || 8888);
const aiHandler = (await import(pathToFileURL(join(ROOT, "netlify/functions/ai.mjs")))).default;
const searchHandler = (await import(pathToFileURL(join(ROOT, "netlify/functions/search.mjs")))).default;

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

const send = (response, status, body, headers = {}) => { response.writeHead(status, headers); response.end(body); };

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/.netlify/functions/")) {
      const handler = url.pathname.endsWith("/ai") ? aiHandler : url.pathname.endsWith("/search") ? searchHandler : null;
      if (!handler) return send(response, 404, "Not found");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
      const netlifyRequest = new Request(`${url.origin}${url.pathname}`, { method: request.method, headers, body: chunks.length && !["GET", "HEAD"].includes(request.method) ? Buffer.concat(chunks) : undefined });
      const netlifyResponse = await handler(netlifyRequest);
      response.writeHead(netlifyResponse.status, Object.fromEntries(netlifyResponse.headers));
      if (!netlifyResponse.body) return response.end();
      let end;
      const finished = new Promise((done) => { end = done; response.on("close", end); });
      for await (const chunk of netlifyResponse.body) { if (response.writableEnded || response.destroyed) break; response.write(chunk); }
      if (!response.writableEnded && !response.destroyed) response.end();
      await finished;
      return;
    }
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    if (path.includes("..")) return send(response, 400, "Bad path");
    const file = await readFile(join(ROOT, path));
    send(response, 200, file, { "Content-Type": MIME[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
  } catch (error) {
    if (error.code === "ENOENT") return send(response, 404, "Not found");
    send(response, 500, `Server error: ${error.message}`);
  }
});
server.listen(PORT, () => console.log(`AMAN dev server: http://localhost:${PORT} (root: ${ROOT})`));
