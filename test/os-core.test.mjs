import assert from "node:assert/strict";
import test from "node:test";
import { createOsStore } from "../lib/os/store.mjs";
import { createAgentOrchestrator, routeIntent } from "../lib/os/agents.mjs";
import { MAX_FILE_BYTES, sanitizeFileName, validateProjectFile } from "../lib/os/files.mjs";
import { createSearchGateway } from "../netlify/functions/lib/search-gateway.mjs";
import { createAiGateway } from "../netlify/functions/lib/ai-gateway.mjs";
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
