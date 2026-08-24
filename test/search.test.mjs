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

const duckHtml = `
<div class="result results_links results_links_deep">
  <h2 class="result__title"><a class="result__a" href="https://example.com/one">Example One</a></h2>
  <a class="result__snippet">First useful result for the query.</a>
</div>
<div class="result results_links results_links_deep">
  <h2 class="result__title"><a class="result__a" href="https://example.com/two">Example Two</a></h2>
  <a class="result__snippet">Second useful result.</a>
</div>`;

const bingHtml = `<li class="b_algo"><h2><a href="https://example.com/three">Example Three</a></h2><p>Third useful result.</p></li>`;

const fakeFetch = async (url) => new Response(url.includes("duckduckgo") ? duckHtml : bingHtml, {
  status: 200,
  headers: { "Content-Type": "text/html" },
});

test("no-key search returns public web results without credentials", async () => {
  const result = await searchWithoutApiKey("test query", { fetchImpl: fakeFetch });
  assert.ok(result.answer.includes("First useful result"));
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0].url, "https://example.com/one");
  assert.equal(result.sources[2].title, "Example Three");
});

test("no-key search deduplicates identical URLs", async () => {
  const html = `${duckHtml.replace("example.com/two", "example.com/one")}\n${bingHtml}`;
  const result = await searchWithoutApiKey("test query", {
    fetchImpl: async () => new Response(html, { status: 200 }),
  });
  assert.equal(new Set(result.sources.map((source) => source.url)).size, result.sources.length);
});

test("search handler rejects invalid methods, foreign origins, and never checks an API key", async () => {
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
  assert.deepEqual(events.map((event) => event.event), ["delta", "sources", "done"]);
  assert.equal(events[1].data.sources.length, 3);
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
