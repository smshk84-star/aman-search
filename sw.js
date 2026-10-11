const CACHE = "aman-os-v2";
const APP_SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./aman-mark.svg",
  "./lib/os/store.mjs", "./lib/os/agents.mjs", "./lib/os/files.mjs", "./lib/os/chat.mjs",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => (key.startsWith("aman-search-") || key.startsWith("aman-os-")) && key !== CACHE)
      .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/.netlify/functions/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
