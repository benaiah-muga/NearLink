import { expect, test } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function storedRoomMessages(page: import("@playwright/test").Page, room: string) {
  return page.evaluate(async (roomName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("nearlink-local");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const messages = await new Promise<Array<{
      packet: { id: string; room: string; body: string };
      direction: string;
      delivery: string;
    }>>((resolve, reject) => {
      const read = database.transaction("messages", "readonly").objectStore("messages").getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return messages.filter((message) => message.packet.room === roomName);
  }, room);
}

test("serves the production shell and required PWA assets from the extracted archive", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/NearLink/);
  await expect(page.locator("#root")).not.toBeEmpty();

  const shell = await page.locator("script[type='module'][src]").getAttribute("src");
  expect(shell).toBeTruthy();
  expect((await request.get(shell!)).status()).toBe(200);

  for (const asset of ["/manifest.webmanifest", "/sw.js", "/icon.svg"]) {
    const assetResponse = await request.get(asset);
    expect(assetResponse.status(), asset).toBe(200);
    expect(await assetResponse.body()).not.toHaveLength(0);
  }
  await page.waitForFunction(() => {
    const paths = performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname);
    return paths.some((path) => path.startsWith("/assets/") && path.endsWith(".css"))
      && paths.some((path) => path.startsWith("/assets/") && path.endsWith(".js"))
      && paths.some((path) => /\/assets\/nearlink_protocol_wasm-[^/]+\.js$/.test(path))
      && paths.some((path) => path.endsWith(".wasm"));
  });
  const loadedAssets = await page.evaluate(() => [...new Set(performance.getEntriesByType("resource")
    .map((entry) => new URL(entry.name).pathname)
    .filter((pathname) => pathname.startsWith("/assets/")))]);
  expect(loadedAssets.some((asset) => asset.endsWith(".css"))).toBe(true);
  expect(loadedAssets.some((asset) => asset.endsWith(".js"))).toBe(true);
  expect(loadedAssets.some((asset) => /\/assets\/nearlink_protocol_wasm-[^/]+\.js$/.test(asset))).toBe(true);
  expect(loadedAssets.some((asset) => asset.endsWith(".wasm"))).toBe(true);
  for (const asset of loadedAssets) expect((await request.get(asset)).status(), asset).toBe(200);
});

test("persists profile and queued message through a 503 package origin, then accepts it once via the local hub", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4174", serviceWorkers: "allow" });
  const page = await context.newPage();
  const externalRequests: string[] = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isLoopback(url)) {
      externalRequests.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", async (route) => {
    const url = route.url();
    if (!isLoopback(url)) {
      externalRequests.push(url);
      await route.close();
      return;
    }
    await route.connectToServer();
  });
  const sentPackets: Array<{ id: string; body: string }> = [];
  const ackIds: string[] = [];
  const cdp = await context.newCDPSession(page);
  const serviceWorkerResponses: Array<{ url: string; source: string; status: number }> = [];
  cdp.on("Network.responseReceived", ({ response, type }) => {
    if (response.fromServiceWorker && type === "Document") {
      serviceWorkerResponses.push({
        url: response.url,
        source: response.serviceWorkerResponseSource ?? "unknown",
        status: response.status,
      });
    }
  });
  await cdp.send("Network.enable");
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const packet = JSON.parse(payload) as { type?: string; id?: string; body?: string };
        if (packet.type === "message" && packet.id && packet.body) sentPackets.push({ id: packet.id, body: packet.body });
      } catch {
        // Ignore unrelated WebSocket frames.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const packet = JSON.parse(payload) as { type?: string; id?: string };
        if (packet.type === "ack" && packet.id) ackIds.push(packet.id);
      } catch {
        // Ignore unrelated WebSocket frames.
      }
    });
  });

  try {
    await page.goto("/");
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
    const diagnostics = page.locator(".diagnostics-panel");
    if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await diagnostics.locator("summary").click();
    }
    await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible({ timeout: 30_000 });

    const room = `package-${Date.now()}`;
    const body = "Keep this queued through a package-origin outage";
    await page.getByLabel("Your call sign").fill("Packaged Station");
    await page.getByLabel("Room frequency").fill(room);
    await page.getByLabel("Hub address").fill("ws://127.0.0.1:1/ws");
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect(page.getByRole("button", { name: "Station settings saved" })).toBeVisible();
    await page.getByRole("textbox", { name: "Write a message" }).fill(body);
    await page.getByRole("button", { name: "Send message" }).click();
    const log = page.getByRole("log", { name: `Messages in ${room}` });
    await expect(log.getByText(body)).toBeVisible();
    await expect(log.getByText("Queued on this device")).toBeVisible();
    await expect.poll(async () => (await storedRoomMessages(page, room)).length).toBe(1);
    const queuedRows = await storedRoomMessages(page, room);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]).toMatchObject({ packet: { body }, direction: "outgoing", delivery: "queued" });
    const queuedId = queuedRows[0].packet.id;

    expect((await request.post("/__test__/origin-unavailable")).status()).toBe(204);
    expect((await request.get("/")).status()).toBe(503);
    const fallback = await page.reload();
    expect(fallback?.status()).toBe(200);
    await expect.poll(() => serviceWorkerResponses, { timeout: 10_000 }).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:4174/",
      source: "cache-storage",
      status: 200,
    }));
    await expect(page.getByLabel("Your call sign")).toHaveValue("Packaged Station");
    await expect(page.getByLabel("Room frequency")).toHaveValue(room);
    const fallbackLog = page.getByRole("log", { name: `Messages in ${room}` });
    await expect(fallbackLog.getByText(body)).toBeVisible();
    await expect(fallbackLog.getByText("Queued on this device")).toBeVisible();
    const fallbackRows = await storedRoomMessages(page, room);
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0]).toMatchObject({ packet: { id: queuedId, body }, direction: "outgoing", delivery: "queued" });

    expect((await request.post("/__test__/origin-available")).status()).toBe(204);
    expect((await request.get("/")).status()).toBe(200);
    await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect(page.locator(".connection-status")).toContainText("connected", { timeout: 20_000 });
    await expect(fallbackLog.getByText("Accepted by hub")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sentPackets.filter((packet) => packet.body === body).length, { timeout: 20_000 }).toBe(1);
    const accepted = sentPackets.filter((packet) => packet.body === body);
    expect(accepted).toHaveLength(1);
    await expect.poll(() => ackIds.filter((id) => id === accepted[0].id), { timeout: 20_000 }).toHaveLength(1);
    expect(ackIds.filter((id) => id === accepted[0].id)).toHaveLength(1);
    expect(accepted[0].id).toBe(queuedId);
    await expect(fallbackLog.getByText(body)).toHaveCount(1);
    await expect.poll(async () => {
      const rows = await storedRoomMessages(page, room);
      return rows.filter((row) => row.packet.id === queuedId && row.delivery === "sent").length;
    }, { timeout: 10_000 }).toBe(1);
    const sentRows = await storedRoomMessages(page, room);
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0]).toMatchObject({ packet: { id: queuedId, body }, direction: "outgoing", delivery: "sent", transport: "hub" });
    expect(externalRequests).toEqual([]);
  } finally {
    await request.post("/__test__/origin-available").catch(() => undefined);
    await context.close();
  }
});
