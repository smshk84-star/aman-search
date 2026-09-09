const ALLOWED_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);
const ALLOWED_EXTENSIONS = new Set(["txt", "md", "csv", "pdf", "docx", "xlsx", "jpg", "jpeg", "png", "webp", "gif"]);
export const MAX_FILE_BYTES = 1_500_000;

export const sanitizeFileName = (value) => String(value || "")
  .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
  .replace(/\.\.+/g, ".")
  .trim()
  .slice(0, 160);

export const validateProjectFile = (file) => {
  const name = sanitizeFileName(file?.name);
  const extension = name.split(".").pop()?.toLowerCase();
  if (!name || !extension || !ALLOWED_EXTENSIONS.has(extension)) return { ok: false, error: "This file type is not supported." };
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: "Files must be 1.5 MB or smaller for browser-local storage." };
  if (file.type && !ALLOWED_TYPES.has(file.type)) return { ok: false, error: "The file MIME type is not allowed." };
  return { ok: true, name, type: file.type || "application/octet-stream" };
};
