// ─── Shared constants ────────────────────────────────────────────────────────

export const MAX_QUERY_LENGTH = 1000;
export const MAX_BODY_BYTES = 12_000;
export const REQUEST_TIMEOUT_MS = 55_000;

// ─── Generic HTTP helpers ─────────────────────────────────────────────────────

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  },
});

export const sse = (event, body) => `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;

// ─── URL safety helpers ───────────────────────────────────────────────────────

export const safeHostname = (url) => {
  try { return new URL(url).hostname; } catch { return "Source"; }
};

export const isSafeWebUrl = (url) => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch { return false; }
};

// ─── Source deduplication ─────────────────────────────────────────────────────

export const uniqueSources = (items = []) => {
  const seen = new Set();
  return items
    .filter((item) => item?.url && isSafeWebUrl(item.url) && !seen.has(item.url) && seen.add(item.url))
    .map(({ url, title }) => ({ url, title: title || safeHostname(url) }));
};

export const normalizeSources = (items = []) => uniqueSources(items).map((source, index) => ({
  id: `source-${index + 1}`,
  url: source.url,
  title: source.title,
  domain: safeHostname(source.url),
  snippet: "",
  retrieved_at: null,
}));

// ─── Gemini groundingMetadata → citations + sources ──────────────────────────
//
// Gemini SSE shape (final chunk):
//   candidates[0].groundingMetadata = {
//     groundingChunks: [{ web: { uri, title } }, …],
//     groundingSupports: [{
//       segment: { startIndex, endIndex },   // byte offsets into full answer text
//       groundingChunkIndices: [0, 1, …],
//     }, …],
//   }
//
// We map this to the annotation shape that app.js already understands:
//   { url, title, start_index, end_index }
//
// app.js uses start_index/end_index as character offsets, which matches the
// Gemini segment byte offsets for UTF-8 ASCII-range text. For non-ASCII the
// offsets may drift by a few characters, but citation links still appear at
// the nearest sentence boundary and remain functional.

export const extractGeminiAnswer = (chunks = [], supports = []) => {
  const sources = normalizeSources(
    chunks
      .map((chunk) => chunk?.web)
      .filter(Boolean)
      .map(({ uri, title }) => ({ url: uri, title })),
  );
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  // Build a flat annotations array (one entry per chunk reference per support).
  const annotations = [];
  for (const support of supports) {
    const { segment, groundingChunkIndices = [] } = support;
    if (!segment) continue;
    const startIndex = segment.startIndex ?? 0;
    const endIndex = segment.endIndex ?? 0;
    if (endIndex <= startIndex) continue;

    for (const chunkIdx of groundingChunkIndices) {
      const web = chunks[chunkIdx]?.web;
      if (!web?.uri || !isSafeWebUrl(web.uri)) continue;
      annotations.push({
        source_id: sourceByUrl.get(web.uri)?.id,
        url: web.uri,
        title: web.title || safeHostname(web.uri),
        start_index: startIndex,
        end_index: endIndex,
      });
    }
  }

  return { annotations, sources };
};

// ─── Gemini upstream SSE parser ───────────────────────────────────────────────
//
// The Gemini streamGenerateContent endpoint (with ?alt=sse) emits a plain
// text/event-stream where each event carries a GenerateContentResponse JSON
// object as its data field.  There is no custom event: line — all events use
// the implicit "message" type.  The stream ends with a [DONE] sentinel or
// simply closes.

export async function* parseGeminiSse(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseBlock = (block) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return null;
    try { return JSON.parse(data); } catch { return null; }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      const event = parseBlock(block);
      if (event) yield event;
    }
    if (done) break;
  }

  const lastEvent = parseBlock(buffer);
  if (lastEvent) yield lastEvent;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

export const createRateLimiter = ({ limit = 8, windowMs = 60_000, now = () => Date.now() } = {}) => {
  const hits = new Map();

  return (key) => {
    const timestamp = now();
    const entry = hits.get(key);
    const active = entry && entry.resetAt > timestamp ? entry : { count: 0, resetAt: timestamp + windowMs };
    active.count += 1;
    hits.set(key, active);

    if (hits.size > 500) {
      for (const [candidate, value] of hits) {
        if (value.resetAt <= timestamp) hits.delete(candidate);
      }
    }

    return {
      allowed: active.count <= limit,
      limit,
      remaining: Math.max(0, limit - active.count),
      retryAfter: Math.max(1, Math.ceil((active.resetAt - timestamp) / 1000)),
    };
  };
};

// ─── Request validation helpers ───────────────────────────────────────────────

export const clientKey = (request) => {
  const netlifyIp = request.headers.get("x-nf-client-connection-ip");
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return netlifyIp || forwarded || "anonymous";
};

export const hasAllowedOrigin = (request) => {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return origin === new URL(request.url).origin; } catch { return false; }
};

// ─── Upstream error mapping ───────────────────────────────────────────────────

export const publicApiError = (status, payload) => {
  if (status === 400) return "The search request was invalid.";
  if (status === 401 || status === 403) return "The AI search service is not configured correctly.";
  if (status === 404) return "The requested AI search capability is unavailable.";
  if (status === 429) return "Search is busy right now. Please wait a moment and try again.";
  if (status >= 500) return "The AI search service is temporarily unavailable. Please try again.";
  return "The AI search request could not be completed.";
};
