export const STORAGE_KEY = "aman-os:v1";

const clone = (value) => JSON.parse(JSON.stringify(value));
const id = (prefix) => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

export const createInitialState = () => ({
  version: 1,
  activeProjectId: null,
  preferences: { name: "Aman", theme: "system", enterToSend: true },
  projects: [],
  conversations: [],
  messages: [],
  tasks: [],
  files: [],
  agentRuns: [],
  activity: [],
});

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const safeText = (value, max = 500) => String(value || "").trim().slice(0, max);
const metadataText = (value, max) => typeof value === "string" ? safeText(value.replace(/[\u0000-\u001f\u007f]/g, ""), max) : "";
const themes = ["light", "dark", "system"];

const sanitizeSources = (sources) => {
  if (!Array.isArray(sources)) return [];
  const sanitized = [];
  for (const source of sources) {
    if (!isObject(source) || typeof source.url !== "string") continue;
    const url = source.url.trim();
    if (!url || url.length > 2_048 || /[\u0000-\u001f\u007f]/.test(url)) continue;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.href.length > 2_048) continue;
      sanitized.push({ title: metadataText(source.title, 200) || parsed.hostname, url: parsed.href });
      if (sanitized.length === 12) break;
    } catch { /* Ignore malformed source URLs. */ }
  }
  return sanitized;
};

const sanitizeAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return [];
  const sanitized = [];
  for (const attachment of attachments) {
    const name = isObject(attachment) ? metadataText(attachment.name, 160) : "";
    if (!name) continue;
    sanitized.push({ name });
    if (sanitized.length === 3) break;
  }
  return sanitized;
};

const messageMetadata = ({ mode, sources, developmentMock, interrupted, attachments }) => ({
  mode: mode === "web" ? "web" : "chat",
  sources: sanitizeSources(sources),
  developmentMock: developmentMock === true,
  interrupted: interrupted === true,
  attachments: sanitizeAttachments(attachments),
});

export const normalizeState = (value) => {
  const initial = createInitialState();
  if (!isObject(value) || value.version !== 1) return initial;
  const safeArray = (name) => Array.isArray(value[name]) ? value[name] : [];
  const preferences = isObject(value.preferences) ? { ...initial.preferences, ...value.preferences } : initial.preferences;
  preferences.theme = themes.includes(preferences.theme) ? preferences.theme : initial.preferences.theme;
  preferences.enterToSend = typeof preferences.enterToSend === "boolean" ? preferences.enterToSend : initial.preferences.enterToSend;
  return {
    ...initial,
    activeProjectId: typeof value.activeProjectId === "string" ? value.activeProjectId : null,
    preferences,
    projects: safeArray("projects"),
    conversations: safeArray("conversations").map((conversation) => isObject(conversation) ? { ...conversation, pinned: conversation.pinned === true } : conversation),
    messages: safeArray("messages").map((message) => isObject(message) ? { ...message, ...messageMetadata(message) } : message),
    tasks: safeArray("tasks"),
    files: safeArray("files"),
    agentRuns: safeArray("agentRuns"),
    activity: safeArray("activity"),
  };
};

const nowIso = (now) => new Date(now()).toISOString();

export const createOsStore = ({ storage, key = STORAGE_KEY, now = () => Date.now() } = {}) => {
  if (!storage) throw new Error("A browser storage adapter is required.");
  let state;

  const load = () => {
    try { return normalizeState(JSON.parse(storage.getItem(key) || "null")); } catch { return createInitialState(); }
  };
  const mutate = (fn) => {
    const next = clone(state);
    const result = fn(next);
    const normalized = normalizeState(next);
    storage.setItem(key, JSON.stringify(normalized));
    state = normalized;
    return result;
  };
  const activity = (next, type, summary, projectId = null) => {
    next.activity.unshift({ id: id("activity"), type, summary: safeText(summary, 160), projectId, createdAt: nowIso(now) });
    next.activity = next.activity.slice(0, 40);
  };

  state = load();

  return {
    snapshot: () => clone(state),
    activeProject: () => state.projects.find((project) => project.id === state.activeProjectId) || null,
    setName(name) {
      mutate((next) => { next.preferences.name = safeText(name, 80) || "Aman"; });
    },
    setPreferences(changes) {
      if (!isObject(changes)) throw new Error("Valid preferences are required.");
      if (changes.theme !== undefined && !themes.includes(changes.theme)) throw new Error("Theme must be light, dark, or system.");
      if (changes.enterToSend !== undefined && typeof changes.enterToSend !== "boolean") throw new Error("Enter to send must be a boolean.");
      return mutate((next) => {
        if (changes.name !== undefined) next.preferences.name = safeText(changes.name, 80) || "Aman";
        if (changes.theme !== undefined) next.preferences.theme = changes.theme;
        if (changes.enterToSend !== undefined) next.preferences.enterToSend = changes.enterToSend;
        return clone(next.preferences);
      });
    },
    setActiveProject(projectId) {
      mutate((next) => { next.activeProjectId = next.projects.some((project) => project.id === projectId) ? projectId : null; });
    },
    createProject({ name, description = "" }) {
      const projectName = safeText(name, 100);
      if (!projectName) throw new Error("Project name is required.");
      return mutate((next) => {
        const timestamp = nowIso(now);
        const project = { id: id("project"), workspaceId: "personal", name: projectName, description: safeText(description, 600), status: "ACTIVE", createdAt: timestamp, updatedAt: timestamp };
        next.projects.unshift(project);
        next.activeProjectId = project.id;
        activity(next, "project", `Created project: ${project.name}`, project.id);
        return clone(project);
      });
    },
    updateProject(projectId, changes) {
      return mutate((next) => {
        const project = next.projects.find((item) => item.id === projectId);
        if (!project) throw new Error("Project was not found.");
        if (changes.name !== undefined) project.name = safeText(changes.name, 100) || project.name;
        if (changes.description !== undefined) project.description = safeText(changes.description, 600);
        if (changes.status !== undefined && ["ACTIVE", "ARCHIVED"].includes(changes.status)) project.status = changes.status;
        project.updatedAt = nowIso(now);
        return clone(project);
      });
    },
    createConversation({ projectId = null, title = "New conversation" }) {
      return mutate((next) => {
        const timestamp = nowIso(now);
        const conversation = { id: id("conversation"), projectId: next.projects.some((item) => item.id === projectId) ? projectId : null, title: safeText(title, 120) || "New conversation", pinned: false, createdAt: timestamp, updatedAt: timestamp };
        next.conversations.unshift(conversation);
        activity(next, "conversation", `Started conversation: ${conversation.title}`, conversation.projectId);
        return clone(conversation);
      });
    },
    renameConversation(conversationId, title) {
      mutate((next) => {
        const conversation = next.conversations.find((item) => item.id === conversationId);
        if (!conversation) throw new Error("Conversation was not found.");
        conversation.title = safeText(title, 120) || conversation.title;
        conversation.updatedAt = nowIso(now);
      });
    },
    toggleConversationPin(conversationId) {
      return mutate((next) => {
        const conversation = next.conversations.find((item) => item.id === conversationId);
        if (!conversation) throw new Error("Conversation was not found.");
        conversation.pinned = !conversation.pinned;
        conversation.updatedAt = nowIso(now);
        return conversation.pinned;
      });
    },
    deleteConversation(conversationId) {
      mutate((next) => {
        if (!next.conversations.some((item) => item.id === conversationId)) throw new Error("Conversation was not found.");
        next.conversations = next.conversations.filter((item) => item.id !== conversationId);
        next.messages = next.messages.filter((item) => item.conversationId !== conversationId);
      });
    },
    truncateConversation(conversationId, messageId) {
      mutate((next) => {
        const conversation = next.conversations.find((item) => item.id === conversationId);
        if (!conversation) throw new Error("Conversation was not found.");
        const index = next.messages.findIndex((item) => item.id === messageId && item.conversationId === conversationId);
        if (index === -1) throw new Error("Message was not found in this conversation.");
        next.messages = next.messages.filter((item, position) => item.conversationId !== conversationId || position < index);
        conversation.updatedAt = nowIso(now);
      });
    },
    addMessage({ conversationId, role, content, mode = "chat", sources = [], developmentMock = false, interrupted = false, attachments = [] }) {
      const messageContent = String(content || "").slice(0, 12_000);
      if (!conversationId || !["user", "assistant", "system"].includes(role) || !messageContent.trim()) throw new Error("A valid message is required.");
      return mutate((next) => {
        const conversation = next.conversations.find((item) => item.id === conversationId);
        if (!conversation) throw new Error("Conversation was not found.");
        const message = { id: id("message"), conversationId, role, content: messageContent, ...messageMetadata({ mode, sources, developmentMock, interrupted, attachments }), createdAt: nowIso(now) };
        next.messages.push(message);
        conversation.updatedAt = message.createdAt;
        if (conversation.title === "New conversation" && role === "user") conversation.title = safeText(messageContent, 72);
        return clone(message);
      });
    },
    createTask({ projectId = null, title, description = "", priority = "MEDIUM" }) {
      const taskTitle = safeText(title, 180);
      if (!taskTitle) throw new Error("Task title is required.");
      return mutate((next) => {
        const timestamp = nowIso(now);
        const task = { id: id("task"), projectId: next.projects.some((item) => item.id === projectId) ? projectId : null, title: taskTitle, description: safeText(description, 1_000), priority: ["LOW", "MEDIUM", "HIGH"].includes(priority) ? priority : "MEDIUM", status: "TODO", createdAt: timestamp, updatedAt: timestamp };
        next.tasks.unshift(task);
        activity(next, "task", `Created task: ${task.title}`, task.projectId);
        return clone(task);
      });
    },
    updateTask(taskId, changes) {
      return mutate((next) => {
        const task = next.tasks.find((item) => item.id === taskId);
        if (!task) throw new Error("Task was not found.");
        if (changes.title !== undefined) task.title = safeText(changes.title, 180) || task.title;
        if (changes.description !== undefined) task.description = safeText(changes.description, 1_000);
        if (changes.status !== undefined && ["TODO", "IN_PROGRESS", "DONE"].includes(changes.status)) task.status = changes.status;
        if (changes.priority !== undefined && ["LOW", "MEDIUM", "HIGH"].includes(changes.priority)) task.priority = changes.priority;
        task.updatedAt = nowIso(now);
        activity(next, "task", `${task.status === "DONE" ? "Completed" : "Updated"} task: ${task.title}`, task.projectId);
        return clone(task);
      });
    },
    deleteTask(taskId) {
      mutate((next) => {
        const task = next.tasks.find((item) => item.id === taskId);
        if (!task) return;
        next.tasks = next.tasks.filter((item) => item.id !== taskId);
        activity(next, "task", `Deleted task: ${task.title}`, task.projectId);
      });
    },
    addFile({ projectId = null, name, type, size, data = null }) {
      const filename = safeText(name, 160);
      if (!filename) throw new Error("File name is required.");
      return mutate((next) => {
        const file = { id: id("file"), projectId: next.projects.some((item) => item.id === projectId) ? projectId : null, name: filename, type: safeText(type, 100) || "application/octet-stream", size: Number(size) || 0, data, createdAt: nowIso(now) };
        next.files.unshift(file);
        activity(next, "file", `Added file: ${file.name}`, file.projectId);
        return clone(file);
      });
    },
    deleteFile(fileId) {
      mutate((next) => {
        const file = next.files.find((item) => item.id === fileId);
        if (!file) return;
        next.files = next.files.filter((item) => item.id !== fileId);
        activity(next, "file", `Deleted file: ${file.name}`, file.projectId);
      });
    },
    startAgentRun({ agentId, projectId = null, input }) {
      return mutate((next) => {
        const run = { id: id("run"), agentId, projectId: next.projects.some((item) => item.id === projectId) ? projectId : null, input: safeText(input, 1_000), status: "RUNNING", startedAt: nowIso(now), completedAt: null, result: null, error: null };
        next.agentRuns.unshift(run);
        next.agentRuns = next.agentRuns.slice(0, 50);
        return clone(run);
      });
    },
    finishAgentRun(runId, { result = null, error = null } = {}) {
      mutate((next) => {
        const run = next.agentRuns.find((item) => item.id === runId);
        if (!run) return;
        run.status = error ? "FAILED" : "COMPLETED";
        run.completedAt = nowIso(now);
        run.result = result ? safeText(result, 1_000) : null;
        run.error = error ? safeText(error, 500) : null;
        activity(next, "agent", `${run.agentId} ${run.status.toLowerCase()}`, run.projectId);
      });
    },
  };
};
