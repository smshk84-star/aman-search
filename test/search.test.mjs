import assert from "node:assert/strict";
import test from "node:test";
import { createSearchHandler } from "../netlify/functions/search.mjs";
import {
  createRateLimiter,
  extractGeminiAnswer,
  parseGeminiSse,
  uniqueSources,
} from "../netlify/functions/lib/search-utils.mjs";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const requestFor = (body, headers = {}) =>
  new Request("https://aman-search.example/.netlify/functions/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://aman-search.example",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const allow = () => ({ allowed: true, limit: 8, remaining: 7, retryAfter: 60 });

// Parse the raw SSE text emitted by the Netlify function into event objects.
const readEvents = (text) =>
  text
    .trim()
    .split(/\n\n+/)
    .map((block) => ({
      event: block.match(/^event:\s*(.+)$/m)?.[1],
      data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || "{}"),
    }));

// ─── extractGeminiAnswer ──────────────────────────────────────────────────────

test("extractGeminiAnswer maps groundingChunks + groundingSupports to annotations and deduplicated sources", () => {
  const chunks = [
    { web: { uri: "https://example.com/a", title: "Example A" } },
    { web: { uri: "https://example.com/b", title: "Example B" } },
    { web: { uri: "https://example.com/a", title: "Example A dup" } }, // duplicate URL
  ];
  const supports = [
    {
      segment: { startIndex: 0, endIndex: 12 },
      groundingChunkIndices: [0, 1],
    },
    {
      segment: { startIndex: 13, endIndex: 25 },
      groundingChunkIndices: [1],
    },
  ];

  const { annotations, sources } = extractGeminiAnswer(chunks, supports);

  // Two supports × references → 3 annotation entries total (first support has 2 chunk refs).
  assert.equal(annotations.length, 3);
  assert.equal(annotations[0].url, "https://example.com/a");
  assert.equal(annotations[0].start_index, 0);
  assert.equal(annotations[0].end_index, 12);
  assert.equal(annotations[1].url, "https://example.com/b");
  assert.equal(annotations[2].url, "https://example.com/b");
  assert.equal(annotations[2].start_index, 13);
  assert.equal(annotations[2].end_index, 25);

  // Sources are deduplicated: a, b  (third chunk is duplicate of a).
  assert.deepEqual(sources, [
    { url: "https://example.com/a", title: "Example A" },
    { url: "https://example.com/b", title: "Example B" },
  ]);
});

test("extractGeminiAnswer skips unsafe URLs and zero-length segments", () => {
  const chunks = [
    { web: { uri: "javascript:alert(1)", title: "Bad" } },
    { web: { uri: "https://safe.example/", title: "Safe" } },
  ];
  const supports = [
    { segment: { startIndex: 0, endIndex: 0 }, groundingChunkIndices: [0] }, // zero-length → skip
    { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] }, // unsafe URL → skip
    { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [1] }, // ok
  ];

  const { annotations, sources } = extractGeminiAnswer(chunks, supports);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].url, "https://safe.example/");
  assert.deepEqual(sources, [{ url: "https://safe.example/", title: "Safe" }]);
});

test("extractGeminiAnswer returns empty arrays when called with no grounding data", () => {
  const { annotations, sources } = extractGeminiAnswer([], []);
  assert.deepEqual(annotations, []);
  assert.deepEqual(sources, []);
});

// ─── uniqueSources ────────────────────────────────────────────────────────────

test("uniqueSources deduplicates by URL and rejects unsafe schemes", () => {
  assert.deepEqual(
    uniqueSources([{ url: "https://example.com/b" }]),
    [{ url: "https://example.com/b", title: "example.com" }],
  );
  assert.deepEqual(uniqueSources([{ url: "javascript:alert(1)" }]), []);
  assert.deepEqual(
    uniqueSources([
      { url: "https://x.com/", title: "X" },
      { url: "https://x.com/", title: "X again" },
    ]),
    [{ url: "https://x.com/", title: "X" }],
  );
});

// ─── parseGeminiSse ───────────────────────────────────────────────────────────

test("parseGeminiSse reads fragmented upstream Gemini SSE chunks", async () => {
  const encoder = new TextEncoder();
  const chunk1 = { candidates: [{ content: { parts: [{ text: "Hel" }] } }] };
  const chunk2 = { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }] };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseGeminiSse(stream)) events.push(event);

  assert.equal(events.length, 2);
  assert.equal(events[0].candidates[0].content.parts[0].text, "Hel");
  assert.equal(events[1].candidates[0].finishReason, "STOP");
});

test("parseGeminiSse ignores [DONE] sentinel and malformed lines", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\ndata: not-json\n\n"));
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseGeminiSse(stream)) events.push(event);
  assert.equal(events.length, 0);
});

// ─── Rate limiter ─────────────────────────────────────────────────────────────

test("rate limiter rejects the request after its configured limit", () => {
  let time = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => time });
  assert.equal(limit("ip").allowed, true);
  assert.equal(limit("ip").allowed, true);
  assert.equal(limit("ip").allowed, false);
  time = 1_001;
  assert.equal(limit("ip").allowed, true);
});

// ─── Request validation ───────────────────────────────────────────────────────

test("search handler rejects invalid methods, foreign origins, and missing configuration", async () => {
  const handler = createSearchHandler({ getApiKey: () => "", limiter: allow });

  // Wrong method
  const method = await handler(
    new Request("https://aman-search.example/.netlify/functions/search"),
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  // Cross-origin request
  const foreign = await handler(
    new Request("https://aman-search.example/.netlify/functions/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: "{}",
    }),
  );
  assert.equal(foreign.status, 403);

  // Missing API key → 503 with code
  const missingKey = await handler(requestFor({ query: "latest news" }));
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).code, "missing_api_key");
});

// ─── Gemini streaming proxy ───────────────────────────────────────────────────

test("search handler proxies Gemini SSE output and emits delta / sources / done events", async () => {
  let capturedRequest;

  // Simulate two Gemini SSE chunks: a delta chunk then a final chunk with
  // groundingMetadata.
  const deltaChunk = {
    candidates: [{
      content: { parts: [{ text: "Hello " }] },
    }],
  };
  const finalChunk = {
    candidates: [{
      content: { parts: [{ text: "world." }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/world", title: "World source" } },
        ],
        groundingSupports: [
          {
            segment: { startIndex: 0, endIndex: 6 },
            groundingChunkIndices: [0],
          },
        ],
      },
    }],
  };

  const upstreamSse = [
    `data: ${JSON.stringify(deltaChunk)}\n\n`,
    `data: ${JSON.stringify(finalChunk)}\n\n`,
  ].join("");

  const handler = createSearchHandler({
    getApiKey: () => "test-gemini-key",
    limiter: allow,
    fetchImpl: async (url, options) => {
      capturedRequest = { url, options };
      return new Response(upstreamSse, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const response = await handler(requestFor({ query: "What is new?" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const body = await response.text();
  const events = readEvents(body);

  // Should have: delta (from first chunk), delta (from final chunk text),
  // sources, done.
  const eventNames = events.map((e) => e.event);
  assert.ok(eventNames.includes("delta"), "expected at least one delta event");
  assert.ok(eventNames.includes("sources"), "expected a sources event");
  assert.ok(eventNames.includes("done"), "expected a done event");

  // sources event carries the full accumulated answer and citation data.
  const sourcesEvent = events.find((e) => e.event === "sources");
  assert.equal(sourcesEvent.data.answer, "Hello world.");
  assert.deepEqual(sourcesEvent.data.sources, [
    { url: "https://example.com/world", title: "World source" },
  ]);
  assert.equal(sourcesEvent.data.annotations.length, 1);
  assert.equal(sourcesEvent.data.annotations[0].url, "https://example.com/world");
  assert.equal(sourcesEvent.data.annotations[0].start_index, 0);
  assert.equal(sourcesEvent.data.annotations[0].end_index, 6);

  // Verify the upstream request shape.
  assert.equal(
    capturedRequest.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );
  assert.equal(capturedRequest.options.headers["x-goog-api-key"], "test-gemini-key");
  assert.equal(capturedRequest.options.headers["Content-Type"], "application/json");

  const payload = JSON.parse(capturedRequest.options.body);
  assert.ok(Array.isArray(payload.tools), "tools must be an array");
  // REST wire format requires snake_case "google_search", not camelCase "googleSearch"
  assert.deepEqual(payload.tools, [{ google_search: {} }]);
  assert.equal(payload.contents[0].parts[0].text, "What is new?");
  assert.ok(payload.system_instruction?.parts?.[0]?.text, "system_instruction must be set");
});

// ─── Upstream rate-limit passthrough ─────────────────────────────────────────

test("search handler preserves upstream 429 Retry-After from Gemini", async () => {
  const handler = createSearchHandler({
    getApiKey: () => "test-gemini-key",
    limiter: allow,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
      }),
  });

  const response = await handler(requestFor({ query: "news" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  const body = await response.json();
  assert.equal(body.error, "Search is busy right now. Please wait a moment and try again.");
});

// ─── Stream fallback: no finishReason ────────────────────────────────────────

test("search handler emits sources event even when no finishReason is received", async () => {
  // Gemini stream ends without a STOP — simulate by omitting finishReason.
  const onlyDelta = {
    candidates: [{ content: { parts: [{ text: "Answer text." }] } }],
    // no finishReason
  };

  const handler = createSearchHandler({
    getApiKey: () => "test-gemini-key",
    limiter: allow,
    fetchImpl: async () =>
      new Response(`data: ${JSON.stringify(onlyDelta)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      }),
  });

  const response = await handler(requestFor({ query: "anything?" }));
  const body = await response.text();
  const events = readEvents(body);

  const sourcesEvent = events.find((e) => e.event === "sources");
  assert.ok(sourcesEvent, "sources event must still be emitted");
  assert.equal(sourcesEvent.data.answer, "Answer text.");
});
