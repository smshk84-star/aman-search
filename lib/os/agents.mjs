export const AGENTS = [
  { id: "general", name: "General Agent", description: "Routes general questions to AI Chat." },
  { id: "search", name: "Search Agent", description: "Runs a live web search." },
  { id: "research", name: "Research Agent", description: "Starts source-backed web research." },
  { id: "tasks", name: "Task Agent", description: "Creates a project task." },
  { id: "files", name: "File Agent", description: "Opens the project file workspace." },
];

export const routeIntent = (input) => {
  const value = String(input || "").trim().toLowerCase();
  if (/^(search|find|look up|latest|news)\b/.test(value)) return "search";
  if (/\b(research|compare|investigate|sources?)\b/.test(value)) return "research";
  if (/\b(create|add|make)\b.*\b(task|todo|to-do)\b|^task\b/.test(value)) return "tasks";
  if (/\b(file|upload|document)\b/.test(value)) return "files";
  return "general";
};

export const createAgentOrchestrator = ({ store, actions = {} }) => ({
  agents: () => AGENTS,
  async execute(input) {
    const text = String(input || "").trim();
    if (!text) throw new Error("Enter an objective for AMAN OS.");
    const agentId = routeIntent(text);
    const run = store.startAgentRun({ agentId, projectId: store.activeProject()?.id || null, input: text });
    try {
      let result;
      if (agentId === "tasks") {
        const title = text.replace(/^.*?\b(task|todo|to-do)\b\s*(to)?\s*/i, "") || text;
        const task = store.createTask({ projectId: store.activeProject()?.id || null, title });
        result = `Created task: ${task.title}`;
        actions.navigate?.("tasks");
      } else if (agentId === "files") {
        result = "Opened the Files workspace.";
        actions.navigate?.("files");
      } else if (agentId === "search" || agentId === "research") {
        result = agentId === "research" ? "Opened Search for source-backed research." : "Opened Search.";
        actions.openSearch?.(text.replace(/^(search|find|look up|research)\s*/i, ""));
      } else {
        result = "Opened AI Chat.";
        actions.openChat?.(text);
      }
      store.finishAgentRun(run.id, { result });
      return { agentId, result, runId: run.id };
    } catch (error) {
      store.finishAgentRun(run.id, { error: error?.message || "Agent execution failed." });
      throw error;
    }
  },
});
