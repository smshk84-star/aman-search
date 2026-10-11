import assert from "node:assert/strict";
import test from "node:test";
import { createOsStore } from "../lib/os/store.mjs";
import { createAgentOrchestrator, routeIntent } from "../lib/os/agents.mjs";
import { MAX_FILE_BYTES, sanitizeFileName, validateProjectFile } from "../lib/os/files.mjs";
import { createConfiguredSearchGateway, createSearchGateway } from "../netlify/functions/lib/search-gateway.mjs";
import { createAiGateway, createConfiguredAiGateway } from "../netlify/functions/lib/ai-gateway.mjs";
import { createAiHandler, validateMessages } from "../netlify/functions/ai.mjs";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, value); }
}

test("workspace store persists projects, conversations, messages, tasks, files, and agent runs", () => {
  const storage = new MemoryStorage();
  const first = createOsStore({ storage, now: () => Date.UTC(2026, 8, 9) });
  const project = first.createProject({ name: "AMAN OS", description: "Core workspace" });
  const conversation = first.createConversation({ projectId: project.id, title: "Planning" });
  first.addMessage({ conversationId: conversation.id, role: "user", content: "Plan safely" });
  const task = first.createTask({ projectId: project.id, title: "Ship search", priority: "HIGH" });
  first.updateTask(task.id, { status: "DONE" });
  const file = first.addFile({ projectId: project.id, name: "notes.md", type: "text/markdown", size: 12, data: "data:text/plain;base64,bm90ZXM=" });
  const run = first.startAgentRun({ agentId: "tasks", projectId: project.id, input: "create a task" });
  first.finishAgentRun(run.id, { result: "Created task" });

  const second = createOsStore({ storage });
  const state = second.snapshot();
  assert.equal(second.activeProject().id, project.id);
  assert.equal(state.projects[0].name, "AMAN OS");
  assert.equal(state.conversations[0].id, conversation.id);
  assert.equal(state.messages[0].content, "Plan safely");
  assert.equal(state.tasks[0].status, "DONE");
  assert.equal(state.files[0].id, file.id);
  assert.equal(state.agentRuns[0].status, "COMPLETED");
});

test("file boundary rejects traversal, executables, and oversized files", () => {
  assert.equal(sanitizeFileName("../unsafe.exe"), "._unsafe.exe");
  assert.equal(validateProjectFile({ name: "../unsafe.exe", type: "application/octet-stream", size: 1 }).ok, false);
  assert.equal(validateProjectFile({ name: "report.pdf", type: "application/pdf", size: MAX_FILE_BYTES + 1 }).ok, false);
  const allowed = validateProjectFile({ name: " research notes .md ", type: "text/markdown", size: 50 });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.name, "research notes .md");
});

test("agent router chooses deterministic safe actions and records a task run", async () => {
  const store = createOsStore({ storage: new MemoryStorage() });
  const events = [];
  const orchestrator = createAgentOrchestrator({ store, actions: { navigate: (view) => events.push(view), openSearch: (query) => events.push(`search:${query}`), openChat: (query) => events.push(`chat:${query}`) } });
  assert.equal(routeIntent("Research AI safety"), "research");
  assert.equal(routeIntent("Create a task to test"), "tasks");
  assert.equal(routeIntent("analyze this file"), "files");
  const result = await orchestrator.execute("Create a task to verify search");
  assert.equal(result.agentId, "tasks");
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().agentRuns[0].status, "COMPLETED");
  assert.deepEqual(events, ["tasks"]);
});

test("search gateway falls back without leaking provider details", async () => {
  const primary = { id: "primary", isConfigured: () => true, open: async () => { throw Object.assign(new Error("transient upstream private detail"), { status: 503 }); } };
  const fallback = { id: "fallback", isConfigured: () => true, open: async () => "body", events: async function* () { yield { type: "complete", answer: "Fallback", annotations: [], sources: [] }; } };
  const gateway = createSearchGateway({ primary, fallback });
  const session = await gateway.open({ query: "test" });
  assert.equal(session.provider.id, "fallback");
  const events = []; for await (const event of gateway.events(session)) events.push(event);
  assert.equal(events[0].answer, "Fallback");
});

test("no-credential development providers identify mock output honestly", async () => {
  const search = createConfiguredSearchGateway({ env: {} });
  const searchSession = await search.open({ query: "today's news" });
  const searchEvents = []; for await (const event of search.events(searchSession)) searchEvents.push(event);
  assert.equal(searchSession.provider.id, "development-mock-search");
  assert.equal(searchEvents.at(-1).developmentMock, true);
  assert.match(searchEvents.at(-1).answer, /did not perform a live web search/i);

  const ai = createConfiguredAiGateway({ env: {} });
  const aiSession = await ai.open({ messages: [{ role: "user", content: "hello" }] });
  const aiEvents = []; for await (const event of ai.events(aiSession)) aiEvents.push(event);
  assert.equal(aiSession.provider.id, "development-mock-ai");
  assert.equal(aiEvents.at(-1).developmentMock, true);
  assert.match(aiEvents.at(-1).answer, /development mock mode/i);
});

test("AI gateway and handler keep the browser SSE contract", async () => {
  const provider = { id: "test", isConfigured: () => true, open: async () => "body", events: async function* () { yield { type: "delta", delta: "Hello" }; yield { type: "complete", answer: "Hello" }; } };
  const gateway = createAiGateway({ primary: provider });
  const handler = createAiHandler({ gateway, limiter: () => ({ allowed: true, limit: 12, remaining: 11, retryAfter: 60 }) });
  const request = new Request("https://aman.example/.netlify/functions/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://aman.example" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }) });
  const response = await handler(request);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: delta/);
  assert.match(text, /event: complete/);
  assert.equal(validateMessages([{ role: "user", content: "Valid" }])[0].content, "Valid");
  assert.equal(validateMessages([{ role: "admin", content: "Invalid" }]), null);
});

test("conversation rename and pin persist without changing other conversations", () => {
  const storage = new MemoryStorage();
  let time = Date.UTC(2026, 8, 9);
  const store = createOsStore({ storage, now: () => time });
  const first = store.createConversation({ title: "First" });
  const other = store.createConversation({ title: "Other" });
  assert.equal(first.pinned, false);
  time += 1_000;
  store.renameConversation(first.id, "  Renamed  ");
  assert.equal(store.toggleConversationPin(first.id), true);
  assert.equal(store.toggleConversationPin(first.id), false);
  assert.equal(store.toggleConversationPin(first.id), true);
  const renamed = store.snapshot().conversations.find((item) => item.id === first.id);
  assert.equal(renamed.title, "Renamed");
  assert.equal(renamed.updatedAt, new Date(time).toISOString());
  assert.equal(renamed.pinned, true);
  assert.deepEqual(store.snapshot().conversations.find((item) => item.id === other.id), other);
  store.renameConversation(first.id, " ");
  assert.equal(store.snapshot().conversations.find((item) => item.id === first.id).title, "Renamed");
  store.renameConversation(first.id, "x".repeat(130));
  assert.equal(store.snapshot().conversations.find((item) => item.id === first.id).title.length, 120);
  assert.deepEqual(createOsStore({ storage }).snapshot(), store.snapshot());
});

test("deleting a conversation removes only its record and messages", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage });
  const project = store.createProject({ name: "Keep workspace" });
  const first = store.createConversation({ projectId: project.id, title: "Delete me" });
  const other = store.createConversation({ projectId: project.id, title: "Keep me" });
  store.addMessage({ conversationId: first.id, role: "user", content: "Remove first" });
  store.addMessage({ conversationId: other.id, role: "user", content: "Keep first" });
  store.addMessage({ conversationId: first.id, role: "assistant", content: "Remove second" });
  store.addMessage({ conversationId: other.id, role: "assistant", content: "Keep second" });
  store.createTask({ projectId: project.id, title: "Keep task" });
  store.addFile({ projectId: project.id, name: "notes.txt", type: "text/plain", size: 4, data: "keep" });
  const run = store.startAgentRun({ agentId: "tasks", projectId: project.id, input: "Keep run" });
  store.finishAgentRun(run.id, { result: "Done" });
  const expected = store.snapshot();
  expected.conversations = expected.conversations.filter((item) => item.id !== first.id);
  expected.messages = expected.messages.filter((item) => item.conversationId !== first.id);
  store.deleteConversation(first.id);
  assert.deepEqual(store.snapshot(), expected);
  assert.deepEqual(createOsStore({ storage }).snapshot(), expected);
});

test("truncation is inclusive and isolates interleaved conversations with identical timestamps", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage, now: () => Date.UTC(2026, 8, 9) });
  const first = store.createConversation({ title: "First" });
  const other = store.createConversation({ title: "Other" });
  const add = (conversationId, content) => store.addMessage({ conversationId, role: "user", content });
  const otherBefore = add(other.id, "Other before");
  const keep = add(first.id, "Keep");
  const otherMiddle = add(other.id, "Other middle");
  const boundary = add(first.id, "Remove boundary");
  const otherAfter = add(other.id, "Other after");
  add(first.id, "Remove later");
  const before = store.snapshot();
  store.truncateConversation(first.id, boundary.id);
  assert.deepEqual(store.snapshot(), { ...before, messages: [otherBefore, keep, otherMiddle, otherAfter] });
  store.truncateConversation(first.id, keep.id);
  assert.deepEqual(store.snapshot().messages, [otherBefore, otherMiddle, otherAfter]);
  assert.equal(store.snapshot().conversations.length, 2);
  store.truncateConversation(other.id, otherAfter.id);
  assert.deepEqual(store.snapshot().messages, [otherBefore, otherMiddle]);
  assert.deepEqual(createOsStore({ storage }).snapshot(), store.snapshot());
});

test("conversation operations validate missing and cross-conversation IDs before writing", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage });
  const first = store.createConversation({ title: "First" });
  const other = store.createConversation({ title: "Other" });
  const message = store.addMessage({ conversationId: other.id, role: "user", content: "Keep" });
  const before = store.snapshot();
  const persisted = storage.getItem("aman-os:v1");
  let writes = 0;
  storage.setItem = () => { writes += 1; throw new Error("Unexpected storage write"); };
  for (const missing of [undefined, null, "", "missing"]) {
    assert.throws(() => store.renameConversation(missing, "No"), /Conversation was not found/);
    assert.throws(() => store.toggleConversationPin(missing), /Conversation was not found/);
    assert.throws(() => store.deleteConversation(missing), /Conversation was not found/);
    assert.throws(() => store.truncateConversation(missing, message.id), /Conversation was not found/);
    assert.throws(() => store.truncateConversation(first.id, missing), /Message was not found/);
  }
  assert.throws(() => store.truncateConversation(first.id, message.id), /Message was not found in this conversation/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(storage.getItem("aman-os:v1"), persisted);
  assert.equal(writes, 0);
});

test("preferences validate allowed values and preserve the existing name limit", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage });
  assert.deepEqual(store.snapshot().preferences, { name: "Aman", theme: "system", enterToSend: true });
  assert.deepEqual(store.setPreferences({ theme: "dark", enterToSend: false, name: "  Mira  ", unrelated: "ignored" }), { name: "Mira", theme: "dark", enterToSend: false });
  for (const theme of ["light", "dark", "system"]) {
    store.setPreferences({ theme });
    assert.equal(store.snapshot().preferences.theme, theme);
    assert.equal(store.snapshot().preferences.enterToSend, false);
  }
  store.setPreferences({ name: "x".repeat(100), enterToSend: true });
  assert.equal(store.snapshot().preferences.name.length, 80);
  store.setPreferences({ name: "  " });
  assert.equal(store.snapshot().preferences.name, "Aman");
  store.setName("Existing setter");
  assert.equal(store.snapshot().preferences.name, "Existing setter");
  const before = store.snapshot();
  const persisted = storage.getItem("aman-os:v1");
  for (const changes of [null, [], "dark", { theme: "sepia" }, { theme: null }, { enterToSend: "false" }, { enterToSend: 0 }, { enterToSend: null }, { name: "Do not apply", theme: "invalid" }]) {
    assert.throws(() => store.setPreferences(changes), /preferences|Theme|boolean/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(storage.getItem("aman-os:v1"), persisted);
  }
  const returned = store.setPreferences({});
  returned.name = "Not stored";
  assert.deepEqual(createOsStore({ storage }).snapshot(), before);
});

test("message metadata is bounded, safe, and persists without attachment content", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage });
  const conversation = store.createConversation({});
  const sources = [
    null, { url: "javascript:alert(1)" }, { url: "data:text/html,unsafe" },
    { url: "file:///notes.txt" }, { url: "ftp://example.com/" }, { url: "/relative" },
    { url: "not a URL" }, { url: "https://example.com/\nunsafe" },
    { url: `https://example.com/${"x".repeat(2_048)}` },
    { title: "  Docs\u0000  ", url: " https://example.com/docs ", html: "not metadata" },
    { title: "", url: "http://example.org/" },
    ...Array.from({ length: 14 }, (_, index) => ({ title: "t".repeat(250), url: `https://example.com/${index}` })),
  ];
  const attachments = [null, { name: " " }, { name: { unsafe: true } },
    { name: "  notes\u0000.txt  ", content: "private file contents", data: "data:text/plain,private", size: 20, type: "text/plain" },
    { name: "n".repeat(180) }, { name: "third.txt" }, { name: "fourth.txt" }];
  const originalInputs = JSON.stringify({ sources, attachments });
  const content = "    const code = true;\n      return code;\n";
  const message = store.addMessage({ conversationId: conversation.id, role: "assistant", content, mode: "web", sources, developmentMock: true, interrupted: true, attachments });
  assert.equal(message.content, content);
  assert.equal(message.mode, "web");
  assert.equal(message.developmentMock, true);
  assert.equal(message.interrupted, true);
  assert.equal(message.sources.length, 12);
  assert.deepEqual(message.sources[0], { title: "Docs", url: "https://example.com/docs" });
  assert.deepEqual(message.sources[1], { title: "example.org", url: "http://example.org/" });
  assert.equal(message.sources[2].title.length, 200);
  assert.ok(message.sources.every((source) => ["http:", "https:"].includes(new URL(source.url).protocol)));
  assert.deepEqual(message.attachments, [{ name: "notes.txt" }, { name: "n".repeat(160) }, { name: "third.txt" }]);
  assert.equal(JSON.stringify({ sources, attachments }), originalInputs);
  const reloaded = createOsStore({ storage }).snapshot();
  assert.deepEqual(reloaded.messages, [message]);
  assert.doesNotMatch(storage.getItem("aman-os:v1"), /private file contents|data:text\/plain,private|not metadata/);
  message.attachments[0].name = "Not stored";
  message.sources[0].url = "javascript:alert(1)";
  assert.deepEqual(store.snapshot(), reloaded);
});

test("message defaults and validation retain the 12000-character storage limit", () => {
  const storage = new MemoryStorage();
  const store = createOsStore({ storage });
  const conversation = store.createConversation({});
  const message = store.addMessage({ conversationId: conversation.id, role: "user", content: `  ${"x".repeat(12_100)}` });
  assert.equal(message.content.length, 12_000);
  assert.ok(message.content.startsWith("  x"));
  assert.equal(store.snapshot().conversations[0].title, "x".repeat(72));
  assert.equal(message.mode, "chat");
  assert.deepEqual(message.sources, []);
  assert.deepEqual(message.attachments, []);
  assert.equal(message.developmentMock, false);
  assert.equal(message.interrupted, false);
  const invalidMetadata = store.addMessage({ conversationId: conversation.id, role: "assistant", content: "Valid", mode: "invalid", sources: {}, attachments: "file", developmentMock: "false", interrupted: 1 });
  assert.equal(invalidMetadata.mode, "chat");
  assert.deepEqual(invalidMetadata.sources, []);
  assert.deepEqual(invalidMetadata.attachments, []);
  assert.equal(invalidMetadata.developmentMock, false);
  assert.equal(invalidMetadata.interrupted, false);
  const before = store.snapshot();
  assert.throws(() => store.addMessage({ conversationId: conversation.id, role: "user", content: " \n\t " }), /valid message/);
  assert.throws(() => store.addMessage({ conversationId: conversation.id, role: "admin", content: "No" }), /valid message/);
  assert.throws(() => store.addMessage({ conversationId: "missing", role: "user", content: "No" }), /Conversation was not found/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(createOsStore({ storage }).snapshot(), before);
});

test("existing aman-os v1 workspace data loads with compatible preference and message defaults", () => {
  const storage = new MemoryStorage();
  const legacy = {
    version: 1, activeProjectId: "project_existing", preferences: { name: "Existing", customPreference: "keep" },
    projects: [{ id: "project_existing", name: "Existing project", description: "Keep description" }],
    conversations: [{ id: "conversation_existing", projectId: "project_existing", title: "Existing conversation" }],
    messages: [{ id: "message_existing", conversationId: "conversation_existing", role: "user", content: "    keep exact code\n", createdAt: "2026-09-09T00:00:00.000Z" }],
    tasks: [{ id: "task_existing", title: "Keep task", status: "DONE" }],
    files: [{ id: "file_existing", name: "keep.txt", data: "original data" }],
    agentRuns: [{ id: "run_existing", result: "Keep result" }], activity: [{ id: "activity_existing", summary: "Keep activity" }],
  };
  storage.setItem("aman-os:v1", JSON.stringify(legacy));
  const store = createOsStore({ storage });
  assert.equal(store.snapshot().messages[0].content, legacy.messages[0].content);
  assert.equal(store.snapshot().messages[0].mode, "chat");
  assert.equal(store.snapshot().conversations[0].pinned, false);
  assert.equal(store.snapshot().preferences.name, "Existing");
  assert.equal(store.snapshot().preferences.theme, "system");
  assert.equal(store.snapshot().preferences.enterToSend, true);
  store.setPreferences({ theme: "dark" });
  const reloaded = createOsStore({ storage });
  assert.equal(reloaded.activeProject().id, "project_existing");
  assert.equal(reloaded.snapshot().preferences.customPreference, "keep");
  for (const field of ["version", "activeProjectId", "projects", "tasks", "files", "agentRuns", "activity"]) {
    assert.deepEqual(reloaded.snapshot()[field], legacy[field]);
  }
  for (const [field, value] of Object.entries(legacy.messages[0])) assert.deepEqual(reloaded.snapshot().messages[0][field], value);
  assert.deepEqual([...storage.values.keys()], ["aman-os:v1"]);
});

test("reload sanitizes invalid stored preferences, flags, sources, and attachment metadata", () => {
  const storage = new MemoryStorage();
  storage.setItem("aman-os:v1", JSON.stringify({
    version: 1, preferences: { name: "Keep", theme: "invalid", enterToSend: "false" },
    conversations: [{ id: "conversation_existing", pinned: "false" }],
    messages: [{ id: "message_existing", conversationId: "conversation_existing", content: "  Preserve content  ",
      mode: "invalid", developmentMock: "false", interrupted: 1,
      sources: [{ title: "Unsafe", url: "javascript:alert(1)" }, { title: "  Safe  ", url: "https://example.com/" }],
      attachments: [{ name: "  notes.txt  ", content: "Do not retain raw attachments", url: "javascript:alert(1)" }],
    }],
  }));
  const store = createOsStore({ storage });
  const state = store.snapshot();
  assert.deepEqual(state.preferences, { name: "Keep", theme: "system", enterToSend: true });
  assert.equal(state.conversations[0].pinned, false);
  assert.equal(state.messages[0].content, "  Preserve content  ");
  assert.equal(state.messages[0].mode, "chat");
  assert.equal(state.messages[0].developmentMock, false);
  assert.equal(state.messages[0].interrupted, false);
  assert.deepEqual(state.messages[0].sources, [{ title: "Safe", url: "https://example.com/" }]);
  assert.deepEqual(state.messages[0].attachments, [{ name: "notes.txt" }]);
  store.setPreferences({ theme: "dark" });
  assert.doesNotMatch(storage.getItem("aman-os:v1"), /javascript:|Do not retain raw attachments/);
});

test("failed storage writes roll back preferences and every conversation mutation", () => {
  const storage = new MemoryStorage();
  let time = Date.UTC(2026, 8, 9);
  const store = createOsStore({ storage, now: () => time });
  const project = store.createProject({ name: "Keep project" });
  const conversation = store.createConversation({ projectId: project.id });
  const boundary = store.addMessage({ conversationId: conversation.id, role: "assistant", content: "First" });
  store.addMessage({ conversationId: conversation.id, role: "assistant", content: "Later" });
  const before = store.snapshot();
  const persisted = storage.getItem("aman-os:v1");
  const setItem = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = () => { writes += 1; throw new Error("Storage quota exceeded"); };
  time += 1_000;
  const mutations = [
    () => store.setPreferences({ name: "Changed", theme: "dark", enterToSend: false }),
    () => store.setName("Changed"),
    () => store.createConversation({ title: "Not saved" }),
    () => store.renameConversation(conversation.id, "Changed"),
    () => store.toggleConversationPin(conversation.id),
    () => store.deleteConversation(conversation.id),
    () => store.truncateConversation(conversation.id, boundary.id),
    () => store.addMessage({ conversationId: conversation.id, role: "user", content: "Not saved", mode: "web", sources: [{ title: "Docs", url: "https://example.com/" }], developmentMock: true, interrupted: true, attachments: [{ name: "notes.txt" }] }),
  ];
  for (const mutate of mutations) {
    assert.throws(mutate, /Storage quota exceeded/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(storage.getItem("aman-os:v1"), persisted);
    assert.deepEqual(createOsStore({ storage }).snapshot(), before);
  }
  assert.equal(writes, mutations.length);
  storage.setItem = setItem;
  assert.equal(store.toggleConversationPin(conversation.id), true);
  store.truncateConversation(conversation.id, boundary.id);
  assert.deepEqual(store.snapshot().messages, []);
  assert.deepEqual(createOsStore({ storage }).snapshot(), store.snapshot());
});
