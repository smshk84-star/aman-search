const MAX_MESSAGE_CHARS = 6_000;
const MAX_ATTACHMENT_BYTES = 24_000;
const MAX_ATTACHMENT_CHARS = 4_500;

const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const safeUrl = (value) => {
  if (!/^https?:\/\//i.test(value) || /[\s\\<>\x00-\x1F\x7F]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.href : null;
  } catch { return null; }
};

// Read balanced Markdown link delimiters without ever interpreting HTML entities.
const readLink = (text, start) => {
  let depth = 1;
  let end = start + 1;
  for (; end < text.length; end += 1) {
    if (text[end] === "\\") { end += 1; continue; }
    if (text[end] === "[") depth += 1;
    if (text[end] === "]" && --depth === 0) break;
  }
  if (depth || text[end + 1] !== "(") return null;
  let close = end + 2;
  depth = 1;
  for (; close < text.length; close += 1) {
    if (text[close] === "\\") { close += 1; continue; }
    if (text[close] === "(") depth += 1;
    if (text[close] === ")" && --depth === 0) break;
  }
  if (depth) return null;
  return { label: text.slice(start + 1, end), url: text.slice(end + 2, close), end: close + 1 };
};

const renderInline = (text, depth = 0, allowLinks = true) => {
  if (depth >= 12) return escapeHtml(text);
  const html = [];
  let index = 0;
  while (index < text.length) {
    const remaining = text.slice(index);
    if (text[index] === "\\" && /[\\`*{}\[\]()#+\-.!_|>~]/.test(text[index + 1] || "")) {
      html.push(escapeHtml(text[index + 1]));
      index += 2;
      continue;
    }
    if (text[index] === "`") {
      const delimiter = remaining.match(/^`+/)[0];
      let close = text.indexOf(delimiter, index + delimiter.length);
      while (close !== -1 && (text[close - 1] === "`" || text[close + delimiter.length] === "`")) {
        close = text.indexOf(delimiter, close + delimiter.length);
      }
      if (close !== -1) {
        html.push(`<code>${escapeHtml(text.slice(index + delimiter.length, close))}</code>`);
        index = close + delimiter.length;
        continue;
      }
      html.push(delimiter);
      index += delimiter.length;
      continue;
    }
    const image = text[index] === "!" && text[index + 1] === "[";
    if (image || text[index] === "[") {
      const link = readLink(text, index + (image ? 1 : 0));
      if (link) {
        const href = !image && allowLinks ? safeUrl(link.url) : null;
        html.push(href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderInline(link.label, depth + 1, false)}</a>`
          : escapeHtml(text.slice(index, link.end)));
        index = link.end;
        continue;
      }
    }
    const marker = ["***", "___", "**", "__", "*", "_"].find((value) => remaining.startsWith(value));
    if (marker && !(/_$/.test(marker) && /[\p{L}\p{N}]/u.test(text[index - 1] || ""))) {
      const close = text.indexOf(marker, index + marker.length);
      const content = close === -1 ? "" : text.slice(index + marker.length, close);
      if (content && !/^\s|\s$/.test(content)) {
        const rendered = renderInline(content, depth + 1, allowLinks);
        html.push(marker.length === 3 ? `<strong><em>${rendered}</em></strong>`
          : marker.length === 2 ? `<strong>${rendered}</strong>` : `<em>${rendered}</em>`);
        index = close + marker.length;
        continue;
      }
    }
    html.push(escapeHtml(text[index]));
    index += 1;
  }
  return html.join("");
};

const splitLines = (text) => {
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index], ending: parts[index + 1] || "" });
  }
  return lines;
};
const fenceMatch = (line) => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
const headingMatch = (line) => line.match(/^ {0,3}(#{1,6})(?:\s+(.*?)\s*#*\s*|\s*)$/);
const listMatch = (line) => line.match(/^ {0,3}([-+*]|\d{1,9}[.)])\s+(.*)$/);
const isQuote = (line) => /^ {0,3}>/.test(line);
const isRule = (line) => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);

const tableCells = (line) => {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells = [];
  let cell = "";
  let codeDelimiter = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      cell += text[index] + text[++index];
    } else if (text[index] === "`") {
      const delimiter = text.slice(index).match(/^`+/)[0];
      if (!codeDelimiter) codeDelimiter = delimiter;
      else if (delimiter === codeDelimiter) codeDelimiter = "";
      cell += delimiter;
      index += delimiter.length - 1;
    } else if (text[index] === "|" && !codeDelimiter) {
      cells.push(cell.trim());
      cell = "";
      if (index === text.length - 1) return cells;
    } else cell += text[index];
  }
  cells.push(cell.trim());
  return cells;
};
const isTable = (lines, index) => {
  if (!lines[index]?.text.includes("|") || !lines[index + 1]) return false;
  const header = tableCells(lines[index].text);
  const separator = tableCells(lines[index + 1].text);
  return header.length === separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const renderBlocks = (lines, depth = 0) => {
  if (depth >= 12) return `<p>${escapeHtml(lines.map((line) => line.text).join("\n"))}</p>`;
  const html = [];
  let index = 0;
  const startsBlock = (position) => {
    const text = lines[position]?.text || "";
    return !text.trim() || fenceMatch(text) || headingMatch(text) || isRule(text)
      || isQuote(text) || listMatch(text) || isTable(lines, position);
  };
  while (index < lines.length) {
    const line = lines[index].text;
    if (!line.trim()) { index += 1; continue; }
    const fence = fenceMatch(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const language = fence[2].trim().split(/\s+/)[0] || "text";
      const code = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index].text)) {
        code.push(lines[index].text + lines[index].ending);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<div class="code-block"><div class="code-header"><span class="code-language">${escapeHtml(language)}</span><button type="button" class="code-copy" data-copy-code aria-label="Copy code">Copy</button></div><pre><code>${escapeHtml(code.join(""))}</code></pre></div>`);
      continue;
    }
    const heading = headingMatch(line);
    if (heading) {
      html.push(`<h${heading[1].length}>${renderInline(heading[2] || "")}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (isRule(line)) { html.push("<hr>"); index += 1; continue; }
    if (isTable(lines, index)) {
      const header = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].text.trim() && lines[index].text.includes("|") && !startsBlock(index)) {
        const cells = tableCells(lines[index].text);
        rows.push(`<tr>${header.map((_, cellIndex) => `<td>${renderInline(cells[cellIndex] || "")}</td>`).join("")}</tr>`);
        index += 1;
      }
      html.push(`<div class="markdown-table"><table><thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }
    if (isQuote(line)) {
      const quoted = [];
      while (index < lines.length && isQuote(lines[index].text)) {
        quoted.push({ text: lines[index].text.replace(/^ {0,3}> ?/, ""), ending: lines[index].ending });
        index += 1;
      }
      html.push(`<blockquote>${renderBlocks(quoted, depth + 1)}</blockquote>`);
      continue;
    }
    const list = listMatch(line);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const tag = ordered ? "ol" : "ul";
      const start = ordered && parseInt(list[1], 10) !== 1 ? ` start="${parseInt(list[1], 10)}"` : "";
      const items = [];
      let item;
      while (index < lines.length && !isRule(lines[index].text)
        && (item = listMatch(lines[index].text)) && /^\d/.test(item[1]) === ordered) {
        items.push(`<li>${renderInline(item[2])}</li>`);
        index += 1;
      }
      html.push(`<${tag}${start}>${items.join("")}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !startsBlock(index)) {
      paragraph.push(lines[index].text);
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }
  return html.join("\n");
};

/** A deliberately small Markdown subset: raw HTML and images are always literal text. */
export const renderMarkdown = (text) => renderBlocks(splitLines(String(text ?? "")));

const boundedText = (value) => {
  if (typeof value !== "string") return "";
  let text = value.slice(0, MAX_MESSAGE_CHARS);
  // Do not split a UTF-16 surrogate pair when truncating stored context.
  if (/[\uD800-\uDBFF]$/.test(text) && /[\uDC00-\uDFFF]/.test(value[MAX_MESSAGE_CHARS] || "")) text = text.slice(0, -1);
  return text.trim();
};

/** Only the last 18 stored entries are eligible; invalid entries are skipped, not backfilled. */
export const buildChatMessages = (history, userText, systemText) => {
  if (typeof userText !== "string" || !userText.trim()) throw new Error("Enter a message before sending.");
  if (userText.length > MAX_MESSAGE_CHARS) throw new Error("Message is too long. Shorten it to 6,000 characters or fewer before sending.");
  const messages = [];
  const system = boundedText(systemText);
  if (system) messages.push({ role: "system", content: system });
  for (const message of Array.isArray(history) ? history.slice(-18) : []) {
    if (!["user", "assistant"].includes(message?.role)) continue;
    const content = boundedText(message.content);
    if (content) messages.push({ role: message.role, content });
  }
  messages.push({ role: "user", content: userText.trim() });
  return messages;
};

/** JSON SSE only. Malformed JSON (including [DONE]) is skipped; reader ownership is always released. */
export async function* readEventStream(body) {
  if (!body || typeof body.getReader !== "function") throw new Error("Chat response streaming is unavailable. Please try again.");
  let reader;
  try {
    reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines = [];
    const dispatch = () => {
      const name = eventName || "message";
      const data = dataLines;
      eventName = "message";
      dataLines = [];
      if (!data.length) return null;
      try { return { event: name, data: JSON.parse(data.join("\n")) }; }
      catch { return null; }
    };
    const consumeLine = (line) => {
      if (!line) return dispatch();
      if (line.startsWith(":")) return null;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
      return null;
    };
    function* consumeText(text, final = false) {
      buffer += text;
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== "\r" && buffer[index] !== "\n") continue;
        if (!final && buffer[index] === "\r" && index === buffer.length - 1) break;
        const event = consumeLine(buffer.slice(start, index));
        if (buffer[index] === "\r" && buffer[index + 1] === "\n") index += 1;
        start = index + 1;
        if (event) yield event;
      }
      buffer = buffer.slice(start);
      if (final) {
        if (buffer) consumeLine(buffer);
        buffer = "";
        const event = dispatch();
        if (event) yield event;
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        yield* consumeText(decoder.decode(), true);
        break;
      }
      yield* consumeText(decoder.decode(value, { stream: true }));
    }
  } catch {
    throw new Error("The chat stream was interrupted. Please retry your message.");
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* A failed or aborted stream can already be closed. */ }
      try { reader.releaseLock(); } catch { /* Cleanup must not expose transport errors. */ }
    }
  }
}

/** Read a browser File as UTF-8 text without uploading it or silently truncating its contents. */
export const readTextAttachment = async (file) => {
  const basename = typeof file?.name === "string" ? file.name.split(/[\\/]/).pop().trim() : "";
  const extension = basename.match(/\.(txt|md|csv|json)$/i)?.[0];
  if (!extension) throw new Error("Choose a .txt, .md, .csv, or .json file. PDF and image attachments are not supported in chat.");
  const stem = basename.slice(0, -extension.length)
    .replace(/[\\/:*?"<>|\x00-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "_")
    .replace(/\.{2,}/g, ".").replace(/^\.+/, "").trim();
  if (!stem) throw new Error("Rename the attachment with a filename before its extension, then try again.");
  const name = stem.slice(0, 160 - extension.length) + extension;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.arrayBuffer !== "function") {
    throw new Error("This attachment cannot be read. Choose a local text file and try again.");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is too large. Choose a file of 24,000 bytes or fewer.");
  if (!file.size) throw new Error("Attachment is empty. Choose a file containing text.");
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error("This attachment could not be read. Re-select the file and try again."); }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is too large. Choose a file of 24,000 bytes or fewer.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Attachment is not UTF-8 text. Save it as UTF-8 .txt, .md, .csv, or .json and try again."); }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(text)) {
    throw new Error("Attachment contains binary or NUL characters. Choose a plain UTF-8 text file.");
  }
  if (!text.trim()) throw new Error("Attachment is empty. Choose a file containing text.");
  if (text.length > MAX_ATTACHMENT_CHARS) throw new Error("Attachment text is too long. Shorten it to 4,500 characters or fewer.");
  return { name, text };
};
