import { createOsStore } from "./lib/os/store.mjs";
import { createAgentOrchestrator, AGENTS } from "./lib/os/agents.mjs";
import { validateProjectFile } from "./lib/os/files.mjs";
import { renderMarkdown, buildChatMessages, readEventStream, readTextAttachment } from "./lib/os/chat.mjs";

const app = document.getElementById("app");
const toast = document.getElementById("toast");
const API_ORIGIN = String(globalThis.__AMAN_API_ORIGIN__ || "").replace(/\/+$/, "");
const functionUrl = (name) => `${API_ORIGIN}/.netlify/functions/${name}`;
const store = createOsStore({ storage: localStorage });
const ui = { view: "chat", search: null, activeConversationId: null, searchAbort: null, run: null, drafts: new Map(), errors: new Map(), historyQuery: "", sidebarOpen: false, status: null, statusError: false };
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  clip: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a3 3 0 0 1 4 4l-9 9a1 1 0 0 1-2-2l8-8"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
  pen: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
  book: '<path d="M12 5v16M3 3c4 0 6 0 9 2 3-2 5-2 9-2v16c-4 0-6 0-9 2-3-2-5-2-9-2z"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  retry: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
const mark = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 30 20 7l12 23M13 22h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="8" r="3" fill="currentColor"/></svg>';
const draftKey = () => ui.activeConversationId || "new";
function draft() { const key = draftKey(); if (!ui.drafts.has(key)) ui.drafts.set(key, { text: "", attachments: [], mode: "chat" }); return ui.drafts.get(key); }
const currentConversation = () => store.snapshot().conversations.find((item) => item.id === ui.activeConversationId) || null;
const chatMessages = (id = ui.activeConversationId) => store.snapshot().messages.filter((item) => item.conversationId === id);
const esc = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const safeUrl = (value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
const domain = (value) => { try { return new URL(value).hostname; } catch { return "Source"; } };
const time = (value) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const RESTYLE_FLAG = "aman-os:restyle-dark-1";
try {
  if (!localStorage.getItem(RESTYLE_FLAG)) {
    if (store.snapshot().preferences.theme !== "dark") store.setPreferences({ theme: "dark" });
    localStorage.setItem(RESTYLE_FLAG, "1");
  }
} catch { /* storage unavailable */ }

function notify(message, type = "") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3600);
}

const readSse = readEventStream;

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
const nav = [["projects", "folder", "Projects"], ["tasks", "task", "Tasks"], ["files", "file", "Files"], ["agents", "spark", "Agents"]];

function providerLabel() {
  if (!navigator.onLine) return "Offline · history available";
  if (ui.status?.developmentMock) return "Demo mode · not live AI";
  if (ui.status?.provider === "ollama") return "Local AI · Ollama on this PC";
  if (ui.status?.configured) return "Gemini connected";
  if (ui.statusError) return "AI service unavailable";
  return ui.status ? "AI setup required" : "Checking connection";
}

function historyHtml() {
  const state = store.snapshot(); const query = ui.historyQuery.toLowerCase().trim();
  const conversations = state.conversations.filter((item) => !query || item.title.toLowerCase().includes(query) || state.messages.some((message) => message.conversationId === item.id && message.content.toLowerCase().includes(query)))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  return conversations.length ? conversations.map((item) => `<div class="history-item ${ui.view === "chat" && item.id === ui.activeConversationId ? "active" : ""}"><button class="history-link" data-conversation="${esc(item.id)}" title="${esc(item.title)}">${icon(item.pinned ? "pin" : "chat", 15)}<span>${esc(item.title)}</span></button><button class="history-more icon-button" data-chat-menu="${esc(item.id)}" aria-label="Options for ${esc(item.title)}">···</button></div>`).join("") : `<div class="history-empty">${query ? "No matching conversations" : "A little curiosity goes a long way.<br>Your conversations will live here."}</div>`;
}

function shell(content) {
  const state = store.snapshot(); const current = currentConversation();
  applyTheme();
  app.innerHTML = `<div class="shell ${ui.sidebarOpen ? "sidebar-open" : ""}"><button class="sidebar-shade" data-action="sidebar" aria-label="Close navigation"></button><aside class="sidebar" id="sidebar"><div class="brand"><a href="#" data-action="new-chat" class="brand-name"><span class="brand-mark">${mark}</span><strong>aman<span> / </span></strong></a><button class="icon-button sidebar-toggle" data-action="sidebar" aria-label="Close sidebar">${icon("panel")}</button></div><button class="new-chat" data-action="new-chat">${icon("plus")}<span>New chat</span><kbd>Ctrl K</kbd></button><label class="history-search">${icon("search", 17)}<input id="history-search" type="search" autocomplete="off" placeholder="Search conversations" aria-label="Search conversations" value="${esc(ui.historyQuery)}"></label><div class="section-label">Workspace</div><nav class="nav">${nav.map(([id, glyph, label]) => `<button data-nav="${id}" class="${ui.view === id ? "active" : ""}">${icon(glyph, 17)}<span>${label}</span>${id === "tasks" ? `<small>${state.tasks.filter((task) => task.status !== "DONE").length || ""}</small>` : ""}</button>`).join("")}</nav><div class="history-heading section-label"><span>Your conversations</span><span>${state.conversations.length || ""}</span></div><div class="history-list" id="history-list">${historyHtml()}</div><div class="side-bottom"><div class="privacy-note">${icon("folder", 15)}<span>Private workspace<small>History saved on this device</small></span></div><button class="profile" data-nav="settings"><span class="avatar">${esc((state.preferences.name || "Aman").slice(0, 1).toUpperCase())}</span><span><strong>${esc(state.preferences.name || "Aman")}</strong><small>Personal account · local</small></span>${icon("settings", 18)}</button></div></aside><main class="main ${ui.view === "chat" ? "chat-main" : "workspace-main"}"><header class="topbar"><div class="topbar-left"><button class="icon-button menu" data-action="sidebar" aria-label="Open navigation">${icon("panel")}</button><button class="model-label" data-action="model-info"><strong>AMAN</strong><span>Assistant</span>${icon("down", 13)}</button><span class="header-divider"></span><span class="topbar-context">${ui.view === "chat" ? esc(current?.title || "A fresh perspective") : esc(nav.find(([id]) => id === ui.view)?.[2] || "Settings")}</span></div><div class="topbar-actions">${ui.view === "chat" && current ? `<button class="icon-button" data-action="export-chat" title="Export conversation" aria-label="Export conversation">${icon("download")}</button><button class="icon-button" data-chat-menu="${esc(current.id)}" aria-label="Conversation options">···</button>` : ""}<span class="connection ${ui.status?.configured && !ui.status?.developmentMock && navigator.onLine ? "live" : ""}" id="connection"><i></i><span>${esc(providerLabel())}</span></span><button class="icon-button" data-action="theme" aria-label="Toggle light and dark theme" title="Toggle theme">${icon("sun")}</button></div></header><section class="view ${ui.view === "chat" ? "chat-view" : ""}">${content}</section></main></div>`;
  app.querySelector("#history-search").addEventListener("input", (event) => { ui.historyQuery = event.target.value; app.querySelector("#history-list").innerHTML = historyHtml(); });
}

function applyTheme() {
  const theme = store.snapshot().preferences.theme || "dark";
  document.documentElement.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
}

async function refreshStatus() {
  try {
    const response = await fetch(functionUrl("ai"), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Unavailable");
    ui.status = await response.json(); ui.statusError = false;
  } catch { ui.statusError = true; ui.status = null; }
  const node = app.querySelector("#connection");
  if (node) { node.classList.toggle("live", Boolean(ui.status?.configured && !ui.status?.developmentMock && navigator.onLine)); node.innerHTML = `<i></i><span>${esc(providerLabel())}</span>`; }
  const status = app.querySelector("#provider-detail"); if (status) status.textContent = providerLabel();
}

function listEmpty(text) { return `<div class="empty">${esc(text)}</div>`; }
function activityList(activity) { return activity.length ? `<div class="list">${activity.slice(0, 6).map((item) => `<div class="item"><div class="item-title">${esc(item.summary)}</div><div class="meta">${esc(item.type)} · ${time(item.createdAt)}</div></div>`).join("")}</div>` : listEmpty("Your project activity will appear here."); }

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
    const response = await fetch(functionUrl("search"), { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ query }), signal: controller.signal });
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

const starters = [
  ["pen", "Make something great", "Find the right words", "Help me write a clear, engaging introduction for my next project. Ask me what the project is about first."],
  ["code", "Build with confidence", "Code, debug, understand", "Be my coding partner. Ask me what I want to build, then help me break it into practical steps."],
  ["book", "Follow your curiosity", "Make the complex simple", "Teach me something interesting about how artificial intelligence works, using a simple everyday analogy."],
  ["spark", "Find a fresh angle", "Turn ideas into a plan", "Help me brainstorm a small business idea. Start by asking about my interests and skills."],
];

function sourceCards(sources = []) {
  return sources.length ? `<div class="sources">${sources.filter((source) => safeUrl(source.url)).map((source, index) => `<a class="source" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer"><span>${index + 1} · ${esc(domain(source.url))}</span><strong>${esc(source.title || domain(source.url))}</strong>${icon("globe", 14)}</a>`).join("")}</div>` : "";
}

function messageHtml(message, lastAssistantId) {
  const assistant = message.role !== "user";
  const text = message.attachments?.length ? message.content.split("\n\n--- Attached file:")[0] : message.content;
  return `<article class="message ${assistant ? "assistant" : "user"}" data-message-id="${esc(message.id)}"><div class="message-heading">${assistant ? `<span class="assistant-avatar">${mark}</span><strong>AMAN</strong>${message.mode === "web" ? '<span class="message-tag">Web search</span>' : ""}` : `<strong>You</strong>`}<time datetime="${esc(message.createdAt)}" title="${esc(time(message.createdAt))}">${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><div class="message-body ${assistant ? "markdown" : "user-text"}">${assistant ? renderMarkdown(message.content) : esc(text)}</div>${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((file) => `<span>${icon("file", 14)}${esc(file.name)}</span>`).join("")}</div>` : ""}${sourceCards(message.sources)}${message.developmentMock ? '<div class="mock-label">Development demo · no live AI request</div>' : ""}${message.interrupted ? '<div class="interrupted-label">Response interrupted · partial answer saved</div>' : ""}<div class="message-actions"><button class="icon-button" data-copy-message="${esc(message.id)}" aria-label="Copy ${assistant ? "response" : "message"}" title="Copy">${icon("copy", 15)}</button>${!assistant ? `<button class="icon-button" data-edit-message="${esc(message.id)}" aria-label="Edit message" title="Edit and resend" ${ui.run ? "disabled" : ""}>${icon("pen", 15)}</button>` : message.id === lastAssistantId ? `<button class="icon-button" data-action="regenerate" aria-label="Regenerate response" title="Regenerate response" ${ui.run ? "disabled" : ""}>${icon("retry", 15)}</button>` : ""}</div></article>`;
}

function streamHtml() {
  const run = ui.run;
  return run?.conversationId === ui.activeConversationId ? `<article class="message assistant streaming"><div class="message-heading"><span class="assistant-avatar">${mark}</span><strong>AMAN</strong><span class="message-tag">${run.mode === "web" ? "Searching the web" : "Thinking with you"}</span></div><div class="message-body markdown" id="stream-content">${run.answer ? renderMarkdown(run.answer) : '<span class="thinking"><i></i><i></i><i></i></span>'}</div><span class="sr-only" role="status">Response in progress</span></article>` : "";
}

const chipTopics = ["Technology", "Education", "India News", "Coding"];
const chipQuery = (topic) => (topic === "India News" ? "Top India news stories today" : `Latest developments in ${topic}`);

function chatView() {
  const messages = chatMessages(); const empty = !messages.length; const currentDraft = draft();
  const lastAssistantId = messages.filter((message) => message.role === "assistant").at(-1)?.id;
  const error = ui.errors.get(ui.activeConversationId);
  const content = `<div class="chat-scroll ${empty ? "is-empty" : ""}" id="chat-scroll">${empty ? `<div class="welcome"><div class="welcome-eyebrow"><span></span> BUILT FOR AMAN</div><div class="welcome-mark">${mark}</div><h1>Search the web,<br><span>your way.</span></h1><p>Independent web discovery — hey ${esc(store.snapshot().preferences.name || "Aman")}, ask anything below.</p><div class="chips">${chipTopics.map((topic) => `<button class="chip" type="button" data-topic="${topic}">${icon("search", 13)}<span>${topic}</span></button>`).join("")}</div></div>` : `<div class="messages" id="messages">${messages.filter((message) => message.role !== "system").map((message) => messageHtml(message, lastAssistantId)).join("")}${streamHtml()}${error ? `<div class="chat-error" role="alert"><strong>We couldn't finish that response.</strong><p>${esc(error)}</p><button class="secondary" data-action="regenerate">${icon("retry", 15)}Try again</button></div>` : ""}</div>`}</div><div class="composer-area ${empty ? "welcome-composer" : ""}">${ui.run && ui.run.conversationId !== ui.activeConversationId ? '<button class="running-notice" data-action="view-running">A response is running in another conversation. View it</button>' : ""}<form class="composer" id="chat-form"><div class="attachment-list" id="attachment-list"></div><textarea id="chat-input" rows="1" maxlength="6000" placeholder="Ask anything, or dream up something new…" aria-label="Message AMAN">${esc(currentDraft.text)}</textarea><div class="composer-toolbar"><div class="composer-tools"><button class="icon-button attach-button" type="button" data-action="attach" aria-label="Attach a text file" title="Attach .txt, .md, .csv or .json" ${currentDraft.mode === "web" ? "disabled" : ""}>${icon("plus", 20)}</button><span class="tool-divider"></span><button class="tool-button ${currentDraft.mode === "web" ? "selected" : ""}" type="button" data-action="web" aria-pressed="${currentDraft.mode === "web"}">${icon("globe", 16)}<span>Search the web</span></button></div><div class="composer-send"><span class="character-count" id="character-count"></span>${ui.run ? `<button class="send-button stop-button" type="button" data-action="stop" aria-label="Stop generating" title="Stop generating">${icon("stop", 17)}</button>` : `<button class="send-button" type="submit" id="send-button" aria-label="Send message" title="Send message">${icon("arrow", 20)}</button>`}</div></div><input type="file" id="chat-attachment" accept=".txt,.md,.csv,.json" hidden multiple></form><div class="composer-footnote"><span>${currentDraft.mode === "web" ? "Search queries go to the web provider. Max 1,000 characters." : "AMAN can make mistakes. Give important things a second look."}</span><span class="keyboard-hint">${store.snapshot().preferences.enterToSend === false ? "Ctrl + Enter to send" : "Shift + Enter for a new line"}</span></div>${empty ? `<div class="starters">${starters.map(([glyph, title, subtitle], index) => `<button class="starter" data-starter="${index}"><span class="starter-icon ${glyph}">${icon(glyph, 19)}</span><strong>${title}</strong><span>${subtitle}</span></button>`).join("")}</div><div class="welcome-bottom"><span class="mini-mark">${mark}</span> A little clarity. A lot of possibility.</div>` : ""}</div>`;
  shell(content);
  const input = app.querySelector("#chat-input");
  input.addEventListener("input", () => { draft().text = input.value; resizeComposer(); });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
    if (store.snapshot().preferences.enterToSend !== false || event.ctrlKey || event.metaKey) { event.preventDefault(); app.querySelector("#chat-form").requestSubmit(); }
  });
  app.querySelector("#chat-form").addEventListener("submit", (event) => { event.preventDefault(); sendChat(input.value).catch((error) => notify(error.message, "error")); });
  app.querySelector("#chat-attachment").addEventListener("change", addAttachments);
  renderAttachments(); resizeComposer();
  if (!empty) scrollToLatest(true);
}

function resizeComposer() {
  const input = app.querySelector("#chat-input"); if (!input) return;
  input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  const count = draft().text.length; const max = draft().mode === "web" ? 1000 : 6000;
  const counter = app.querySelector("#character-count"); counter.textContent = count > max * 0.8 ? `${count.toLocaleString()} / ${max.toLocaleString()}` : ""; counter.classList.toggle("over-limit", count > max);
  const send = app.querySelector("#send-button"); if (send) send.disabled = (!draft().text.trim() && !draft().attachments.length) || count > max;
}

function renderAttachments() {
  const list = app.querySelector("#attachment-list"); if (!list) return;
  list.innerHTML = draft().attachments.map((file, index) => `<span class="attachment-chip">${icon("file", 15)}<span>${esc(file.name)}</span><button class="icon-button" type="button" data-remove-attachment="${index}" aria-label="Remove ${esc(file.name)}">${icon("close", 13)}</button></span>`).join("") + (draft().attachments.length ? '<small>File contents will be sent to the AI provider with your message.</small>' : "");
}

async function addAttachments(event) {
  const targetDraft = draft(); const selected = [...event.target.files]; event.target.value = "";
  for (const file of selected) {
    try { if (targetDraft.attachments.length >= 3) throw new Error("Attach up to 3 text files per message."); const attachment = await readTextAttachment(file); targetDraft.attachments.push(attachment); }
    catch (error) { notify(error.message, "error"); }
  }
  if (draft() === targetDraft) { renderAttachments(); resizeComposer(); }
}

function scrollToLatest(force = false) {
  const scroll = app.querySelector("#chat-scroll"); if (!scroll) return;
  if (force || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160) scroll.scrollTop = scroll.scrollHeight;
}

function updateStream() {
  if (ui.view !== "chat" || ui.activeConversationId !== ui.run?.conversationId) return;
  const scroll = app.querySelector("#chat-scroll"); const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
  const node = app.querySelector("#stream-content"); if (node) node.innerHTML = renderMarkdown(ui.run.answer);
  if (atBottom) scrollToLatest(true);
}

async function sendChat(text) {
  if (ui.run) return notify("Wait for the current response, or stop it first.");
  const currentDraft = draft(); const mode = currentDraft.mode;
  text = String(text || "").trim(); if (!text && !currentDraft.attachments.length) return;
  const content = (text || "Please summarize the attached file.") + currentDraft.attachments.map((file) => `\n\n--- Attached file: ${file.name} ---\n${file.text}`).join("");
  if (content.length > (mode === "web" ? 1000 : 6000)) return notify(mode === "web" ? "Keep web searches within 1,000 characters." : "Message and attachments must fit within 6,000 characters. Please shorten them.", "error");
  if (!navigator.onLine) return notify("You are offline. Your draft is safe; reconnect to send it.", "error");
  if (!ui.activeConversationId) { ui.activeConversationId = store.createConversation({ projectId: activeProject()?.id || null }).id; ui.drafts.delete("new"); }
  const id = ui.activeConversationId;
  store.addMessage({ conversationId: id, role: "user", content, mode, attachments: currentDraft.attachments.map(({ name }) => ({ name })) });
  ui.drafts.set(id, { text: "", attachments: [], mode });
  await requestAnswer(id);
}

async function requestAnswer(conversationId) {
  if (ui.run) return;
  const history = chatMessages(conversationId); const userMessage = history.at(-1);
  if (userMessage?.role !== "user") return;
  const conversation = store.snapshot().conversations.find((item) => item.id === conversationId);
  const project = store.snapshot().projects.find((item) => item.id === conversation?.projectId);
  const run = { conversationId, mode: userMessage.mode || "chat", controller: new AbortController(), answer: "", sources: [], developmentMock: false, completed: false };
  ui.run = run; ui.errors.delete(conversationId); render();
  try {
    const body = run.mode === "web" ? { query: userMessage.content } : { messages: buildChatMessages(history.slice(0, -1), userMessage.content, `You are AMAN, a thoughtful, capable AI assistant. Answer in the user's language. Use clear Markdown, code fences for code, and be honest about uncertainty. Never pretend to browse or execute actions. ${project ? `Project context: ${project.name}. ${project.description}` : ""}`) };
    const response = await fetch(functionUrl(run.mode === "web" ? "search" : "ai"), { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body), signal: run.controller.signal });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || (response.status === 429 ? "Too many requests. Wait a minute and try again." : `Request failed (${response.status}). Please try again.`)); }
    for await (const event of readEventStream(response.body)) {
      if (run.controller.signal.aborted) break;
      if (event.event === "delta") { run.answer += event.data.delta || ""; updateStream(); }
      if (event.event === "complete" || event.event === "sources") { run.answer = event.data.answer || run.answer; run.sources = event.data.sources || []; run.developmentMock = Boolean(event.data.developmentMock); run.completed = true; updateStream(); }
      if (event.event === "error") throw new Error(event.data.error || "The response could not be completed.");
    }
    if (!run.controller.signal.aborted && (!run.completed || !run.answer.trim())) throw new Error("The connection ended before a complete answer arrived. Please try again.");
  } catch (error) {
    run.completed = false;
    if (!run.controller.signal.aborted) ui.errors.set(conversationId, error.message || "Unable to connect. Check your connection and try again.");
  } finally {
    const exists = store.snapshot().conversations.some((item) => item.id === conversationId);
    if (exists && run.answer.trim()) {
      try { store.addMessage({ conversationId, role: "assistant", content: run.answer, mode: run.mode, sources: run.sources, developmentMock: run.developmentMock, interrupted: !run.completed || run.controller.signal.aborted }); }
      catch { ui.errors.set(conversationId, "Device storage is full. Copy this response before leaving."); }
    }
    if (run.controller.signal.aborted && exists && !run.answer.trim()) ui.errors.set(conversationId, "Generation stopped. You can try again whenever you're ready.");
    ui.run = null;
    if (ui.view === "chat") render(); else { const list = app.querySelector("#history-list"); if (list) list.innerHTML = historyHtml(); }
  }
}

async function regenerate() {
  if (ui.run) return;
  const messages = chatMessages(); const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser < 0) return;
  if (messages[lastUser + 1]) store.truncateConversation(ui.activeConversationId, messages[lastUser + 1].id);
  await requestAnswer(ui.activeConversationId);
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
  const preferences = store.snapshot().preferences;
  const content = `<div class="view-head"><div><div class="eyebrow">Make yourself at home</div><h2>Settings</h2><p>Your assistant, your way. Preferences stay on this device.</p></div></div><div class="grid two"><article class="card"><h3>Personalization</h3><form id="settings-form" class="list"><label>Your name<input class="input" name="name" maxlength="80" value="${esc(preferences.name || "Aman")}" required></label><label>Appearance<select name="theme">${["light", "dark", "system"].map((theme) => `<option value="${theme}" ${(preferences.theme || "dark") === theme ? "selected" : ""}>${theme[0].toUpperCase() + theme.slice(1)}</option>`).join("")}</select></label><label class="checkbox-label"><input type="checkbox" name="enterToSend" ${preferences.enterToSend !== false ? "checked" : ""}> Enter sends a message</label><p class="muted">Shift + Enter always adds a new line. When disabled, use Ctrl / Cmd + Enter to send.</p><button class="primary">Save preferences</button></form></article><div class="list"><article class="card"><h3>AI connection</h3><div class="provider-detail" id="provider-detail">${esc(providerLabel())}</div><p class="muted">Chat uses ${ui.status?.provider === "ollama" ? "a free local AI model running on this PC (Ollama)" : "the configured AI provider (Gemini or local Ollama)"}. Web search uses the server-configured grounded search provider.</p><p class="muted">For hosted live answers, set <code>GEMINI_API_KEY</code> in Netlify environment variables; for free local answers, set <code>AI_PROVIDER=ollama</code>. Never enter an API key in a chat.</p><button class="secondary" data-action="check-connection">Check connection</button></article><article class="card"><h3>Your data stays yours</h3><p class="muted">Conversations, projects and files are saved in this browser, not synced to a cloud account. Clearing browser storage removes them. Messages and attached text are sent to the AI provider only when you send.</p><button class="secondary" data-action="export-workspace">${icon("download", 16)}Export workspace backup</button></article></div></div>`;
  shell(content);
  app.querySelector("#settings-form").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { store.setPreferences({ name: data.get("name"), theme: data.get("theme"), enterToSend: data.has("enterToSend") }); notify("Preferences saved."); render(); } catch (error) { notify(error.message, "error"); } });
}

function showDialog(title, content, actions = [{ value: "save", label: "Save", primary: true }]) {
  const dialog = document.getElementById("dialog");
  dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" type="button" id="dialog-close" aria-label="Close dialog">${icon("close")}</button></div><div class="dialog-body">${content}</div><div class="dialog-actions"><button class="secondary" value="cancel" formnovalidate>Cancel</button>${actions.map((action) => `<button class="${action.primary ? "primary" : "secondary"} ${action.danger ? "danger-button" : ""}" value="${action.value}">${esc(action.label)}</button>`).join("")}</div></form>`;
  return new Promise((resolve) => {
    let result = null;
    dialog.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); if (event.submitter?.value !== "cancel") result = { action: event.submitter?.value || "save", data: new FormData(event.currentTarget) }; dialog.close(); });
    dialog.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
    dialog.onclose = () => resolve(result);
    dialog.showModal();
  });
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportConversation(id = ui.activeConversationId) {
  const conversation = store.snapshot().conversations.find((item) => item.id === id); if (!conversation) return;
  const body = `# ${conversation.title}\n\n` + chatMessages(id).map((message) => `## ${message.role === "user" ? "You" : "AMAN"}\n\n${message.content}${message.sources?.length ? `\n\nSources:\n${message.sources.map((source) => `- [${source.title}](${source.url})`).join("\n")}` : ""}${message.developmentMock ? "\n\n_Development demo — not live AI._" : ""}\n`).join("\n---\n\n");
  downloadFile(`${conversation.title.replace(/[^a-z0-9_-]/gi, "_").slice(0, 70) || "aman-chat"}.md`, body, "text/markdown;charset=utf-8");
  notify("Conversation exported.");
}

async function conversationMenu(id) {
  const conversation = store.snapshot().conversations.find((item) => item.id === id); if (!conversation) return;
  const result = await showDialog("Conversation options", `<label>Conversation title<input class="input" name="title" value="${esc(conversation.title)}" maxlength="120" required autofocus></label><p class="muted">Rename this conversation, keep it pinned, or export a copy.</p>`, [{ value: "delete", label: "Delete", danger: true }, { value: "export", label: "Export" }, { value: "pin", label: conversation.pinned ? "Unpin" : "Pin" }, { value: "save", label: "Save", primary: true }]);
  if (!result) return;
  if (result.action === "delete") {
    const confirmed = await showDialog("Delete this conversation?", `<p>“${esc(conversation.title)}” and its messages will be removed from this browser. This cannot be undone.</p>`, [{ value: "delete", label: "Delete conversation", primary: true, danger: true }]);
    if (!confirmed) return;
    if (ui.run?.conversationId === id) ui.run.controller.abort();
    store.deleteConversation(id); ui.drafts.delete(id); ui.errors.delete(id);
    if (ui.activeConversationId === id) ui.activeConversationId = null;
    notify("Conversation deleted.");
  } else if (result.action === "export") return exportConversation(id);
  else if (result.action === "pin") store.toggleConversationPin(id);
  else store.renameConversation(id, result.data.get("title"));
  render();
}

async function editMessage(id) {
  if (ui.run) return;
  const message = chatMessages().find((item) => item.id === id); if (!message || message.role !== "user") return;
  const result = await showDialog("Edit your message", `<label>Message<textarea name="content" maxlength="6000" rows="7" required autofocus>${esc(message.content)}</textarea></label><p class="muted">Sending this edit replaces this message and everything after it in this conversation.</p>`, [{ value: "send", label: "Save & resend", primary: true }]);
  if (!result) return;
  const content = String(result.data.get("content") || "").trim();
  if (!content || content.length > (message.mode === "web" ? 1000 : 6000)) return notify("Please keep the message within the allowed length.", "error");
  store.truncateConversation(message.conversationId, message.id);
  store.addMessage({ conversationId: message.conversationId, role: "user", content, mode: message.mode });
  await requestAnswer(message.conversationId);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notify("Copied to clipboard."); }
  catch { await showDialog("Copy text", `<textarea rows="8" readonly autofocus>${esc(text)}</textarea><p class="muted">Clipboard access isn't available here. Select the text and copy it manually.</p>`, [{ value: "done", label: "Done", primary: true }]); }
}

function newChat() { ui.activeConversationId = null; ui.view = "chat"; ui.sidebarOpen = false; ui.drafts.delete("new"); render(); app.querySelector("#chat-input")?.focus(); }

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button, a[data-action]"); if (!button || button.disabled) return;
  const data = button.dataset;
  try {
    if (data.nav) { ui.view = data.nav; ui.sidebarOpen = false; render(); return; }
    if (data.conversation) { ui.activeConversationId = data.conversation; ui.view = "chat"; ui.sidebarOpen = false; render(); return; }
    if (data.chatMenu) return await conversationMenu(data.chatMenu);
    if (data.copyMessage) return await copyText(store.snapshot().messages.find((message) => message.id === data.copyMessage)?.content || "");
    if (data.editMessage) return await editMessage(data.editMessage);
    if (button.hasAttribute("data-copy-code")) return await copyText(button.closest(".code-block")?.querySelector("code")?.textContent || "");
    if (data.starter !== undefined) { draft().text = starters[Number(data.starter)][3]; render(); app.querySelector("#chat-input").focus(); return; }
    if (data.topic !== undefined) { const target = draft(); if (target.attachments.length) return notify("Remove text attachments before switching to web search."); target.mode = "web"; target.text = chipQuery(data.topic); render(); app.querySelector("#chat-input").focus(); return; }
    if (data.removeAttachment !== undefined) { draft().attachments.splice(Number(data.removeAttachment), 1); renderAttachments(); resizeComposer(); return; }
    if (!data.action) return;
    event.preventDefault();
    if (data.action === "new-chat") newChat();
    if (data.action === "sidebar") { if (matchMedia("(max-width: 800px)").matches) { ui.sidebarOpen = !ui.sidebarOpen; app.querySelector(".shell").classList.toggle("sidebar-open", ui.sidebarOpen); } else app.querySelector(".shell").classList.toggle("sidebar-collapsed"); }
    if (data.action === "theme") { store.setPreferences({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }); applyTheme(); }
    if (data.action === "web") { if (draft().attachments.length) return notify("Remove text attachments before switching to web search."); draft().mode = draft().mode === "web" ? "chat" : "web"; render(); app.querySelector("#chat-input").focus(); }
    if (data.action === "attach") app.querySelector("#chat-attachment").click();
    if (data.action === "stop") ui.run?.controller.abort();
    if (data.action === "view-running" && ui.run) { ui.activeConversationId = ui.run.conversationId; render(); }
    if (data.action === "regenerate") await regenerate();
    if (data.action === "export-chat") exportConversation();
    if (data.action === "export-workspace") { downloadFile(`aman-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.snapshot(), null, 2), "application/json"); notify("Workspace backup exported."); }
    if (data.action === "check-connection") { await refreshStatus(); notify(providerLabel()); }
    if (data.action === "model-info") await showDialog("Meet your assistant", `<div class="model-info"><span class="welcome-mark">${mark}</span><h3>AMAN${ui.status?.provider === "ollama" ? ", powered by a local model" : ui.status?.configured ? ", powered by Gemini" : " Assistant"}</h3><p>${esc(providerLabel())}</p></div><p>Chat, write, learn and code in one calm workspace. Switch on <strong>Search the web</strong> for source-backed research.</p><p class="muted">The AI model is configured on the server—Gemini with an API key, or free local Ollama. This is an independent assistant, not a connection to ChatGPT, Claude or Kimi.</p>`, [{ value: "done", label: "Got it", primary: true }]);
  } catch (error) { notify(error.message || "That action could not be completed.", "error"); }
});

function render() {
  if (ui.view === "search") return searchView(); if (ui.view === "chat") return chatView(); if (ui.view === "projects") return projectsView(); if (ui.view === "tasks") return tasksView(); if (ui.view === "files") return filesView(); if (ui.view === "agents") return agentsView(); if (ui.view === "settings") return settingsView();
  return chatView();
}

const orchestrator = createAgentOrchestrator({ store, actions: { navigate: (view) => { ui.view = view; render(); }, openSearch: async (query) => { ui.view = "search"; render(); await runSearch(query || "Research this topic"); }, openChat: async (query) => { ui.view = "chat"; render(); await sendChat(query); } } });
async function runCommand(input) { try { const result = await orchestrator.execute(input); notify(result.result); if (ui.view === "home") render(); } catch (error) { notify(error.message || "Unable to route command.", "error"); } }

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.shiftKey) { event.preventDefault(); newChat(); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if ((store.snapshot().preferences.theme || "dark") === "system") applyTheme(); });
refreshStatus();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
window.addEventListener("online", () => { render(); refreshStatus(); }); window.addEventListener("offline", render); render();
