import { createOsStore } from "./lib/os/store.mjs";
import { createAgentOrchestrator, AGENTS } from "./lib/os/agents.mjs";
import { validateProjectFile } from "./lib/os/files.mjs";

const app = document.getElementById("app");
const toast = document.getElementById("toast");
const store = createOsStore({ storage: localStorage });
const ui = { view: "home", search: null, activeConversationId: null, chatDraft: "", searchAbort: null, chatAbort: null };
const esc = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const safeUrl = (value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
const domain = (value) => { try { return new URL(value).hostname; } catch { return "Source"; } };
const time = (value) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function notify(message, type = "") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3600);
}

async function* readSse(body) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const parse = (block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    try { return data ? { event, data: JSON.parse(data) } : null; } catch { return null; }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop();
    for (const block of blocks) { const parsed = parse(block); if (parsed) yield parsed; }
    if (done) break;
  }
  const last = parse(buffer); if (last) yield last;
}

const linkedAnswer = (answer, annotations = []) => {
  const refs = annotations.filter((item) => safeUrl(item?.url) && Number.isInteger(item.start_index) && Number.isInteger(item.end_index))
    .sort((a, b) => a.start_index - b.start_index);
  let html = "", cursor = 0;
  for (const ref of refs) {
    if (ref.start_index < cursor || ref.end_index <= ref.start_index || ref.end_index > answer.length) continue;
    html += esc(answer.slice(cursor, ref.start_index));
    html += `<a class="citation" href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer" title="${esc(ref.title || "Source")}">${esc(answer.slice(ref.start_index, ref.end_index))}</a>`;
    cursor = ref.end_index;
  }
  return html + esc(answer.slice(cursor));
};

const activeProject = () => store.activeProject();
const projectName = () => activeProject()?.name || "Personal workspace";
const nav = [
  ["home", "◈", "Command Center"], ["search", "⌕", "Search"], ["chat", "◌", "AI Chat"], ["projects", "▣", "Projects"], ["tasks", "✓", "Tasks"], ["files", "▤", "Files"], ["agents", "✦", "Agents"], ["coding", "</>", "Coding"], ["learning", "◒", "Learning"], ["automations", "↻", "Automations"], ["settings", "⚙", "Settings"],
];

function shell(content) {
  const state = store.snapshot();
  const online = navigator.onLine ? "Online" : "Offline";
  app.innerHTML = `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><div class="brand-mark">A</div><div><strong>AMAN OS</strong><small>Personal operating system</small></div></div><nav class="nav">${nav.map(([id, icon, label]) => `<button data-nav="${id}" class="${ui.view === id ? "active" : ""}"><i>${icon}</i>${label}</button>`).join("")}</nav><div class="side-bottom"><button class="project-picker" data-nav="projects"><span>Active project</span>${esc(projectName())}</button></div></aside><main class="main"><header class="topbar"><div><button class="menu" id="menu" aria-label="Open navigation">☰</button><h1>${esc(nav.find(([id]) => id === ui.view)?.[2] || "AMAN OS")}</h1><p>Built for ${esc(state.preferences.name || "Aman")} · browser-local workspace</p></div><div class="state"><span class="dot"></span>${online}</div></header><section class="view">${content}</section></main></div>`;
  app.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => { ui.view = button.dataset.nav; app.querySelector("#sidebar")?.classList.remove("open"); render(); }));
  app.querySelector("#menu")?.addEventListener("click", () => app.querySelector("#sidebar")?.classList.toggle("open"));
}

function listEmpty(text) { return `<div class="empty">${esc(text)}</div>`; }
function activityList(activity) { return activity.length ? `<div class="list">${activity.slice(0, 6).map((item) => `<div class="item"><div class="item-title">${esc(item.summary)}</div><div class="meta">${esc(item.type)} · ${time(item.createdAt)}</div></div>`).join("")}</div>` : listEmpty("Your project activity will appear here."); }

function homeView() {
  const state = store.snapshot(); const project = activeProject();
  const openTasks = state.tasks.filter((task) => task.status !== "DONE" && (!project || task.projectId === project.id));
  const content = `<div class="hero"><div class="eyebrow">Command Center</div><h2>What do you want to accomplish?</h2><p>Search the web, ask the assistant, create project tasks, or open a workspace. Every command routes through a tracked AMAN OS agent.</p><form class="command" id="command-form"><input class="input" id="command-input" maxlength="1000" placeholder="Try: Research the latest AI coding tools"><button class="primary">Run command</button></form></div><div class="grid three"><div class="card"><div class="metric">${state.projects.length}</div><div class="muted">Projects</div></div><div class="card"><div class="metric">${openTasks.length}</div><div class="muted">Open tasks</div></div><div class="card"><div class="metric">${state.agentRuns.filter((run) => run.status === "RUNNING").length}</div><div class="muted">Running agents</div></div></div><div class="grid two"><article class="card"><h3>Recent activity</h3>${activityList(state.activity)}</article><article class="card"><h3>Quick actions</h3><div class="row wrap"><button class="secondary" data-quick="search">Search the web</button><button class="secondary" data-quick="chat">Start AI chat</button><button class="secondary" data-quick="project">Create project</button><button class="secondary" data-quick="task">Create task</button></div></article></div>`;
  shell(content);
  app.querySelector("#command-form").addEventListener("submit", async (event) => { event.preventDefault(); await runCommand(app.querySelector("#command-input").value); });
  app.querySelectorAll("[data-quick]").forEach((button) => button.addEventListener("click", () => { ui.view = button.dataset.quick === "project" ? "projects" : button.dataset.quick === "task" ? "tasks" : button.dataset.quick; render(); }));
}

function searchView() {
  const result = ui.search;
  const answerHtml = result?.streaming ? esc(result.answer) : result ? linkedAnswer(result.answer, result.annotations) : "";
  const sourceHtml = result?.sources?.length ? `<div class="sources">${result.sources.filter((source) => safeUrl(source.url)).map((source) => `<a class="source" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(source.title || domain(source.url))}</strong><span>${esc(domain(source.url))}</span></a>`).join("")}</div>` : "";
  const content = `<div class="view-head"><div><h2>Live web search</h2><p>Source-backed answers from the secure server-side search gateway.</p></div></div><form id="search-form" class="search-form"><input class="input" id="search-query" maxlength="1000" value="${esc(result?.query || "")}" placeholder="Ask anything"><button class="primary" ${result?.streaming ? "disabled" : ""}>${result?.streaming ? "Searching…" : "Search"}</button>${result?.streaming ? `<button class="secondary" type="button" id="cancel-search">Cancel</button>` : ""}</form>${result ? `<article class="card"><div class="row"><span class="badge ${result.developmentMock ? "mock" : result.streaming ? "warn" : "ok"}">${result.developmentMock ? "Development mock — not live web" : result.streaming ? "Researching" : `${result.sources.length} sources`}</span>${result.error ? `<span class="badge warn">Search error</span>` : ""}</div><div class="answer">${result.error ? esc(result.error) : answerHtml || "Researching reliable sources…"}</div>${sourceHtml}</article>` : listEmpty("Search starts a real provider-backed web request when configured. Local development without a key is clearly labeled mock mode.")}`;
  shell(content);
  app.querySelector("#search-form").addEventListener("submit", async (event) => { event.preventDefault(); await runSearch(app.querySelector("#search-query").value); });
  app.querySelector("#cancel-search")?.addEventListener("click", () => ui.searchAbort?.abort());
}

async function runSearch(query) {
  query = String(query || "").trim(); if (!query) return notify("Enter a search query.", "error");
  ui.searchAbort?.abort(); const controller = new AbortController(); ui.searchAbort = controller;
  ui.search = { query, answer: "", annotations: [], sources: [], streaming: true, developmentMock: false }; render();
  try {
    const response = await fetch("/.netlify/functions/search", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ query }), signal: controller.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Search request failed.");
    for await (const event of readSse(response.body)) {
      if (controller.signal.aborted) return;
      if (event.event === "delta") { ui.search.answer += event.data.delta || ""; render(); }
      if (event.event === "sources") { Object.assign(ui.search, { answer: event.data.answer || ui.search.answer, annotations: event.data.annotations || [], sources: event.data.sources || [], developmentMock: Boolean(event.data.developmentMock) }); render(); }
      if (event.event === "error") throw new Error(event.data.error || "Unable to complete search.");
    }
  } catch (error) { if (error.name !== "AbortError") { ui.search.error = error.message || "Search failed."; notify(ui.search.error, "error"); } }
  finally { if (ui.searchAbort === controller) { ui.searchAbort = null; if (ui.search) ui.search.streaming = false; render(); } }
}

function conversationForUi() {
  const state = store.snapshot();
  const projectId = activeProject()?.id || null;
  const conversations = state.conversations.filter((conversation) => conversation.projectId === projectId);
  if (!conversations.some((conversation) => conversation.id === ui.activeConversationId)) ui.activeConversationId = conversations[0]?.id || null;
  return { state, projectId, conversations, current: conversations.find((conversation) => conversation.id === ui.activeConversationId) || null };
}

function chatView() {
  const { state, conversations, current } = conversationForUi();
  const messages = current ? state.messages.filter((message) => message.conversationId === current.id) : [];
  const content = `<div class="view-head"><div><h2>AI Chat</h2><p>Conversation history is stored in this browser workspace.</p></div><button class="primary" id="new-chat">New conversation</button></div><div class="card chat"><aside class="conversation-list">${conversations.length ? conversations.map((conversation) => `<button data-conversation="${conversation.id}" class="${conversation.id === current?.id ? "active" : ""}">${esc(conversation.title)}</button>`).join("") : listEmpty("Create a conversation to begin.")}</aside><div><div class="messages">${messages.length ? messages.map((message) => `<div class="message ${message.role === "user" ? "user" : "assistant"}"><small>${esc(message.role)}</small>${esc(message.content)}</div>`).join("") : listEmpty("Ask AMAN OS a question. Real AI is used when configured; local mock mode is labeled by the response.")}${ui.chatDraft ? `<div class="message assistant"><small>assistant · streaming</small>${esc(ui.chatDraft)}</div>` : ""}</div><form id="chat-form" class="row" style="margin-top:12px"><textarea id="chat-input" maxlength="6000" placeholder="Ask AMAN OS…"></textarea><button class="primary" ${ui.chatAbort ? "disabled" : ""}>${ui.chatAbort ? "Thinking…" : "Send"}</button>${ui.chatAbort ? `<button class="secondary" type="button" id="cancel-chat">Cancel</button>` : ""}</form></div></div>`;
  shell(content);
  app.querySelectorAll("[data-conversation]").forEach((button) => button.addEventListener("click", () => { ui.activeConversationId = button.dataset.conversation; ui.chatDraft = ""; render(); }));
  app.querySelector("#new-chat").addEventListener("click", () => { ui.activeConversationId = store.createConversation({ projectId: activeProject()?.id || null }).id; render(); });
  app.querySelector("#chat-form").addEventListener("submit", async (event) => { event.preventDefault(); await sendChat(app.querySelector("#chat-input").value); });
  app.querySelector("#cancel-chat")?.addEventListener("click", () => ui.chatAbort?.abort());
}

async function sendChat(text) {
  text = String(text || "").trim(); if (!text) return;
  if (!ui.activeConversationId) ui.activeConversationId = store.createConversation({ projectId: activeProject()?.id || null }).id;
  const state = store.snapshot(); const history = state.messages.filter((message) => message.conversationId === ui.activeConversationId).slice(-12);
  store.addMessage({ conversationId: ui.activeConversationId, role: "user", content: text });
  const controller = new AbortController(); ui.chatAbort = controller; ui.chatDraft = ""; render();
  try {
    const messages = [{ role: "system", content: `You are AMAN OS. Help with the active project: ${projectName()}. Be concise and honest.` }, ...history, { role: "user", content: text }];
    const response = await fetch("/.netlify/functions/ai", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ messages }), signal: controller.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "AI request failed.");
    let answer = "";
    for await (const event of readSse(response.body)) {
      if (controller.signal.aborted) return;
      if (event.event === "delta") { answer += event.data.delta || ""; ui.chatDraft = answer; render(); }
      if (event.event === "complete") answer = event.data.answer || answer;
      if (event.event === "error") throw new Error(event.data.error || "AI request failed.");
    }
    if (answer) store.addMessage({ conversationId: ui.activeConversationId, role: "assistant", content: answer });
  } catch (error) { if (error.name !== "AbortError") notify(error.message || "AI request failed.", "error"); }
  finally { if (ui.chatAbort === controller) { ui.chatAbort = null; ui.chatDraft = ""; render(); } }
}

function projectsView() {
  const projects = store.snapshot().projects;
  const content = `<div class="view-head"><div><h2>Projects</h2><p>Projects keep conversations, tasks, files, and agent runs in context.</p></div></div><div class="grid two"><article class="card"><h3>Create a project</h3><form id="project-form" class="list"><input class="input" name="name" maxlength="100" required placeholder="Project name"><textarea name="description" maxlength="600" placeholder="Optional description"></textarea><button class="primary">Create project</button></form></article><article class="card"><h3>Your projects</h3>${projects.length ? `<div class="list">${projects.map((project) => `<div class="item"><div class="row"><div style="min-width:0;flex:1"><div class="item-title">${esc(project.name)}</div><div class="meta">${esc(project.description || "No description")}</div></div><button class="secondary" data-open-project="${project.id}">${project.id === activeProject()?.id ? "Active" : "Open"}</button></div></div>`).join("")}</div>` : listEmpty("Create your first project to organize work.")}</article></div>`;
  shell(content);
  app.querySelector("#project-form").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { store.createProject({ name: data.get("name"), description: data.get("description") }); notify("Project created."); render(); } catch (error) { notify(error.message, "error"); } });
  app.querySelectorAll("[data-open-project]").forEach((button) => button.addEventListener("click", () => { store.setActiveProject(button.dataset.openProject); notify("Active project changed."); render(); }));
}

function tasksView() {
  const state = store.snapshot(); const projectId = activeProject()?.id || null; const tasks = state.tasks.filter((task) => task.projectId === projectId);
  const content = `<div class="view-head"><div><h2>Tasks</h2><p>${esc(projectName())} · tasks persist in this browser.</p></div></div><div class="grid two"><article class="card"><h3>Create task</h3><form id="task-form" class="list"><input class="input" name="title" maxlength="180" required placeholder="Task title"><textarea name="description" maxlength="1000" placeholder="Optional notes"></textarea><select name="priority"><option>MEDIUM</option><option>HIGH</option><option>LOW</option></select><button class="primary">Add task</button></form></article><article class="card"><h3>Project queue</h3>${tasks.length ? `<div class="list">${tasks.map((task) => `<div class="item task ${task.status === "DONE" ? "done" : ""}"><button class="complete" data-task-toggle="${task.id}" aria-label="Toggle task completion">${task.status === "DONE" ? "✓" : ""}</button><div><div class="item-title">${esc(task.title)}</div><div class="meta"><span class="priority ${task.priority}">${task.priority}</span> · ${esc(task.status)}${task.description ? ` · ${esc(task.description)}` : ""}</div></div><button class="icon" data-task-delete="${task.id}">Delete</button></div>`).join("")}</div>` : listEmpty("No tasks for this project yet.")}</article></div>`;
  shell(content);
  app.querySelector("#task-form").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { store.createTask({ projectId, title: data.get("title"), description: data.get("description"), priority: data.get("priority") }); notify("Task created."); render(); } catch (error) { notify(error.message, "error"); } });
  app.querySelectorAll("[data-task-toggle]").forEach((button) => button.addEventListener("click", () => { const task = tasks.find((item) => item.id === button.dataset.taskToggle); store.updateTask(task.id, { status: task.status === "DONE" ? "TODO" : "DONE" }); render(); }));
  app.querySelectorAll("[data-task-delete]").forEach((button) => button.addEventListener("click", () => { store.deleteTask(button.dataset.taskDelete); render(); }));
}

function filesView() {
  const projectId = activeProject()?.id || null; const files = store.snapshot().files.filter((file) => file.projectId === projectId);
  const content = `<div class="view-head"><div><h2>Files</h2><p>Safe browser-local project files (maximum 1.5 MB each).</p></div></div><div class="grid two"><article class="card"><h3>Upload file</h3><div class="file-drop">Files are stored locally in this browser; executable files are rejected.<input id="file-input" type="file" accept=".txt,.md,.csv,.pdf,.docx,.xlsx,.jpg,.jpeg,.png,.webp,.gif"></div></article><article class="card"><h3>Project files</h3>${files.length ? `<div class="list">${files.map((file) => `<div class="item"><div class="row"><div style="min-width:0;flex:1"><div class="item-title">${esc(file.name)}</div><div class="meta">${esc(file.type)} · ${Math.round(file.size / 1024)} KB</div></div><button class="icon" data-file-delete="${file.id}">Delete</button></div></div>`).join("")}</div>` : listEmpty("Upload a supported document or image.")}</article></div>`;
  shell(content);
  app.querySelector("#file-input").addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; const valid = validateProjectFile(file); if (!valid.ok) return notify(valid.error, "error"); try { const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Unable to read file.")); reader.readAsDataURL(file); }); store.addFile({ projectId, name: valid.name, type: valid.type, size: file.size, data }); notify("File saved locally."); render(); } catch (error) { notify(error.message || "Local storage is full.", "error"); } });
  app.querySelectorAll("[data-file-delete]").forEach((button) => button.addEventListener("click", () => { store.deleteFile(button.dataset.fileDelete); render(); }));
}

function agentsView() {
  const runs = store.snapshot().agentRuns;
  const content = `<div class="view-head"><div><h2>Agents</h2><p>Deterministic routing with recorded execution outcomes.</p></div></div><form class="row" id="agent-form"><input class="input" id="agent-input" maxlength="1000" placeholder="Research current AI tools, create a task, or analyze a file"><button class="primary">Run agent</button></form><div class="agent-grid" style="margin-top:16px">${AGENTS.map((agent) => `<article class="agent"><strong>${esc(agent.name)}</strong><p>${esc(agent.description)}</p></article>`).join("")}</div><article class="card" style="margin-top:16px"><h3>Agent runs</h3>${runs.length ? `<div class="list">${runs.slice(0, 12).map((run) => `<div class="item"><div class="row"><div><div class="item-title">${esc(run.agentId)} · ${esc(run.input)}</div><div class="meta">${esc(run.status)} · ${time(run.startedAt)}${run.result ? ` · ${esc(run.result)}` : run.error ? ` · ${esc(run.error)}` : ""}</div></div><span class="badge ${run.status === "COMPLETED" ? "ok" : run.status === "FAILED" ? "warn" : ""}">${esc(run.status)}</span></div></div>`).join("")}</div>` : listEmpty("Run an objective to create an auditable agent record.")}</article>`;
  shell(content);
  app.querySelector("#agent-form").addEventListener("submit", async (event) => { event.preventDefault(); await runCommand(app.querySelector("#agent-input").value); });
}

function settingsView() {
  const content = `<div class="view-head"><div><h2>Settings</h2><p>Local preferences stay in this browser.</p></div></div><article class="card"><form id="settings-form" class="list"><label>Your name<input class="input" name="name" maxlength="80" value="${esc(store.snapshot().preferences.name || "Aman")}"></label><button class="primary">Save settings</button></form></article>`;
  shell(content); app.querySelector("#settings-form").addEventListener("submit", (event) => { event.preventDefault(); store.setName(new FormData(event.currentTarget).get("name")); notify("Settings saved."); render(); });
}

function placeholderView(title, text) { shell(`<div class="card placeholder"><div class="eyebrow">Extension boundary</div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`); }
function render() {
  if (ui.view === "home") return homeView(); if (ui.view === "search") return searchView(); if (ui.view === "chat") return chatView(); if (ui.view === "projects") return projectsView(); if (ui.view === "tasks") return tasksView(); if (ui.view === "files") return filesView(); if (ui.view === "agents") return agentsView(); if (ui.view === "settings") return settingsView();
  return placeholderView(ui.view === "coding" ? "Coding workspace" : ui.view === "learning" ? "Learning workspace" : "Automations", "This module is intentionally not enabled yet; it has no fake controls or external side effects.");
}

const orchestrator = createAgentOrchestrator({ store, actions: { navigate: (view) => { ui.view = view; render(); }, openSearch: async (query) => { ui.view = "search"; render(); await runSearch(query || "Research this topic"); }, openChat: async (query) => { ui.view = "chat"; render(); await sendChat(query); } } });
async function runCommand(input) { try { const result = await orchestrator.execute(input); notify(result.result); if (ui.view === "home") render(); } catch (error) { notify(error.message || "Unable to route command.", "error"); } }

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
window.addEventListener("online", render); window.addEventListener("offline", render); render();
