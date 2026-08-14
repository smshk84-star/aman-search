import assert from "node:assert/strict";
import test from "node:test";
import { createSearchHandler } from "../netlify/functions/search.mjs";
import { createRateLimiter, extractAnswer, parseSse, uniqueSources } from "../netlify/functions/lib/search-utils.mjs";

const requestFor = (body, headers = {}) => new Request("https://aman-search.example/.netlify/functions/search", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://aman-search.example", ...headers },
  body: JSON.stringify(body),
});

const allow = () => ({ allowed: true, limit: 8, remaining: 7, retryAfter: 60 });
const readEvents = (text) => text.trim().split(/\n\n+/).map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || "{}"),
}));

test("extractAnswer returns citations and deduplicated sources", () => {
  const response = {
    output: [{ type: "message", content: [{
      type: "output_text",
      text: "Answer [1] [2]",
      annotations: [
        { type: "url_citation", url: "https://example.com/a", title: "Example", start_index: 7, end_index: 10 },
        { type: "url_citation", url: "https://example.com/a", title: "Example", start_index: 11, end_index: 14 },
      ],
    }] }],
  };
  const result = extractAnswer(response);
  assert.equal(result.answer, "Answer [1] [2]");
  assert.equal(result.annotations.length, 2);
  assert.deepEqual(result.sources, [{ url: "https://example.com/a", title: "Example" }]);
  assert.deepEqual(uniqueSources([{ url: "https://example.com/b" }]), [{ url: "https://example.com/b", title: "example.com" }]);
  assert.deepEqual(uniqueSources([{ url: "javascript:alert(1)" }]), []);
});

test("parseSse reads fragmented upstream server-sent events", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"lo"}\n\n'));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events.map((event) => event.delta), ["Hel", "lo"]);
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

test("search handler rejects invalid methods, foreign origins, and missing configuration", async () => {
  const handler = createSearchHandler({ getApiKey: () => "", limiter: allow });
  const method = await handler(new Request("https://aman-search.example/.netlify/functions/search"));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  const foreign = await handler(new Request("https://aman-search.example/.netlify/functions/search", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: "{}",
  }));
  assert.equal(foreign.status, 403);

  const missingKey = await handler(requestFor({ query: "latest news" }));
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).code, "missing_api_key");
});

test("search handler proxies Responses streaming output and final citations", async () => {
  let upstreamRequest;
  const upstreamEvents = [
    { type: "response.output_text.delta", delta: "Hello " },
    {
      type: "response.completed",
      response: {
        output: [{ type: "message", content: [{
          type: "output_text",
          text: "Hello world[1]",
          annotations: [{ type: "url_citation", url: "https://example.com/world", title: "World source", start_index: 11, end_index: 14 }],
        }] }],
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const handler = createSearchHandler({
    getApiKey: () => "test-key",
    limiter: allow,
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(upstreamEvents, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const response = await handler(requestFor({ query: "What is new?" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const body = await response.text();
  const events = readEvents(body);
  assert.deepEqual(events.map((event) => event.event), ["delta", "sources", "done"]);
  assert.equal(events[1].data.answer, "Hello world[1]");
  assert.deepEqual(events[1].data.sources, [{ url: "https://example.com/world", title: "World source" }]);

  const payload = JSON.parse(upstreamRequest.options.body);
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/responses");
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer test-key");
  assert.equal(payload.model, "gpt-5.6-terra");
  assert.equal(payload.stream, true);
  assert.equal(payload.tool_choice, "required");
  assert.deepEqual(payload.tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.equal(payload.input, "What is new?");
});

test("search handler preserves useful upstream rate-limit errors", async () => {
  const handler = createSearchHandler({
    getApiKey: () => "test-key",
    limiter: allow,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "12" },
    }),
  });
  const response = await handler(requestFor({ query: "news" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal((await response.json()).error, "Search is busy right now. Please wait a moment and try again.");
});
