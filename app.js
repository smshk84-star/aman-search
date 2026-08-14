const el = (id) => document.getElementById(id);
const esc = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

let deferredInstall;
let activeSearch;

const safeDomain = (url) => {
  try { return new URL(url).hostname; } catch { return "Source"; }
};

const isSafeWebUrl = (url) => {
  try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; }
};

const linkedAnswer = (answer, annotations = []) => {
  const references = annotations
    .filter((annotation) => isSafeWebUrl(annotation?.url) && Number.isInteger(annotation.start_index) && Number.isInteger(annotation.end_index))
    .sort((left, right) => left.start_index - right.start_index);
  let html = "";
  let cursor = 0;

  references.forEach((reference, index) => {
    if (reference.start_index < cursor || reference.end_index <= reference.start_index || reference.end_index > answer.length) return;
    html += esc(answer.slice(cursor, reference.start_index));
    const label = answer.slice(reference.start_index, reference.end_index) || `[${index + 1}]`;
    html += `<a class="citation" href="${esc(reference.url)}" target="_blank" rel="noopener noreferrer" title="${esc(reference.title || "Source")}">${esc(label)}</a>`;
    cursor = reference.end_index;
  });

  return html + esc(answer.slice(cursor));
};

const renderResults = ({ answer, annotations = [], sources = [], streaming = false }) => {
  const results = el("results");
  const safeSources = sources.filter((source) => isSafeWebUrl(source?.url));
  const sourceCount = safeSources.length;
  const answerHtml = streaming ? esc(answer) : linkedAnswer(answer, annotations);
  const sourceHtml = sourceCount ? `
    <div class="result-count">Sources</div>
    <div class="sources">${safeSources.map((source, index) => `
      <a class="source" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">
        <span class="source-title">${index + 1}. ${esc(source.title || safeDomain(source.url))}</span>
        <span class="domain">${esc(source.url)}</span>
      </a>`).join("")}</div>` : "";

  results.innerHTML = `
    <div class="result-count">AI answer${streaming ? " · researching live sources…" : ` · ${sourceCount} web source${sourceCount === 1 ? "" : "s"}`}</div>
    <article class="answer">${answerHtml || "Researching reliable web sources…"}</article>${sourceHtml}`;
};

async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readBlock = (block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      const parsed = readBlock(block);
      if (parsed) yield parsed;
    }
    if (done) break;
  }

  const finalEvent = readBlock(buffer);
  if (finalEvent) yield finalEvent;
}

const readError = async (response) => {
  try {
    const data = await response.json();
    return { message: data.error || "Search request failed.", code: data.code };
  } catch {
    return { message: "Search request failed. Please try again." };
  }
};

async function search() {
  const query = el("q").value.trim();
  if (!query) return;

  activeSearch?.abort();
  const controller = new AbortController();
  activeSearch = controller;
  const results = el("results");
  const go = el("go");
  const status = el("status");
  let answer = "";
  let annotations = [];
  let sources = [];

  go.disabled = true;
  go.textContent = "Searching…";
  status.textContent = "● Searching the live web and preparing an AI answer…";
  results.innerHTML = '<div class="empty">Researching reliable web sources…</div>';

  try {
    const response = await fetch("/.netlify/functions/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw await readError(response);
    }

    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await response.json();
      answer = data.answer || "";
      annotations = data.annotations || [];
      sources = data.sources || [];
      if (!answer) throw { message: "The AI search service returned no answer." };
      renderResults({ answer, annotations, sources });
    } else {
      for await (const { event, data } of readSse(response.body)) {
        if (activeSearch !== controller) return;
        if (event === "delta") {
          answer += data.delta || "";
          renderResults({ answer, streaming: true });
        } else if (event === "sources") {
          answer = data.answer || answer;
          annotations = data.annotations || [];
          sources = data.sources || [];
          renderResults({ answer, annotations, sources });
        } else if (event === "error") {
          throw { message: data.error || "Unable to complete this search." };
        }
      }
    }

    if (!answer) throw { message: "The AI search service returned no answer." };
    status.textContent = "● Live web results with cited sources";
  } catch (error) {
    if (error.name === "AbortError") return;
    const message = error.message || "Search request failed. Please try again.";
    const hint = error.code === "missing_api_key"
      ? "The site owner needs to finish the secure Netlify API-key setup."
      : "Please try again in a moment.";
    results.innerHTML = `<div class="empty"><b>Search is not available right now.</b><br>${esc(message)}<br><br>${esc(hint)}</div>`;
    status.textContent = "● Search temporarily unavailable";
  } finally {
    if (activeSearch === controller) {
      activeSearch = null;
      go.disabled = false;
      go.textContent = "Search";
    }
  }
}

el("go").onclick = search;
el("q").addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
document.querySelectorAll(".chip").forEach((chip) => {
  chip.onclick = () => { el("q").value = chip.dataset.q; search(); };
});

el("settingsBtn").onclick = () => el("panel").classList.add("open");
el("close").onclick = () => el("panel").classList.remove("open");
el("save").onclick = () => {
  localStorage.setItem("aman-name", el("nameInput").value.trim() || "Aman");
  location.reload();
};

const name = localStorage.getItem("aman-name") || "Aman";
document.title = `${name} Search`;
document.querySelector(".eyebrow").textContent = `Built for ${name}`;
document.querySelector("footer").textContent = `© 2026 ${name} Search · Built exclusively for ${name}`;
el("nameInput").value = name;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  el("installBtn").hidden = false;
});
el("installBtn").onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  el("installBtn").hidden = true;
};
