const CONTROL_CACHE = "nearlink-shell-control-v1";
const RELEASE_PREFIX = "nearlink-shell-release-";
const LEGACY_CACHE = "nearlink-shell-v1";
const APP_SHELL = ["/manifest.webmanifest", "/icon.svg"];
const ACTIVE_KEY = new URL("/__nearlink_shell__/active", self.location.origin).href;
const PENDING_KEY = new URL("/__nearlink_shell__/pending", self.location.origin).href;
const COMPLETE_KEY = new URL("/__nearlink_shell__/complete", self.location.origin).href;
const CLIENT_KEY_PREFIX = new URL("/__nearlink_shell__/clients/", self.location.origin).href;
const ASSET_REFERENCE = /(?:\/assets\/|\.{1,2}\/)[A-Za-z0-9._/-]+\.(?:js|css|wasm)/g;
const HASHED_ASSET = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm)$/;
let latestNavigation = 0;
let refreshQueue = Promise.resolve();

function shellUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function referencedAssets(source, baseUrl) {
  const assets = [];
  for (const match of source.match(ASSET_REFERENCE) ?? []) {
    const url = new URL(match, baseUrl);
    if (url.origin !== self.location.origin || !HASHED_ASSET.test(url.pathname)) {
      throw new Error(`App shell references an unsupported asset: ${match}`);
    }
    assets.push(url.href);
  }
  return assets;
}

async function fetchAndCache(cache, url, { readText = false } = {}) {
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`Could not fetch app shell resource ${new URL(url).pathname}.`);
  const content = readText ? await response.clone().text() : "";
  const path = new URL(url).pathname;
  const extension = path.split(".").pop()?.toLowerCase();
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (extension === "js") {
    const validTypes = new Set(["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);
    if (!validTypes.has(contentType) || !content.trim() || /^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(content)) {
      throw new Error(`App shell JavaScript has an invalid response: ${path}.`);
    }
  } else if (extension === "css") {
    if (contentType !== "text/css" || !content.trim() || /^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(content)) {
      throw new Error(`App shell stylesheet has an invalid response: ${path}.`);
    }
  } else if (extension === "wasm") {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (contentType !== "application/wasm" || bytes.length < 4
        || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
      throw new Error(`App shell WebAssembly has an invalid response: ${path}.`);
    }
  }
  await cache.put(url, response);
  return content;
}

async function cacheFingerprint(cache) {
  const entries = await cache.keys();
  const parts = [];
  for (const request of entries.sort((left, right) => left.url.localeCompare(right.url))) {
    const response = await cache.match(request);
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    parts.push(`${new URL(request.url).pathname}:${hex}`);
  }
  const source = new TextEncoder().encode(parts.join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheAppShell(rootResponse, { promoteNow = false, skipWaiting = !rootResponse } = {}) {
  const stagedCacheName = `${RELEASE_PREFIX}${Date.now().toString().padStart(13, "0")}-${crypto.randomUUID()}`;
  let releaseCacheName = stagedCacheName;
  const cache = await caches.open(stagedCacheName);
  try {
    const rootUrl = shellUrl("/");
    const root = rootResponse ?? await fetch(rootUrl, { cache: "no-store", redirect: "error" });
    if (!root.ok) throw new Error("Could not fetch the app shell document.");
    const html = await root.clone().text();
    if (!/<html(?:\s|>)/i.test(html)) throw new Error("The app shell document is not valid HTML.");
    await cache.put(rootUrl, root);
    for (const path of APP_SHELL) {
      const content = await fetchAndCache(cache, shellUrl(path), { readText: true });
      if (path.endsWith(".webmanifest")) {
        const manifest = JSON.parse(content);
        if (!manifest || typeof manifest.name !== "string" || typeof manifest.start_url !== "string") {
          throw new Error("The app manifest is missing required fields.");
        }
      } else if (!/<svg(?:\s|>)/i.test(content)) {
        throw new Error("The app icon is not valid SVG.");
      }
    }

    const pending = referencedAssets(html, rootUrl);
    const visited = new Set();
    while (pending.length > 0) {
      const assetUrl = pending.pop();
      if (!assetUrl || visited.has(assetUrl)) continue;
      visited.add(assetUrl);
      const source = await fetchAndCache(cache, assetUrl, {
        readText: /\.(?:js|css)$/.test(new URL(assetUrl).pathname),
      });
      if (source) pending.push(...referencedAssets(source, assetUrl));
    }

    const fingerprint = await cacheFingerprint(cache);
    await cache.put(COMPLETE_KEY, new Response(JSON.stringify({
      releaseCacheName,
      fingerprint,
      assets: [...visited].sort(),
    }), { headers: { "Content-Type": "application/json" } }));
    for (const existingName of await completeReleaseCacheNames()) {
      if (existingName === stagedCacheName) continue;
      const existing = await (await caches.open(existingName)).match(COMPLETE_KEY);
      if (existing && JSON.parse(await existing.text()).fingerprint === fingerprint) {
        await caches.delete(stagedCacheName);
        releaseCacheName = existingName;
        break;
      }
    }
    if (promoteNow) await promoteShell(releaseCacheName);
    else if (skipWaiting) {
      const control = await caches.open(CONTROL_CACHE);
      await control.put(PENDING_KEY, new Response(releaseCacheName));
      await self.skipWaiting();
    }
    return { releaseCacheName, stagedCacheName };
  } catch (error) {
    await caches.delete(stagedCacheName);
    const control = await caches.open(CONTROL_CACHE);
    const pendingResponse = await control.match(PENDING_KEY);
    if (pendingResponse && (await pendingResponse.text()) === releaseCacheName) {
      await control.delete(PENDING_KEY);
    }
    throw error;
  }
}

async function activeShellCacheName() {
  const control = await caches.open(CONTROL_CACHE);
  const active = await control.match(ACTIVE_KEY);
  if (active) {
    const activeName = await active.text();
    if ((await caches.keys()).includes(activeName)
        && await (await caches.open(activeName)).match(COMPLETE_KEY)) return activeName;
  }
  const completeReleases = await completeReleaseCacheNames();
  if (completeReleases.length > 0) {
    await control.put(ACTIVE_KEY, new Response(completeReleases[0]));
    return completeReleases[0];
  }
  return LEGACY_CACHE;
}

async function completeReleaseCacheNames() {
  const names = (await caches.keys()).filter((name) => name.startsWith(RELEASE_PREFIX)).sort().reverse();
  const complete = [];
  for (const name of names) {
    const cache = await caches.open(name);
    if (await cache.match(COMPLETE_KEY)) complete.push(name);
  }
  return complete;
}

async function clientShellCacheName(clientId) {
  if (!clientId) return null;
  const control = await caches.open(CONTROL_CACHE);
  const response = await control.match(`${CLIENT_KEY_PREFIX}${encodeURIComponent(clientId)}`);
  return response ? response.text() : null;
}

async function rememberClientShell(clientId, cacheName) {
  if (!clientId || !cacheName) return;
  const control = await caches.open(CONTROL_CACHE);
  await control.put(`${CLIENT_KEY_PREFIX}${encodeURIComponent(clientId)}`, new Response(cacheName));
}

async function pruneReleaseCaches() {
  const control = await caches.open(CONTROL_CACHE);
  const activeResponse = await control.match(ACTIVE_KEY);
  const activeName = activeResponse ? await activeResponse.text() : null;
  const liveClients = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .map((client) => client.id));
  const retained = new Set((await completeReleaseCacheNames()).slice(0, 2));
  if (activeName) retained.add(activeName);
  for (const request of await control.keys()) {
    if (!request.url.startsWith(CLIENT_KEY_PREFIX)) continue;
    const clientId = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
    if (!liveClients.has(clientId)) {
      await control.delete(request);
      continue;
    }
    const response = await control.match(request);
    if (response) retained.add(await response.text());
  }

  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => (key.startsWith(RELEASE_PREFIX) && !retained.has(key))
      || (key === LEGACY_CACHE && !retained.has(key)))
    .map((key) => caches.delete(key).catch(() => false)));
}

async function preserveLegacyClients() {
  if (!(await caches.keys()).includes(LEGACY_CACHE)) return;
  const legacy = await caches.open(LEGACY_CACHE);
  if (!(await legacy.match(shellUrl("/")))) return;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if (!(await clientShellCacheName(client.id))) await rememberClientShell(client.id, LEGACY_CACHE);
  }
}

async function promoteShell(candidateName, canPromote = () => true) {
  if (!candidateName.startsWith(RELEASE_PREFIX)) throw new Error("Pending app shell cache is invalid.");
  const candidate = await caches.open(candidateName);
  const complete = await candidate.match(COMPLETE_KEY);
  if (!complete) throw new Error("Pending app shell cache is incomplete.");
  if (!canPromote()) throw new Error("A newer app shell navigation superseded this refresh.");

  await preserveLegacyClients();
  // A single Cache.put switches readers to the fully prepared release.
  const control = await caches.open(CONTROL_CACHE);
  await control.put(ACTIVE_KEY, new Response(candidateName));
  const pendingResponse = await control.match(PENDING_KEY);
  if (pendingResponse && (await pendingResponse.text()) === candidateName) await control.delete(PENDING_KEY);
  await pruneReleaseCaches().catch(() => undefined);
}

function refreshShell(rootResponse, generation) {
  const task = refreshQueue.then(async () => {
    if (generation !== latestNavigation) throw new Error("A newer app shell navigation superseded this refresh.");
    const { releaseCacheName, stagedCacheName } = await cacheAppShell(rootResponse, { skipWaiting: false });
    try {
      await promoteShell(releaseCacheName, () => generation === latestNavigation);
    } catch (error) {
      if (stagedCacheName === releaseCacheName) await caches.delete(stagedCacheName);
      throw error;
    }
    return releaseCacheName;
  });
  refreshQueue = task.catch(() => undefined);
  return task;
}

async function promoteCompleteShell() {
  const control = await caches.open(CONTROL_CACHE);
  const pendingResponse = await control.match(PENDING_KEY);
  if (!pendingResponse) return;
  await promoteShell(await pendingResponse.text());
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(promoteCompleteShell().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/@vite")) return;

  if (request.mode === "navigate") {
    const generation = ++latestNavigation;
    const networkResponse = fetch(request);
    const completeResponse = networkResponse.then(async (response) => {
      if (!response.ok) throw new Error("Could not fetch the latest app shell document.");
      const releaseCacheName = await refreshShell(response.clone(), generation);
      return { response, releaseCacheName };
    });
    event.waitUntil(completeResponse.then(() => undefined, () => undefined));
    event.respondWith((async () => {
      let selectedCacheName;
      try {
        const complete = await completeResponse;
        selectedCacheName = complete.releaseCacheName;
        await rememberClientShell(event.clientId, selectedCacheName).catch(() => undefined);
        await rememberClientShell(event.resultingClientId, selectedCacheName).catch(() => undefined);
        return complete.response;
      } catch {
        selectedCacheName = await activeShellCacheName();
        await rememberClientShell(event.clientId, selectedCacheName).catch(() => undefined);
        await rememberClientShell(event.resultingClientId, selectedCacheName).catch(() => undefined);
        const cache = await caches.open(selectedCacheName);
        const cachedRoot = await cache.match(shellUrl("/"));
        if (cachedRoot) return cachedRoot;
        const fallbackName = await activeShellCacheName();
        if (fallbackName !== selectedCacheName) {
          const fallbackRoot = await (await caches.open(fallbackName)).match(shellUrl("/"));
          if (fallbackRoot) return fallbackRoot;
        }
        return Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cacheName = await clientShellCacheName(event.clientId) ?? await activeShellCacheName();
    const cache = await caches.open(cacheName);
    const cacheOptions = url.pathname.startsWith("/assets/")
      ? { ignoreSearch: true, ignoreVary: true }
      : undefined;
    const cached = await cache.match(request, cacheOptions);
    if (cached) return cached;
    if (url.pathname.startsWith("/assets/")) {
      const releaseNames = await completeReleaseCacheNames();
      for (const releaseName of releaseNames) {
        if (releaseName === cacheName) continue;
        const prior = await (await caches.open(releaseName)).match(request, cacheOptions);
        if (prior) return prior;
      }
    }
    try {
      return await fetch(request);
    } catch {
      return Response.error();
    }
  })());
});
