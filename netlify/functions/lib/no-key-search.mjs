const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS_PER_ENGINE = 8;
const USER_AGENT = "AMAN-Search/2.1";

const decodeHtml = (value = "") => value
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
  .replace(/&#x2F;/gi, "/").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

const stripTags = (value = "") => decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
};

const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }

const extractDuckDuckGo = (html) => {
  const results = [];
  const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && results.length < MAX_RESULTS_PER_ENGINE) {
    const url = safeUrl(decodeHtml(match[1]));
    if (!url) continue;
    const tail = html.slice(match.index, match.index + 4_000);
    const snippet = tail.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "";
    results.push({ title: stripTags(match[2]), url, snippet: stripTags(snippet), domain: domainOf(url), engine: "DuckDuckGo" });
  }
  return results;
};

const extractBing = (html) => {
  const results = [];
  const pattern = /<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = pattern.exec(html)) && results.length < MAX_RESULTS_PER_ENGINE) {
    const block = match[1];
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = safeUrl(decodeHtml(link[1]));
    if (!url) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    results.push({ title: stripTags(link[2]), url, snippet: stripTags(snippet), domain: domainOf(url), engine: "Bing" });
  }
  return results;
};

const fetchText = async (url, fetchImpl, signal) => {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`Search source returned HTTP ${response.status}.`);
  return response.text();
};

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const rank = (items, query) => {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1);
  return items.map((item, index) => {
    const haystack = `${item.title} ${item.snippet} ${item.domain}`.toLowerCase();
    const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
    const titleBoost = terms.reduce((score, term) => score + (item.title.toLowerCase().includes(term) ? 2 : 0), 0);
    return { ...item, _score: matches + titleBoost + Math.max(0, 1 - index / 20) };
  }).sort((a, b) => b._score - a._score).map(({ _score, ...item }) => item);
};

const buildEvidenceAnswer = (query, sources) => {
  const usable = sources.filter((source) => source.snippet).slice(0, 5);
  if (!usable.length) return `I found ${sources.length} live web results for “${query}”. The available sources did not provide enough indexed text for a reliable synthesis.`;
  const intro = `I found ${sources.length} live web results for “${query}”. Here are the most relevant findings from the retrieved sources:`;
  const findings = usable.map((source, index) => `${index + 1}. ${source.snippet} [${index + 1}]`).join("\n");
  return `${intro}\n\n${findings}\n\nThis is an evidence-based synthesis of the retrieved search snippets, not a generated answer from a private AI model.`;
};

export const searchWithoutApiKey = async (query, { fetchImpl = fetch, timeoutMs = SEARCH_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const encoded = encodeURIComponent(query);
  const engines = [
    { url: `https://html.duckduckgo.com/html/?q=${encoded}`, parser: extractDuckDuckGo },
    { url: `https://www.bing.com/search?q=${encoded}&count=8`, parser: extractBing },
  ];
  try {
    const settled = await Promise.allSettled(engines.map(async ({ url, parser }) => parser(await fetchText(url, fetchImpl, controller.signal))));
    const raw = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const ranked = rank(dedupe(raw), query);
    if (!ranked.length) throw new Error("No public search source returned results.");
    const sources = ranked.map((item, index) => ({ id: `s${index + 1}`, title: item.title, url: item.url, domain: item.domain, snippet: item.snippet, retrievedAt: new Date().toISOString() }));
    const citations = sources.slice(0, 5).map((source, index) => ({ sourceId: source.id, url: source.url, title: source.title, startIndex: 0, endIndex: 0, marker: `[${index + 1}]` }));
    return { answer: buildEvidenceAnswer(query, sources), citations, sources };
  } finally { clearTimeout(timer); }
};
