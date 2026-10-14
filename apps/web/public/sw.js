const CACHE_NAME = "nearlink-shell-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];
const ASSET_REFERENCE = /\/assets\/[A-Za-z0-9._-]+\.(?:js|css|wasm)/g;

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const root = await fetch("/");
  if (!root.ok) throw new Error("Could not fetch the app shell.");
  const html = await root.clone().text();
  await cache.put("/", root);
  await cache.addAll(APP_SHELL.slice(1));

  const pending = [...new Set(html.match(ASSET_REFERENCE) ?? [])];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not fetch app asset ${path}.`);
    const source = path.endsWith(".js") ? await response.clone().text() : "";
    await cache.put(path, response);
    for (const reference of source.match(ASSET_REFERENCE) ?? []) {
      if (!visited.has(reference)) pending.push(reference);
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/@vite")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
