import assert from "node:assert/strict";
import test from "node:test";
import { createSearchHandler } from "../netlify/functions/search.mjs";
import { GEMINI_ENDPOINT, createGeminiProvider } from "../netlify/functions/lib/gemini-provider.mjs";
import {
  createRateLimiter,
  extractGeminiAnswer,
  parseGeminiSse,
  uniqueSources,
} from "../netlify/functions/lib/search-utils.mjs";

const requestFor = (body, headers = {}) => new Request("https://aman-search.example/.netlify/functions/search", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://aman-search.example", ...headers },
  body: JSON.stringify(body),
});

const allow = () => ({ allowed: true, limit: 8, remaining: 7, retryAfter: 60 });
const providerError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const encoder = new TextEncoder();

const sseBody = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const readEvents = (text) => text.trim().split(/\n\n+/).map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || "{}"),
}));

const completeChunk = ({ text = "Hello world[1]", metadata = true } = {}) => ({
  candidates: [{
    content: { parts: [{ text }] },
    finishReason: "STOP",
    ...(metadata ? {
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.com/world", title: "World source" } }],
        groundingSupports: [{ segment: { startIndex: Math.max(0, text.length - 3), endIndex: text.length }, groundingChunkIndices: [0] }],
      },
    } : {}),
  }],
});

test("Gemini citations normalize sources and reject unsafe URLs", () => {
  const result = extractGeminiAnswer(
    [
      { web: { uri: "https://example.com/a", title: "A" } },
      { web: { uri: "javascript:alert(1)", title: "Bad" } },
      { web: { uri: "https://example.com/a", title: "Duplicate" } },
    ],
    [{ segment: { startIndex: 0, endIndex: 3 }, groundingChunkIndices: [0, 1] }],
  );

  assert.deepEqual(result.sources, [{
    id: "source-1", url: "https://example.com/a", title: "A", domain: "example.com", snippet: "", retrieved_at: null,
  }]);
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].source_id, "source-1");
  assert.deepEqual(uniqueSources([{ url: "data:text/html,unsafe" }]), []);
});

test("Gemini SSE parser handles fragmented data and malformed events", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hel'));
      controller.enqueue(encoder.encode('lo"}]}}]}\n\ndata: invalid-json\n\n'));
      controller.close();
    },
  });
  const parsed = [];
  for await (const event of parseGeminiSse(stream)) parsed.push(event);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].candidates[0].content.parts[0].text, "Hello");
});

test("Gemini provider sends the documented grounding request and yields normalized events", async () => {
  let captured;
  const provider = createGeminiProvider({
    getApiKey: () => "test-key",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(sseBody([
        { candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
        completeChunk({ text: "world[1]" }),
      ]), { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const body = await provider.open("What is new?");
  const events = [];
  for await (const event of provider.events(body)) events.push(event);

  assert.equal(captured.url, GEMINI_ENDPOINT);
  assert.equal(captured.options.headers["x-goog-api-key"], "test-key");
  const payload = JSON.parse(captured.options.body);
  assert.deepEqual(payload.tools, [{ google_search: {} }]);
  assert.equal(payload.contents[0].parts[0].text, "What is new?");
  assert.deepEqual(events.map((event) => event.type), ["delta", "delta", "complete"]);
  assert.equal(events.at(-1).answer, "Hello world[1]");
  assert.equal(events.at(-1).sources[0].domain, "example.com");
});

test("Gemini provider maps 401, 403, 404, 429, and 5xx responses without exposing upstream details", async (context) => {
  for (const status of [401, 403, 404, 429, 500]) {
    await context.test(`HTTP ${status}`, async () => {
      const provider = createGeminiProvider({
        getApiKey: () => "test-key",
        maxAttempts: 1,
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: "private upstream diagnostic" } }), {
          status,
          headers: { "Content-Type": "application/json", ...(status === 429 ? { "Retry-After": "12" } : {}) },
        }),
      });
      await assert.rejects(() => provider.open("query"), (error) => {
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /private upstream diagnostic/);
        if (status === 429) assert.equal(error.retryAfter, "12");
        return true;
      });
    });
  }
});

test("Gemini provider retries one transient 5xx response", async () => {
  let calls = 0;
  const pauses = [];
  const provider = createGeminiProvider({
    getApiKey: () => "test-key",
    sleep: async (milliseconds) => { pauses.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return new Response(sseBody([completeChunk({ text: "Recovered" })]));
    },
  });
  const body = await provider.open("query");
  assert.ok(body);
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [250]);
});

test("Gemini provider does not expose a final network diagnostic", async () => {
  const provider = createGeminiProvider({
    getApiKey: () => "test-key",
    maxAttempts: 1,
    fetchImpl: async () => { throw new TypeError("internal DNS diagnostic"); },
  });
  await assert.rejects(() => provider.open("query"), (error) => {
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /internal DNS diagnostic/);
    return true;
  });
});

test("Gemini provider retries one transient network failure", async () => {
  let calls = 0;
  const pauses = [];
  const provider = createGeminiProvider({
    getApiKey: () => "test-key",
    sleep: async (milliseconds) => { pauses.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(sseBody([completeChunk({ text: "Recovered" })]));
    },
  });
  const body = await provider.open("query");
  assert.ok(body);
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [250]);
});

test("Gemini provider returns a bounded timeout and supports cancellation", async () => {
  const timeoutProvider = createGeminiProvider({
    getApiKey: () => "test-key",
    maxAttempts: 1,
    attemptTimeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(() => timeoutProvider.open("query"), (error) => error.status === 504);

  const cancellation = new AbortController();
  cancellation.abort(new DOMException("Cancelled", "AbortError"));
  const cancelledProvider = createGeminiProvider({ getApiKey: () => "test-key" });
  await assert.rejects(() => cancelledProvider.open("query", { signal: cancellation.signal }), (error) => error.status === 499);
});

test("rate limiter and handler validation reject abusive or invalid requests", async () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => time });
  assert.equal(limiter("ip").allowed, true);
  assert.equal(limiter("ip").allowed, true);
  assert.equal(limiter("ip").allowed, false);
  time = 1_001;
  assert.equal(limiter("ip").allowed, true);

  const unavailable = { isConfigured: () => false };
  const handler = createSearchHandler({ provider: unavailable, limiter: allow });
  assert.equal((await handler(new Request("https://aman-search.example/.netlify/functions/search"))).status, 405);
  assert.equal((await handler(new Request("https://aman-search.example/.netlify/functions/search", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: "{}",
  }))).status, 403);
  assert.equal((await handler(requestFor({ query: "x".repeat(1001) }))).status, 400);
  const missing = await handler(requestFor({ query: "news" }));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "missing_api_key");
});

test("search handler preserves the frontend SSE contract for success, empty sources, and malformed provider output", async (context) => {
  await context.test("success with citations", async () => {
    const provider = createGeminiProvider({
      getApiKey: () => "test-key",
      fetchImpl: async () => new Response(sseBody([
        { candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
        completeChunk({ text: "world[1]" }),
      ])),
    });
    const response = await createSearchHandler({ provider, limiter: allow })(requestFor({ query: "news" }));
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = readEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["delta", "delta", "sources", "done"]);
    assert.equal(events[2].data.answer, "Hello world[1]");
    assert.equal(events[2].data.sources.length, 1);
  });

  await context.test("answer with no useful sources", async () => {
    const provider = createGeminiProvider({
      getApiKey: () => "test-key",
      fetchImpl: async () => new Response(sseBody([completeChunk({ text: "No sources available.", metadata: false })])),
    });
    const response = await createSearchHandler({ provider, limiter: allow })(requestFor({ query: "obscure topic" }));
    const events = readEvents(await response.text());
    assert.deepEqual(events.find((event) => event.event === "sources").data.sources, []);
  });

  await context.test("malformed provider event returns a clean SSE error", async () => {
    const provider = createGeminiProvider({
      getApiKey: () => "test-key",
      fetchImpl: async () => new Response("data: malformed-json\n\n"),
    });
    const response = await createSearchHandler({ provider, limiter: allow })(requestFor({ query: "news" }));
    const events = readEvents(await response.text());
    assert.equal(events.at(-1).event, "error");
    assert.match(events.at(-1).data.error, /no answer/i);
  });
});

test("search handler returns JSON for provider errors before a stream starts", async () => {
  const provider = {
    isConfigured: () => true,
    open: async () => { throw providerError(429, "Search is busy right now.", { retryAfter: "8" }); },
  };
  const response = await createSearchHandler({ provider, limiter: allow })(requestFor({ query: "news" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "8");
  assert.equal((await response.json()).error, "Search is busy right now.");
});
