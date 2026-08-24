const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS_PER_ENGINE = 8;
const USER_AGENT = "AMAN-Search/2.0 (+https://aman-search.netlify.app)";

const decodeHtml = (value = "") => value
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&#x27;/gi, "'")
  .replace(/&#x2F;/gi, "/")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

const stripTags = (value = "") => decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

const extractDuckDuckGo = (html) => {
  const results = [];
  const blockPattern = /<div[^>]*class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match;

  while ((match = blockPattern.exec(html)) && results.length < MAX_RESULTS_PER_ENGINE) {
    const block = match[1];
    const link = block.match(/<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = safeUrl(decodeHtml(link[1]));
    if (!url) continue;
    const snippet = block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1];
    const title = stripTags(link[2]);
    const description = stripTags(snippet || "");
    results.push({ title, url, description, engine: "DuckDuckGo" });
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
    const description = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    results.push({ title: stripTags(link[2]), url, description: stripTags(description), engine: "Bing" });
  }
  return results;
};

const fetchText = async (url, fetchImpl, signal) => {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
    signal,
  });
  if (!response.ok) throw new Error(`Search source returned HTTP ${response.status}.`);
  return response.text();
};

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const searchWithoutApiKey = async (query, { fetchImpl = fetch, timeoutMs = SEARCH_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const encoded = encodeURIComponent(query);
  const sources = [
    { url: `https://html.duckduckgo.com/html/?q=${encoded}`, parser: extractDuckDuckGo },
    { url: `https://www.bing.com/search?q=${encoded}&count=8`, parser: extractBing },
  ];

  try {
    const settled = await Promise.allSettled(sources.map(async ({ url, parser }) => parser(await fetchText(url, fetchImpl, controller.signal))));
    const results = dedupe(settled.flatMap((result) => result.status === "fulfilled" ? result.value : []));
    if (!results.length) throw new Error("No public search source returned results.");

    const answer = results.slice(0, 5)
      .filter((result) => result.description)
      .map((result, index) => `${index + 1}. ${result.description}`)
      .join("\n\n");

    return {
      answer: answer || `Found ${results.length} web results for “${query}”.`,
      annotations: [],
      sources: results.map(({ title, url, description, engine }) => ({ title, url, description, engine })),
    };
  } finally {
    clearTimeout(timer);
  }
};
