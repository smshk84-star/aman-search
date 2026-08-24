import assert from "node:assert/strict";
import test from "node:test";
import { createSearchHandler } from "../netlify/functions/search.mjs";
import { searchWithoutApiKey } from "../netlify/functions/lib/no-key-search.mjs";
import { createRateLimiter } from "../netlify/functions/lib/search-utils.mjs";

const requestFor = (body, headers = {}) => new Request("https://aman-search.example/.netlify/functions/search", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://aman-search.example", ...headers },
  body: JSON.stringify(body),
});

const allow = () => ({ allowed: true, limit: 20, remaining: 19, retryAfter: 60 });
const readEvents = (text) => text.trim().split(/\n\n+/).map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || "{}"),
}));

const duckHtml = `<div class="result"><h2><a class="result__a" href="https://example.com/one">Example One</a></h2><a class="result__snippet">First useful result for the query.</a></div><div class="result"><h2><a class="result__a" href="https://example.com/two">Example Two</a></h2><a class="result__snippet">Second useful result.</a></div>`;
const bingHtml = `<li class="b_algo"><h2><a href="https://example.com/three">Example Three</a></h2><p>Third useful result.</p></li>`;
const fakeFetch = async (url) => new Response(url.includes("duckduckgo") ? duckHtml : bingHtml, { status: 200, headers: { "Content-Type": "text/html" } });

test("no-key search returns normalized ranked results and an evidence answer", async () => {
  const result = await searchWithoutApiKey("test query", { fetchImpl: fakeFetch });
  assert.ok(result.answer.includes("First useful result"));
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0].id, "s1");
  assert.equal(result.sources[0].url, "https://example.com/one");
  assert.equal(result.sources[0].domain, "example.com");
  assert.match(result.sources[0].retrievedAt, /^20/);
  assert.equal(result.citations.length, 3);
  assert.equal(result.citations[0].sourceId, "s1");
});

test("no-key search deduplicates identical URLs", async () => {
  const html = `${duckHtml.replace("example.com/two", "example.com/one")}\n${bingHtml}`;
  const result = await searchWithoutApiKey("test query", { fetchImpl: async () => new Response(html, { status: 200 }) });
  assert.equal(new Set(result.sources.map((source) => source.url)).size, result.sources.length);
});

test("unsafe URLs are discarded", async () => {
  const html = `<a class="result__a" href="javascript:alert(1)">Bad</a><a class="result__a" href="https://safe.example/a">Safe</a><a class="result__snippet">Safe result</a>`;
  const result = await searchWithoutApiKey("safe", { fetchImpl: async () => new Response(html, { status: 200 }) });
  assert.equal(result.sources.every((source) => /^https?:$/.test(new URL(source.url).protocol)), true);
});

test("empty public results produce a controlled failure", async () => {
  await assert.rejects(() => searchWithoutApiKey("nothing", { fetchImpl: async () => new Response("", { status: 200 }) }), /No public search source returned results/);
});

test("search handler preserves SSE contract and never checks an API key", async () => {
  const handler = createSearchHandler({ fetchImpl: fakeFetch, limiter: allow });
  const method = await handler(new Request("https://aman-search.example/.netlify/functions/search"));
  assert.equal(method.status, 405);

  const foreign = await handler(new Request("https://aman-search.example/.netlify/functions/search", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: "{}",
  }));
  assert.equal(foreign.status, 403);

  const response = await handler(requestFor({ query: "latest news" }));
  assert.equal(response.status, 200);
  const events = readEvents(await response.text());
  assert.equal(events[events.length - 2].event, "sources");
  assert.equal(events.at(-1).event, "done");
  assert.ok(events.slice(0, -2).every((event) => event.event === "delta"));
  assert.equal(events[events.length - 2].data.sources.length, 3);
  assert.equal(events[events.length - 2].data.citations[0].sourceId, "s1");
});

test("rate limiter rejects the request after its configured limit", () => {
  let time = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => time });
  assert.equal(limit("ip").allowed, true);
  assert.equal(limit("ip").allowed, true);
  assert.equal(limit("ip").allowed, false);
  time = 1_001;
  assert.equal(limit("ip").allowed, true);
});

test("search handler validates query size", async () => {
  const handler = createSearchHandler({ fetchImpl: fakeFetch, limiter: allow });
  const response = await handler(requestFor({ query: "x".repeat(1001) }));
  assert.equal(response.status, 400);
});
