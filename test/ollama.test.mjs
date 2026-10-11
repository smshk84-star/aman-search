import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaAiProvider, DEFAULT_OLLAMA_MODEL } from "../netlify/functions/lib/ollama-provider.mjs";
import { createConfiguredAiGateway } from "../netlify/functions/lib/ai-gateway.mjs";

const streamOf = (text) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const part of text.match(/[\s\S]{1,7}/g) || []) controller.enqueue(encoder.encode(part));
    controller.close();
  },
});

const collect = async (events) => { const all = []; for await (const event of events) all.push(event); return all; };

test("ollama provider streams NDJSON deltas and completes with the full answer", async () => {
  let captured;
  const provider = createOllamaAiProvider({
    fetchImpl: async (_url, options) => { captured = JSON.parse(options.body); return { ok: true, body: streamOf('{"message":{"content":"Hel"}}\n{"message":{"content":"lo"},"done":false}\n{"done":true}\n') }; },
  });
  const body = await provider.open({ messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "hi" }] });
  const events = await collect(provider.events(body));
  assert.equal(captured.model, DEFAULT_OLLAMA_MODEL);
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.messages, [{ role: "system", content: "Be kind." }, { role: "user", content: "hi" }]);
  assert.deepEqual(events.map((event) => event.type), ["delta", "delta", "complete"]);
  assert.equal(events.at(-1).answer, "Hello");
});

test("ollama provider surfaces server and model errors honestly", async () => {
  const down = createOllamaAiProvider({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => down.open({ messages: [] }), /local Ollama server is not reachable/i);

  const missing = createOllamaAiProvider({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => missing.open({ messages: [] }), /ollama pull/i);

  const errored = createOllamaAiProvider({ fetchImpl: async () => ({ ok: true, body: streamOf('{"error":"model not found"}') }) });
  const body = await errored.open({ messages: [] });
  await assert.rejects(() => collect(errored.events(body)), /local AI error/i);

  const empty = createOllamaAiProvider({ fetchImpl: async () => ({ ok: true, body: streamOf('{"done":true}') }) });
  const emptyBody = await empty.open({ messages: [] });
  await assert.rejects(() => collect(empty.events(emptyBody)), /returned no answer/i);
});

test("ollama provider stops on cancellation without emitting complete", async () => {
  const controller = new AbortController();
  const provider = createOllamaAiProvider({ fetchImpl: async () => ({ ok: true, body: streamOf('{"message":{"content":"partial"}}\n') }) });
  const body = await provider.open({ messages: [] });
  const events = provider.events(body, { signal: controller.signal });
  const first = await events.next();
  assert.equal(first.value.type, "delta");
  controller.abort(new DOMException("Cancelled", "AbortError"));
  const rest = await collect(events);
  assert.equal(rest.some((event) => event.type === "complete"), false);
});

test("gateway selects ollama only when AI_PROVIDER requests it", async () => {
  const local = createConfiguredAiGateway({ env: { AI_PROVIDER: "ollama", OLLAMA_MODEL: "test-model" } });
  assert.equal(local.providerId(), "ollama");
  const defaultGateway = createConfiguredAiGateway({ env: {} });
  assert.equal(defaultGateway.providerId(), "development-mock-ai");
});
