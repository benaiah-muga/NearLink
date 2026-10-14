import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("production service worker keeps the local conversation usable offline and resumes the hub", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "allow" });
  const page = await context.newPage();
  const sentBodies: string[] = [];
  let joinedCount = 0;

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
    const initialCache = await page.evaluate(async () => {
      const cache = await caches.open("nearlink-shell-v1");
      const root = await cache.match("/");
      const assets = await cache.keys();
      return { root: Boolean(root), assets: assets.map((request) => new URL(request.url).pathname) };
    });
    expect(initialCache.root).toBe(true);
    expect(initialCache.assets.some((path) => path.startsWith("/assets/") && path.endsWith(".js"))).toBe(true);
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

    await context.setOffline(true);
    const offlineWorkerResponses: string[] = [];
    page.on("requestfinished", async (request) => {
      const response = await request.response();
      if (response?.fromServiceWorker()) offlineWorkerResponses.push(request.resourceType());
    });
    await page.reload();
    await expect.poll(() => offlineWorkerResponses).toContain("document");
    await expect.poll(() => offlineWorkerResponses).toContain("script");
    await expect.poll(() => offlineWorkerResponses).toContain("stylesheet");
    await expect(page.getByLabel("Your call sign")).toHaveValue("Offline Station");
    await expect(page.getByLabel("Room frequency")).toHaveValue("offline-shell-check");
    const offlineLog = page.getByRole("log", { name: "Messages in offline-shell-check" });
    await expect(offlineLog.getByText(body)).toBeVisible();
    await expect(offlineLog.getByText("Queued on this device")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeEnabled();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Save and join room" }).click();
    await expect.poll(() => joinedCount).toBeGreaterThan(1);
    await expect(page.locator(".connection-status")).toContainText("connected");
    await expect.poll(() => sentBodies.filter((sent) => sent === body).length).toBeGreaterThan(1);
    await expect(log.getByText("Accepted by hub")).toBeVisible();
  } finally {
    await context.close();
  }
});
