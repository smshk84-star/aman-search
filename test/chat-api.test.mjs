import assert from "node:assert/strict";
import test from "node:test";
import { createAiHandler, validateMessages } from "../netlify/functions/ai.mjs";
import { createAiGateway, createConfiguredAiGateway, createMockAiProvider } from "../netlify/functions/lib/ai-gateway.mjs";
import { createGeminiAiProvider, DEFAULT_AI_MODEL } from "../netlify/functions/lib/gemini-ai-provider.mjs";
import { MAX_BODY_BYTES } from "../netlify/functions/lib/search-utils.mjs";

const url = "https://aman.example/.netlify/functions/ai";
const messages = [{ role: "user", content: "Hello" }];
const encoder = new TextEncoder();
const allow = () => ({ allowed: true, limit: 12, remaining: 11, retryAfter: 60 });
const requestFor = (body = { messages }, options = {}) => new Request(url, {
  method: "POST",
  body: typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body),
  ...options,
  headers: { "Content-Type": "application/json", Origin: "https://aman.example", ...options.headers },
});
const localHandler = () => createAiHandler({ gateway: createConfiguredAiGateway({ env: {} }), limiter: allow });
const sseBody = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
const textChunk = (text, finishReason) => ({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] });
const readEvents = (text) => text.trim().split(/\n\n+/).filter(Boolean).map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || "{}"),
}));
const collect = async (events) => { const result = []; for await (const event of events) result.push(event); return result; };
const flush = () => new Promise(setImmediate);

const watchTimers = (context) => {
  const active = new Set();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  context.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = originalSet(() => { active.delete(timer); callback(...args); }, delay);
    active.add(timer);
    return timer;
  });
  context.mock.method(globalThis, "clearTimeout", (timer) => { active.delete(timer); originalClear(timer); });
  context.after(() => { for (const timer of active) originalClear(timer); });
  return active;
};
const watchControllerErrors = (context) => {
  const errors = [];
  for (const method of ["enqueue", "close"]) {
    const original = ReadableStreamDefaultController.prototype[method];
    context.mock.method(ReadableStreamDefaultController.prototype, method, function (...args) {
      try { return original.apply(this, args); } catch (error) { errors.push(error); throw error; }
    });
  }
  return errors;
};

test("GET reports only the actual gateway provider status, without opening or rate limiting chat", async () => {
  for (const [env, expected] of [
    [{}, { configured: true, developmentMock: true, provider: "development-mock-ai" }],
    [{ GEMINI_API_KEY: "private-test-key", AI_MODEL: "private-model" }, { configured: true, developmentMock: false, provider: "gemini" }],
    [{ AI_PROVIDER: "gemini" }, { configured: false, developmentMock: false, provider: null }],
    [{ NODE_ENV: "production" }, { configured: false, developmentMock: false, provider: null }],
    [{ AI_PROVIDER: "unknown", AI_FALLBACK_PROVIDER: "mock" }, { configured: true, developmentMock: true, provider: "development-mock-ai" }],
    [{ AI_PROVIDER: "unknown", AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "private-test-key" }, { configured: true, developmentMock: false, provider: "gemini" }],
  ]) {
    const gateway = createConfiguredAiGateway({ env });
    gateway.open = () => assert.fail("GET must not open a provider");
    gateway.isConfigured = () => assert.fail("GET must use providerId()");
    const handler = createAiHandler({ gateway, limiter: () => assert.fail("GET must not consume chat quota") });
    const response = await handler(new Request(url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected);
  }
});

test("AI origin checks cover GET without Origin and preserve same-origin and CLI requests", async () => {
  const handler = localHandler();
  for (const method of ["GET", "POST"]) {
    for (const headers of [
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const response = await handler(new Request(url, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ messages }) } : {}) }));
      assert.equal(response.status, 403);
    }
  }
  for (const headers of [{}, { Origin: "https://aman.example" }, { "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }]) {
    assert.equal((await handler(new Request(url, { headers }))).status, 200);
  }
  const unsupported = await handler(new Request(url, { method: "PUT" }));
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "GET, POST");
});

test("AI accepts full multi-byte history above the unchanged shared search limit", async () => {
  assert.equal(MAX_BODY_BYTES, 12_000);
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "€".repeat(6_000) }));
  const bytes = encoder.encode(JSON.stringify({ messages: history }));
  assert.ok(bytes.byteLength > MAX_BODY_BYTES && bytes.byteLength < 512_000);
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 8_191));
      offset = Math.min(bytes.length, offset + 8_191);
    },
  });
  const response = await localHandler()(requestFor(body, { duplex: "half" }));
  assert.equal(response.status, 200);
  const events = readEvents(await response.text());
  assert.equal(events.at(-1).event, "done");
  assert.ok(events[0].data.delta.includes("€".repeat(6_000)));
  assert.equal(body.locked, false);
});

test("AI accepts exactly 512000 bytes and rejects declared or streamed oversize bodies", async () => {
  const handler = localHandler();
  const exact = JSON.stringify({ messages }).padEnd(512_000, " ");
  const accepted = await handler(requestFor(exact, { headers: { "Content-Length": "512000" } }));
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal((await handler(requestFor({ messages }, { headers: { "Content-Length": "512001" } }))).status, 413);
  for (const headers of [{}, { "Content-Length": "10" }]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(exact.slice(0, 256_000)));
        controller.enqueue(encoder.encode(exact.slice(256_000) + " "));
      },
      cancel() { cancelled = true; },
    });
    const response = await handler(requestFor(body, { headers, duplex: "half" }));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "AI request is too large." });
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
  const multiByte = `{"ignored":"${"€".repeat(171_000)}"}`;
  assert.ok(multiByte.length < 512_000);
  assert.equal((await handler(requestFor(multiByte))).status, 413);
});

test("AI retains message count, role, content length, and JSON validation", async () => {
  const handler = localHandler();
  assert.equal(validateMessages([{ role: "user", content: "x".repeat(6_000) }])[0].content.length, 6_000);
  for (const invalid of [[], Array.from({ length: 21 }, () => messages[0]), [{ role: "user", content: "x".repeat(6_001) }], [{ role: "user", content: "   " }], [{ role: "admin", content: "No" }], [{ role: "system", content: "No user" }], [null]]) {
    assert.equal(validateMessages(invalid), null);
    assert.equal((await handler(requestFor({ messages: invalid }))).status, 400);
  }
  for (const invalid of ["{", "null", "{}", "", "[]"]) assert.equal((await handler(requestFor(invalid))).status, 400);
});

test("injected env controls Gemini key, model, provider selection, and mock production policy", async (context) => {
  const previous = process.env;
  process.env = { ...previous, NODE_ENV: "production", CONTEXT: "production", GEMINI_API_KEY: "ambient-key", AI_MODEL: "ambient-model", AI_PROVIDER: "gemini" };
  context.after(() => { process.env = previous; });
  let captured;
  context.mock.method(globalThis, "fetch", async (endpoint, options) => {
    captured = { endpoint, options };
    return new Response(sseBody([textChunk("Configured", "STOP")]));
  });
  const local = createConfiguredAiGateway({ env: {} });
  assert.equal(local.providerId(), "development-mock-ai");
  assert.equal(createConfiguredAiGateway({ env: { AI_PROVIDER: "gemini" } }).providerId(), null);
  assert.equal(createMockAiProvider().isConfigured(), false);
  assert.equal(createMockAiProvider({ env: {} }).isConfigured(), true);
  const gateway = createConfiguredAiGateway({ env: { GEMINI_API_KEY: " injected-key ", AI_MODEL: "configured-model", NODE_ENV: "production" } });
  assert.equal(gateway.providerId(), "gemini");
  const session = await gateway.open({ messages });
  assert.equal(captured.options.headers["x-goog-api-key"], "injected-key");
  assert.match(captured.endpoint, /models\/configured-model:streamGenerateContent\?alt=sse$/);
  assert.equal((await collect(gateway.events(session))).at(-1).answer, "Configured");
  const defaultModel = createConfiguredAiGateway({ env: { GEMINI_API_KEY: "injected-key" } });
  await collect(defaultModel.events(await defaultModel.open({ messages })));
  assert.ok(captured.endpoint.includes(`/models/${DEFAULT_AI_MODEL}:`));
  const defaultEnv = createConfiguredAiGateway();
  await collect(defaultEnv.events(await defaultEnv.open({ messages })));
  assert.equal(captured.options.headers["x-goog-api-key"], "ambient-key");
  assert.ok(captured.endpoint.includes("/models/ambient-model:"));
});

test("production never uses a mock, including configured fallbacks after upstream failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("private upstream diagnostic", { status: 503 }));
  for (const production of [{ NODE_ENV: "production" }, { CONTEXT: "production" }]) {
    for (const config of [{}, { AI_PROVIDER: "mock" }, { AI_PROVIDER: "gemini", AI_FALLBACK_PROVIDER: "mock" }]) {
      const gateway = createConfiguredAiGateway({ env: { ...production, ...config } });
      assert.equal(gateway.providerId(), null);
      assert.equal(gateway.isConfigured(), false);
      await assert.rejects(gateway.open({ messages }), { status: 503, code: "missing_api_key" });
      const response = await createAiHandler({ gateway, limiter: allow })(requestFor());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "missing_api_key");
    }
    const gateway = createConfiguredAiGateway({ env: { ...production, GEMINI_API_KEY: "test-key", AI_FALLBACK_PROVIDER: "mock" } });
    await assert.rejects(gateway.open({ messages }), (error) => error.status === 503 && !/private/.test(error.message));
    await assert.rejects(createMockAiProvider({ env: production }).open({ messages }), { status: 503 });
  }
  const development = createConfiguredAiGateway({ env: { GEMINI_API_KEY: "test-key", AI_FALLBACK_PROVIDER: "mock" } });
  const session = await development.open({ messages });
  assert.equal(session.provider.id, "development-mock-ai");
  assert.equal((await collect(development.events(session))).at(-1).developmentMock, true);
});

test("Gemini request mapping and AI delta/complete/done contract remain intact", async (context) => {
  const timers = watchTimers(context);
  let captured;
  const provider = createGeminiAiProvider({
    getApiKey: () => "test-key",
    getModel: () => "server-selected-model",
    fetchImpl: async (endpoint, options) => {
      captured = { endpoint, options };
      return new Response(sseBody([
        { candidates: [{ content: { parts: [{ text: "private thought", thought: true }, { text: "Hello " }] } }] },
        textChunk("world", "STOP"),
      ]));
    },
  });
  const history = [{ role: "system", content: "Be helpful" }, messages[0], { role: "assistant", content: "Hi" }, { role: "user", content: "Continue" }];
  const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor({ messages: history }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-ratelimit-remaining"), "11");
  assert.deepEqual(readEvents(await response.text()), [
    { event: "delta", data: { delta: "Hello " } },
    { event: "delta", data: { delta: "world" } },
    { event: "complete", data: { answer: "Hello world", developmentMock: false } },
    { event: "done", data: {} },
  ]);
  const payload = JSON.parse(captured.options.body);
  assert.deepEqual(payload.system_instruction, { parts: [{ text: "Be helpful" }] });
  assert.deepEqual(payload.contents.map(({ role }) => role), ["user", "model", "user"]);
  assert.equal(payload.contents[2].parts[0].text, "Continue");
  assert.equal(timers.size, 0);
  assert.equal(captured.options.signal.aborted, false);
  const mock = readEvents(await (await localHandler()(requestFor())).text());
  assert.deepEqual(mock.map(({ event }) => event), ["delta", "complete", "done"]);
  assert.equal(mock[1].data.developmentMock, true);
  assert.match(mock[1].data.answer, /development mock mode/i);
});

test("Gemini SSE errors and safety blocks never turn partial output into successful completion", async (context) => {
  const failures = [
    { error: { code: 429, message: "private upstream diagnostic" } },
    { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "private upstream diagnostic" } },
    ...["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MAX_TOKENS", "OTHER"].map((finishReason) => textChunk("Do not emit", finishReason)),
  ];
  for (const failure of failures) {
    await context.test(JSON.stringify(failure), async () => {
      let cancelled = false;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(sseBody([textChunk("Partial"), failure]))); },
        cancel() { cancelled = true; },
      });
      const provider = createGeminiAiProvider({ getApiKey: () => "test-key", fetchImpl: async () => new Response(body) });
      const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor());
      const events = readEvents(await response.text());
      assert.deepEqual(events.map(({ event }) => event), ["delta", "error"]);
      assert.deepEqual(Object.keys(events[1].data), ["error"]);
      assert.doesNotMatch(events[1].data.error, /private upstream diagnostic/);
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    });
  }
  const provider = createGeminiAiProvider();
  await assert.rejects(collect(provider.events(new Response("data: malformed\n\n").body)), /no answer/i);
});

test("cancelling AI output suppresses late generator yields and errors without closing twice", async (context) => {
  for (const lateError of [false, true]) {
    await context.test(lateError ? "late rejection" : "late delta", async (context) => {
      const timers = watchTimers(context);
      const controllerErrors = watchControllerErrors(context);
      const resume = Promise.withResolvers();
      const finished = Promise.withResolvers();
      let upstreamSignal;
      const provider = {
        id: "test", isConfigured: () => true,
        async open(_request, { signal }) { upstreamSignal = signal; return "body"; },
        async *events() {
          try {
            yield { type: "delta", delta: "First" };
            await resume.promise;
            if (lateError) throw new Error("Late upstream failure");
            yield { type: "delta", delta: "Late" };
            yield { type: "complete", answer: "Late" };
          } finally { finished.resolve(); }
        },
      };
      const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor());
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      assert.equal(timers.size, 1);
      await reader.cancel("Client stopped");
      assert.equal(upstreamSignal.aborted, true);
      assert.equal(upstreamSignal.reason, "Client stopped");
      assert.equal(timers.size, 0);
      resume.resolve();
      await finished.promise;
      await flush();
      assert.deepEqual(await reader.read(), { value: undefined, done: true });
      assert.deepEqual(controllerErrors, []);
    });
  }
});

test("response cancellation and request abort cancel the pending Gemini reader and release resources", async (context) => {
  for (const mode of ["response", "request"]) {
    await context.test(mode, async (context) => {
      const timers = watchTimers(context);
      const controllerErrors = watchControllerErrors(context);
      const cancelled = Promise.withResolvers();
      const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(sseBody([textChunk("First")]))); },
        cancel(reason) { cancelled.resolve(reason); },
      });
      let upstreamSignal;
      const provider = createGeminiAiProvider({
        getApiKey: () => "test-key",
        fetchImpl: async (_url, { signal }) => { upstreamSignal = signal; return new Response(body); },
      });
      const cancellation = new AbortController();
      const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor({ messages }, { signal: cancellation.signal }));
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      const reason = new DOMException("Client disconnected", "AbortError");
      if (mode === "response") await reader.cancel(reason);
      else cancellation.abort(reason);
      assert.equal(await cancelled.promise, reason);
      await flush();
      assert.equal(upstreamSignal.aborted, true);
      assert.equal(upstreamSignal.reason, reason);
      assert.equal(body.locked, false);
      assert.equal(timers.size, 0);
      assert.deepEqual(await reader.read(), { value: undefined, done: true });
      assert.deepEqual(controllerErrors, []);
    });
  }
});

test("aborting while Gemini opens does not trigger the development fallback", async (context) => {
  const timers = watchTimers(context);
  const started = Promise.withResolvers();
  const cancellation = new AbortController();
  const primary = createGeminiAiProvider({
    getApiKey: () => "test-key",
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    }),
  });
  const fallback = { isConfigured: () => true, open: () => assert.fail("Cancelled calls must not fall back") };
  const pending = createAiHandler({ gateway: createAiGateway({ primary, fallback }), limiter: allow })(requestFor({ messages }, { signal: cancellation.signal }));
  await started.promise;
  cancellation.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.match((await response.json()).error, /cancelled/i);
  assert.equal(timers.size, 0);
});

test("AI stream timeout emits one error and cancels a stalled upstream body", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const provider = createGeminiAiProvider({ getApiKey: () => "test-key", fetchImpl: async () => new Response(body) });
  const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor());
  context.mock.timers.tick(55_000);
  const events = readEvents(await response.text());
  await flush();
  assert.deepEqual(events.map(({ event }) => event), ["error"]);
  assert.match(events[0].data.error, /timed out/i);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("Gemini opening timeout is bounded and HTTP errors remain sanitized JSON", async (context) => {
  await context.test("timeout", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const provider = createGeminiAiProvider({
      getApiKey: () => "test-key",
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const rejected = assert.rejects(provider.open({ messages }), { status: 504 });
    context.mock.timers.tick(30_000);
    await rejected;
  });
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await context.test(`HTTP ${status}`, async (context) => {
      const timers = watchTimers(context);
      const provider = createGeminiAiProvider({
        getApiKey: () => "test-key",
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: "private upstream diagnostic" } }), { status, headers: { "Retry-After": "8" } }),
      });
      const response = await createAiHandler({ gateway: createAiGateway({ primary: provider }), limiter: allow })(requestFor());
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "8");
      assert.doesNotMatch((await response.json()).error, /private upstream diagnostic/);
      assert.equal(timers.size, 0);
    });
  }
  const response = await createAiHandler({ gateway: createConfiguredAiGateway({ env: {} }), limiter: () => ({ ...allow(), allowed: false, remaining: 0 }) })(requestFor());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});
