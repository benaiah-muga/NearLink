import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, request as sendHttpRequest } from "node:http";

test.use({ serviceWorkers: "allow" });

type StoredRow = {
  packet: { id: string; room: string; body: string };
  direction: string;
  delivery: string;
};

async function startPreviewProxy() {
  let unavailable = false;
  const unavailableRequests: Array<{ path: string; status: number }> = [];
  const server = createServer((incoming, outgoing) => {
    if (unavailable) {
      const path = incoming.url ?? "/";
      unavailableRequests.push({ path, status: 503 });
      outgoing.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      outgoing.end("The NearLink app origin is temporarily unavailable.");
      return;
    }

    const upstream = sendHttpRequest({
      hostname: "127.0.0.1",
      port: 4173,
      path: incoming.url ?? "/",
      method: incoming.method,
      headers: { ...incoming.headers, host: "127.0.0.1:4173" },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local production preview proxy did not bind a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    unavailableRequests,
    setUnavailable(value: boolean) { unavailable = value; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackHttpOrWebSocket(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function guardHttp(
  context: BrowserContext,
  externalAttempts: string[],
): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const protocol = new URL(url).protocol;
    if (["http:", "https:", "ws:", "wss:"].includes(protocol) && !isLoopbackHttpOrWebSocket(url)) {
      externalAttempts.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function guardWebSockets(context: BrowserContext, externalAttempts: string[]): Promise<void> {
  await context.routeWebSocket("**/*", async (route) => {
    const url = route.url();
    if (!isLoopbackHttpOrWebSocket(url)) {
      externalAttempts.push(url);
      await route.close();
      return;
    }
    const server = await route.connectToServer();
    route.onMessage((message) => server.send(message));
    server.onMessage((message) => route.send(message));
    route.onClose((details) => {
      if (details) server.close(details);
      else server.close();
    });
    server.onClose((details) => {
      if (details) route.close(details);
      else route.close();
    });
  });
}

async function waitForSetupReady(page: Page): Promise<void> {
  const diagnostics = page.locator(".diagnostics-panel");
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
}

async function rowsForRoom(page: Page, room: string): Promise<StoredRow[]> {
  return page.evaluate(async (roomName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nearlink-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<StoredRow[]>((resolve, reject) => {
      const request = database.transaction("messages", "readonly").objectStore("messages").getAll();
      request.onsuccess = () => resolve(request.result as StoredRow[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return rows.filter((row) => row.packet.room === roomName);
  }, room);
}

async function inspectActiveShell(page: Page) {
  return page.evaluate(async () => {
    const origin = location.origin;
    const control = await caches.open("nearlink-shell-control-v1");
    const active = await control.match(new URL("/__nearlink_shell__/active", origin).href);
    const cacheName = active ? await active.text() : null;
    const cache = cacheName ? await caches.open(cacheName) : null;
    const completeResponse = cache ? await cache.match(new URL("/__nearlink_shell__/complete", origin).href) : null;
    const complete = completeResponse ? await completeResponse.json() as { assets?: string[] } : null;
    const paths = cache ? (await cache.keys()).map((request) => new URL(request.url).pathname) : [];
    const root = Boolean(cache && await cache.match(new URL("/", origin).href));
    const appJavaScript = paths.some((path) => path.startsWith("/assets/") && path.endsWith(".js"));
    const wasmLoader = paths.some((path) => /\/nearlink_protocol_wasm-[^/]+\.js$/.test(path));
    const wasmBinary = paths.some((path) => path.startsWith("/assets/") && path.endsWith(".wasm"));
    const css = paths.some((path) => path.startsWith("/assets/") && path.endsWith(".css"));
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      controlled: Boolean(navigator.serviceWorker.controller),
      activeWorker: registration?.active?.state ?? null,
      cacheName,
      complete: Boolean(complete && complete.assets?.length),
      root,
      appJavaScript,
      wasmLoader,
      wasmBinary,
      css,
      paths,
    };
  });
}

test("production service worker serves the cached shell when the app origin is unavailable", async ({ browser }) => {
  test.setTimeout(120_000);
  const proxy = await startPreviewProxy();
  let context: BrowserContext | undefined;
  const externalAttempts: string[] = [];
  const room = `offline-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const body = "Saved before the app origin was unavailable";

  try {
    context = await browser.newContext({ baseURL: proxy.origin, serviceWorkers: "allow" });
    await guardHttp(context, externalAttempts);
    await guardWebSockets(context, externalAttempts);
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForSetupReady(page);
    await expect.poll(async () => {
      await page.evaluate(() => navigator.serviceWorker.ready);
      return inspectActiveShell(page);
    }, { timeout: 20_000, message: "A complete active CacheStorage release should control the app." }).toMatchObject({
      controlled: true,
      activeWorker: "activated",
      complete: true,
      root: true,
      appJavaScript: true,
      wasmLoader: true,
      wasmBinary: true,
      css: true,
    });

    await page.getByLabel("Your call sign").fill("Offline Station");
    await page.getByLabel("Room frequency").fill(room);
    await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect(page.getByRole("button", { name: "Station settings saved" })).toBeVisible();
    await expect(page.locator(".connection-status")).toHaveClass(/status-online/, { timeout: 30_000 });

    await page.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(page.locator(".connection-status")).not.toContainText("connected");
    await page.getByRole("textbox", { name: "Write a message" }).fill(body);
    await page.getByRole("button", { name: "Send message" }).click();
    const log = page.getByRole("log", { name: `Messages in ${room}` });
    await expect(log.getByText(body, { exact: true })).toBeVisible();
    await expect(log.getByText("Queued on this device")).toBeVisible();
    await expect.poll(async () => rowsForRoom(page, room)).toMatchObject([
      { direction: "outgoing", delivery: "queued", packet: { room, body } },
    ]);

    proxy.setUnavailable(true);
    const offlineNavigation = await page.reload({ waitUntil: "domcontentloaded" });
    expect(offlineNavigation?.fromServiceWorker(), "The cached navigation must come from the registered service worker.").toBe(true);
    expect(proxy.unavailableRequests).toContainEqual({ path: "/", status: 503 });
    await expect(page.getByLabel("Your call sign")).toHaveValue("Offline Station");
    await expect(page.getByLabel("Room frequency")).toHaveValue(room);
    await waitForSetupReady(page);
    await expect(page.getByRole("log", { name: `Messages in ${room}` }).getByText(body, { exact: true })).toBeVisible();
    await expect(page.getByRole("log", { name: `Messages in ${room}` }).getByText("Queued on this device")).toBeVisible();
    const offlineRows = await rowsForRoom(page, room);
    expect(offlineRows).toHaveLength(1);
    expect(offlineRows[0]).toMatchObject({ direction: "outgoing", delivery: "queued", packet: { room, body } });

    proxy.setUnavailable(false);
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect(page.locator(".connection-status")).toHaveClass(/status-online/, { timeout: 30_000 });
    const acceptedMessage = page.getByRole("log", { name: `Messages in ${room}` }).getByText(body, { exact: true });
    await expect(acceptedMessage.locator("..")).toContainText("Accepted by hub", { timeout: 30_000 });
    const finalRows = await rowsForRoom(page, room);
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]).toMatchObject({ direction: "outgoing", delivery: "sent", packet: { room, body } });
    expect(await acceptedMessage.count()).toBe(1);
    expect(externalAttempts).toEqual([]);
  } finally {
    try {
      await context?.close();
    } finally {
      await proxy.close();
    }
  }
});
