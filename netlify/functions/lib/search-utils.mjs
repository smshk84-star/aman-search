export const MAX_QUERY_LENGTH = 1000;
export const MAX_BODY_BYTES = 12_000;
export const REQUEST_TIMEOUT_MS = 55_000;

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

export const safeHostname = (url) => {
  try { return new URL(url).hostname; } catch { return "Source"; }
};

export const isSafeWebUrl = (url) => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch { return false; }
};

export const uniqueSources = (annotations = []) => {
  const seen = new Set();
  return annotations
    .map((item) => item?.url_citation || item)
    .filter((item) => item?.url && isSafeWebUrl(item.url) && !seen.has(item.url) && seen.add(item.url))
    .map(({ url, title }) => ({ url, title: title || safeHostname(url) }));
};

export const extractAnswer = (response) => {
  const content = response?.output
    ?.flatMap((item) => item.type === "message" ? item.content || [] : [])
    .find((item) => item.type === "output_text");
  const annotations = (content?.annotations || [])
    .map((item) => item?.url_citation || item)
    .filter((item) => (item?.type === "url_citation" || item?.url) && isSafeWebUrl(item?.url));
  return { answer: content?.text || "", annotations, sources: uniqueSources(annotations) };
};

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

export const publicApiError = (status, payload) => {
  if (status === 401 || status === 403) return "The AI search service is not configured correctly.";
  if (status === 429) return "Search is busy right now. Please wait a moment and try again.";
  if (status >= 500) return "The AI search service is temporarily unavailable. Please try again.";
  return payload?.error?.message || "The AI search request could not be completed.";
};

export async function* parseSse(body) {
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
