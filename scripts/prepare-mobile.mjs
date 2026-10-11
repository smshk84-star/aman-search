import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "mobile", "www");
const files = ["index.html", "app.js", "styles.css", "manifest.webmanifest", "sw.js", "aman-mark.svg", "icon-192.png", "icon-512.png", "icon-1024.png"];
const directories = ["lib"];
const apiOrigin = String(process.env.AMAN_API_ORIGIN || "").trim().replace(/\/+$/, "");

await mkdir(out, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(out, file));
for (const directory of directories) await cp(resolve(root, directory), resolve(out, directory), { recursive: true });
const runtime = apiOrigin
  ? `globalThis.__AMAN_API_ORIGIN__ = ${JSON.stringify(apiOrigin)};\n`
  : `globalThis.__AMAN_API_ORIGIN__ = "";\n`;
await writeFile(resolve(out, "runtime-config.js"), runtime, "utf8");
await writeFile(resolve(out, "BUILD-INFO.txt"), `AMAN mobile web assets\nAPI origin: ${apiOrigin || "not configured"}\n`, "utf8");
console.log(`Prepared ${out}${apiOrigin ? ` for ${apiOrigin}` : " without API origin"}`);
