const el = (id) => document.getElementById(id);
const esc = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

let deferredInstall;
let activeSearch;

const safeDomain = (url) => { try { return new URL(url).hostname; } catch { return "Source"; } };
const isSafeWebUrl = (url) => { try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; } };

const linkMarkers = (answer, sources) => {
  let html = esc(answer);
  sources.slice(0, 9).forEach((source, index) => {
    const marker = `[${index + 1}]`;
    if (!isSafeWebUrl(source.url)) return;
    const replacement = `<a class="citation" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer" title="${esc(source.title || "Source")}">${marker}</a>`;
    html = html.split(marker).join(replacement);
  });
  return html.replace(/\n/g, "<br>");
};

const renderResults = ({ answer, sources = [], streaming = false }) => {
  const results = el("results");
  const safeSources = sources.filter((source) => isSafeWebUrl(source?.url));
  const sourceCount = safeSources.length;
  const answerHtml = streaming ? esc(answer).replace(/\n/g, "<br>") : linkMarkers(answer, safeSources);
  const sourceHtml = sourceCount ? `
    <div class="result-count">Web sources</div>
    <div class="sources">${safeSources.map((source, index) => `
      <a class="source" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">
        <span class="source-title">${index + 1}. ${esc(source.title || safeDomain(source.url))}</span>
        <span class="domain">${esc(source.domain || safeDomain(source.url))}</span>
        ${source.snippet ? `<span class="domain">${esc(source.snippet)}</span>` : ""}
      </a>`).join("")}</div>` : "";
  results.innerHTML = `<div class="result-count">AMAN Search${streaming ? " · searching live sources…" : ` · ${sourceCount} web source${sourceCount === 1 ? "" : "s"}`}</div><article class="answer">${answerHtml || "Searching the live web…"}</article>${sourceHtml}`;
};

async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readBlock = (block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) { const parsed = readBlock(block); if (parsed) yield parsed; }
    if (done) break;
  }
  const finalEvent = readBlock(buffer);
  if (finalEvent) yield finalEvent;
}

const readError = async (response) => {
  try { const data = await response.json(); return { message: data.error || "Search request failed.", code: data.code }; }
  catch { return { message: "Search request failed. Please try again." }; }
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
  let sources = [];
  go.disabled = true;
  go.textContent = "Searching…";
  status.textContent = "● Searching public web sources…";
  results.innerHTML = '<div class="empty">Searching the live web…</div>';

  try {
    const response = await fetch("/.netlify/functions/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!response.ok) throw await readError(response);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await response.json();
      answer = data.answer || "";
      sources = data.sources || [];
      if (!answer) throw { message: "The search service returned no results." };
      renderResults({ answer, sources });
    } else {
      for await (const { event, data } of readSse(response.body)) {
        if (activeSearch !== controller) return;
        if (event === "delta") { answer += data.delta || ""; renderResults({ answer, sources, streaming: true }); }
        else if (event === "sources") { answer = data.answer || answer; sources = data.sources || []; renderResults({ answer, sources }); }
        else if (event === "error") throw { message: data.error || "Unable to complete this search." };
      }
    }
    if (!answer) throw { message: "The search service returned no answer." };
    status.textContent = "● Live web results · no API key required";
  } catch (error) {
    if (error.name === "AbortError") return;
    results.innerHTML = `<div class="empty"><b>Search is not available right now.</b><br>${esc(error.message || "Search request failed. Please try again.")}<br><br>AMAN Search does not require a private API key.</div>`;
    status.textContent = "● Search temporarily unavailable";
  } finally {
    if (activeSearch === controller) { activeSearch = null; go.disabled = false; go.textContent = "Search"; }
  }
}

el("go").onclick = search;
el("q").addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
document.querySelectorAll(".chip").forEach((chip) => { chip.onclick = () => { el("q").value = chip.dataset.q; search(); }; });
el("settingsBtn").onclick = () => el("panel").classList.add("open");
el("close").onclick = () => el("panel").classList.remove("open");
el("save").onclick = () => { localStorage.setItem("aman-name", el("nameInput").value.trim() || "Aman"); location.reload(); };
const name = localStorage.getItem("aman-name") || "Aman";
document.title = `${name} Search`;
document.querySelector(".eyebrow").textContent = `Built for ${name}`;
document.querySelector("footer").textContent = `© 2026 ${name} Search · Built exclusively for ${name}`;
el("nameInput").value = name;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; el("installBtn").hidden = false; });
el("installBtn").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; el("installBtn").hidden = true; };
