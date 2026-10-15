import { expect, test, type Browser } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

let nextTargetMessageId = 1;

async function sendToTarget(
  browserSession: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>,
  targetSessionId: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const id = nextTargetMessageId++;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      browserSession.off("Target.receivedMessageFromTarget", onMessage);
      reject(new Error(`Timed out waiting for CDP command ${method} on the service worker.`));
    }, 5_000);
    const onMessage = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== targetSessionId) return;
      let response: { id?: number; error?: { message?: string } };
      try {
        response = JSON.parse(event.message) as { id?: number; error?: { message?: string } };
      } catch {
        return;
      }
      if (response.id !== id) return;
      clearTimeout(timeout);
      browserSession.off("Target.receivedMessageFromTarget", onMessage);
      if (response.error) reject(new Error(response.error.message ?? `CDP command ${method} failed`));
      else resolve();
    };
    browserSession.on("Target.receivedMessageFromTarget", onMessage);
    browserSession.send("Target.sendMessageToTarget", {
      sessionId: targetSessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch((error: unknown) => {
      clearTimeout(timeout);
      browserSession.off("Target.receivedMessageFromTarget", onMessage);
      reject(error);
    });
  });
}

test("production service worker keeps the local conversation usable offline and resumes the hub", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "allow" });
  const page = await context.newPage();
  const sentBodies: string[] = [];
  let joinedCount = 0;
  let browserCdp: Awaited<ReturnType<Browser["newBrowserCDPSession"]>> | undefined;
  let workerSessionId: string | undefined;

  await page.routeWebSocket("ws://127.0.0.1:8000/ws", (socket) => {
    socket.onMessage((raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.type === "join") {
        joinedCount += 1;
        socket.send(JSON.stringify({ version: 1, type: "joined", room: packet.room, peers: 1 }));
      }
      if (packet.type === "message") {
        sentBodies.push(packet.body);
        if (joinedCount > 1) socket.send(JSON.stringify({ version: 1, type: "ack", id: packet.id }));
      }
    });
  });

  try {
    await page.goto("/");
    await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    const inspectInitialCache = async () => page.evaluate(async () => {
      const control = await caches.open("nearlink-shell-control-v1");
      const active = await control.match(new URL("/__nearlink_shell__/active", location.origin).href);
      const pending = await control.match(new URL("/__nearlink_shell__/pending", location.origin).href);
      const cacheName = active ? await active.text() : null;
      const cache = cacheName ? await caches.open(cacheName) : null;
      const assets = cache ? await cache.keys() : [];
      const paths = assets.map((request) => new URL(request.url).pathname);
      const complete = Boolean(cache && await cache.match(new URL("/__nearlink_shell__/complete", location.origin).href));
      const registration = await navigator.serviceWorker.getRegistration();
      const cacheInventory = await caches.keys();
      return {
        pointer: Boolean(active),
        cacheName,
        complete,
        root: Boolean(cache && await cache.match(new URL("/", location.origin).href)),
        representativeAssets: {
          js: paths.some((path) => path.startsWith("/assets/") && path.endsWith(".js")),
          wasm: paths.some((path) => /\/nearlink_protocol_wasm-[^/]+\.js$/.test(path)),
          css: paths.some((path) => path.startsWith("/assets/") && path.endsWith(".css")),
        },
        assets: paths,
        pending: pending ? await pending.text() : null,
        cacheInventory,
        workerStates: {
          installing: registration?.installing?.state ?? null,
          waiting: registration?.waiting?.state ?? null,
          active: registration?.active?.state ?? null,
        },
      };
    });
    await expect.poll(inspectInitialCache, {
      timeout: 15_000,
      message: "The service worker should promote a complete offline shell before the test continues.",
    }).toMatchObject({
      pointer: true,
      complete: true,
      root: true,
      representativeAssets: { js: true, wasm: true, css: true },
      workerStates: { active: "activated" },
    });
    const initialCache = await inspectInitialCache();
    expect(initialCache.root, JSON.stringify(initialCache)).toBe(true);
    expect(initialCache.assets.some((path) => path.startsWith("/assets/") && path.endsWith(".js"))).toBe(true);
    expect(initialCache.assets.some((path) => /\/nearlink_protocol_wasm-[^/]+\.js$/.test(path))).toBe(true);
    expect(initialCache.assets.some((path) => path.startsWith("/assets/") && path.endsWith(".css"))).toBe(true);

    const diagnostics = page.locator(".diagnostics-panel");
    if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await diagnostics.locator("summary").click();
    }
    await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible();
    await page.getByLabel("Your call sign").fill("Offline Station");
    await page.getByLabel("Room frequency").fill("offline-shell-check");
    await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect(page.getByRole("button", { name: "Station settings saved" })).toBeVisible();
    await expect.poll(() => joinedCount).toBe(1);

    const body = "Saved before an offline reload";
    await page.getByRole("textbox", { name: "Write a message" }).fill(body);
    await page.getByRole("button", { name: "Send message" }).click();
    const log = page.getByRole("log", { name: "Messages in offline-shell-check" });
    await expect(log.getByText(body)).toBeVisible();
    await expect(log.getByText("Queued on this device")).toBeVisible();
    await expect.poll(() => sentBodies).toContain(body);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    browserCdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send("Target.getTargets");
    const workerTarget = targetInfos.find((target) => target.type === "service_worker" && target.url === "http://127.0.0.1:4173/sw.js");
    expect(workerTarget, "the production service worker target should be active").toBeDefined();
    const attachedWorker = await browserCdp.send("Target.attachToTarget", {
      targetId: workerTarget!.targetId,
      flatten: false,
    });
    workerSessionId = attachedWorker.sessionId;
    await sendToTarget(browserCdp, workerSessionId, "Network.enable");
    await cdp.send("Network.emulateNetworkConditionsByRule", {
      offline: true,
      matchedNetworkConditions: [{
        urlPattern: "",
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      }],
      emulateOfflineServiceWorker: true,
    });
    await cdp.send("Network.overrideNetworkState", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.emulateNetworkConditionsByRule", {
      offline: true,
      matchedNetworkConditions: [{
        urlPattern: "",
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      }],
      emulateOfflineServiceWorker: true,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.overrideNetworkState", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.setBlockedURLs", { urls: ["*"] });
    const offlineCacheResponses: Array<{ type: string; url: string; source: string }> = [];
    cdp.on("Network.responseReceived", ({ type, response }) => {
      if (response.fromServiceWorker) {
        offlineCacheResponses.push({
          type,
          url: response.url,
          source: response.serviceWorkerResponseSource ?? "unknown",
        });
      }
    });
    await page.reload();
    await expect.poll(() => offlineCacheResponses.map((response) => `${response.type} ${new URL(response.url).pathname} ${response.source}`))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^Document \/ cache-storage$/i),
        expect.stringMatching(/^Script \/assets\/.* cache-storage$/i),
        expect.stringMatching(/^Script \/assets\/nearlink_protocol_wasm-.* cache-storage$/i),
        expect.stringMatching(/^Stylesheet \/assets\/.* cache-storage$/i),
      ]));
    const offlineDiagnostics = page.locator(".diagnostics-panel");
    if (!(await offlineDiagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await offlineDiagnostics.locator("summary").click();
    }
    await expect(offlineDiagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible();
    await expect(page.getByLabel("Your call sign")).toHaveValue("Offline Station");
    await expect(page.getByLabel("Room frequency")).toHaveValue("offline-shell-check");
    const offlineLog = page.getByRole("log", { name: "Messages in offline-shell-check" });
    await expect(offlineLog.getByText(body)).toBeVisible();
    await expect(offlineLog.getByText("Queued on this device")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeEnabled();

    await cdp.send("Network.emulateNetworkConditionsByRule", {
      offline: false,
      matchedNetworkConditions: [{
        urlPattern: "",
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "wifi",
      }],
      emulateOfflineServiceWorker: false,
    });
    await cdp.send("Network.overrideNetworkState", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.emulateNetworkConditionsByRule", {
      offline: false,
      matchedNetworkConditions: [{
        urlPattern: "",
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "wifi",
      }],
      emulateOfflineServiceWorker: false,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.overrideNetworkState", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await sendToTarget(browserCdp, workerSessionId, "Network.setBlockedURLs", { urls: [] });
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect.poll(() => joinedCount).toBeGreaterThan(1);
    await expect(page.locator(".connection-status")).toContainText("connected");
    await expect.poll(() => sentBodies.filter((sent) => sent === body).length).toBeGreaterThan(1);
    await expect(log.getByText("Accepted by hub")).toBeVisible();
  } finally {
    if (browserCdp) {
      if (workerSessionId) {
        try {
          await sendToTarget(browserCdp, workerSessionId, "Network.emulateNetworkConditionsByRule", {
            offline: false,
            matchedNetworkConditions: [{
              urlPattern: "",
              offline: false,
              latency: 0,
              downloadThroughput: -1,
              uploadThroughput: -1,
              connectionType: "wifi",
            }],
            emulateOfflineServiceWorker: false,
          });
        } catch {
          // Closing the isolated context can invalidate the worker target first.
        }
      }
      try {
        await browserCdp.detach();
      } catch {
        // The browser can close the CDP target after a timed-out assertion.
      }
    }
    await context.close();
  }
});
