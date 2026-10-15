import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

type Packet = { type?: string; id?: string };
type StoredRow = {
  packet: { id: string; room: string; body: string };
  direction: string;
  delivery: string;
};

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackHttpOrWebSocket(value: string): boolean {
  try {
    const url = new URL(value);
    const localProtocol = ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
    return localProtocol && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function guardContext(context: BrowserContext, externalAttempts: string[]): Promise<void> {
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
  await context.routeWebSocket("**/*", async (route) => {
    const url = route.url();
    if (!isLoopbackHttpOrWebSocket(url)) {
      externalAttempts.push(url);
      await route.close();
      return;
    }
    await route.connectToServer();
  });
}

function observePackets(page: Page) {
  const sentMessages: Packet[] = [];
  const receivedAcks: string[] = [];
  let closedSockets = 0;

  page.on("websocket", (socket) => {
    socket.on("close", () => { closedSockets += 1; });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const packet = JSON.parse(payload) as Packet;
        if (packet.type === "message") sentMessages.push(packet);
      } catch {
        // Record only frames that parse as protocol JSON.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const packet = JSON.parse(payload) as Packet;
        if (packet.type === "ack" && packet.id) receivedAcks.push(packet.id);
      } catch {
        // Record only frames that parse as protocol JSON.
      }
    });
  });

  return { sentMessages, receivedAcks, get closedSockets() { return closedSockets; } };
}

async function waitForSetupReady(page: Page): Promise<void> {
  const diagnostics = page.locator(".diagnostics-panel");
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
}

async function joinHub(page: Page, name: string, room: string): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill(name);
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
  await page.getByRole("button", { name: "Save and join room" }).click();
  await expect(page.locator(".connection-status")).toHaveClass(/status-online/, { timeout: 30_000 });
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

async function sendAndWaitForHubAcceptance(page: Page, room: string, body: string, observed: ReturnType<typeof observePackets>): Promise<string> {
  const previousMessages = observed.sentMessages.length;
  await page.getByRole("textbox", { name: "Write a message" }).fill(body);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => observed.sentMessages.length, { timeout: 20_000 }).toBeGreaterThan(previousMessages);
  const id = observed.sentMessages.at(-1)?.id;
  expect(id).toBeTruthy();
  await expect.poll(() => observed.receivedAcks, { timeout: 20_000 }).toContain(id);
  const senderRow = (await rowsForRoom(page, room)).find((row) => row.packet.id === id);
  expect(senderRow).toMatchObject({ direction: "outgoing", delivery: "sent", packet: { body } });
  await expect(page.getByRole("log").getByText(body, { exact: true }).locator("..")).toContainText("Accepted by hub");
  return id!;
}

test("production local hub conversation works across two browser contexts", async ({ browser }) => {
  test.setTimeout(120_000);
  const externalAttempts: string[] = [];
  const room = `compat-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const firstBody = "Persisted before the recipient joins";
  const secondBody = "Replayed after recipient reconnect";
  const senderContext = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" });
  const recipientContext = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" });
  await guardContext(senderContext, externalAttempts);
  await guardContext(recipientContext, externalAttempts);
  const sender = await senderContext.newPage();
  const recipient = await recipientContext.newPage();
  const senderObserved = observePackets(sender);
  const recipientObserved = observePackets(recipient);

  try {
    await recipient.goto("/", { waitUntil: "domcontentloaded" });
    await waitForSetupReady(recipient);
    await joinHub(sender, "Compatibility Sender", room);
    const senderMessageId = await sendAndWaitForHubAcceptance(sender, room, firstBody, senderObserved);
    expect((await rowsForRoom(sender, room)).filter((row) => row.packet.id === senderMessageId)).toHaveLength(1);
    expect(await rowsForRoom(recipient, room)).toHaveLength(0);

    await joinHub(recipient, "Compatibility Recipient", room);
    const recipientLog = recipient.getByRole("log", { name: `Messages in ${room}` });
    await expect(recipientLog.getByText(firstBody, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await rowsForRoom(recipient, room)).length, { timeout: 20_000 }).toBe(1);
    expect(await rowsForRoom(recipient, room)).toMatchObject([
      { direction: "incoming", packet: { id: senderMessageId, body: firstBody, room } },
    ]);

    const closedBeforeDisconnect = recipientObserved.closedSockets;
    await recipient.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(recipient.locator(".connection-status")).not.toContainText("connected");
    await expect.poll(() => recipientObserved.closedSockets, { timeout: 20_000 }).toBeGreaterThan(closedBeforeDisconnect);

    const secondMessageId = await sendAndWaitForHubAcceptance(sender, room, secondBody, senderObserved);
    expect(await rowsForRoom(recipient, room)).toHaveLength(1);

    await recipient.getByRole("button", { name: "Connect radio" }).click();
    await expect(recipient.locator(".connection-status")).toHaveClass(/status-online/, { timeout: 30_000 });
    await expect(recipientLog.getByText(secondBody, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await rowsForRoom(recipient, room)).length, { timeout: 20_000 }).toBe(2);
    expect((await rowsForRoom(recipient, room)).map((row) => row.packet.id).sort()).toEqual([senderMessageId, secondMessageId].sort());

    const closedBeforeReplay = recipientObserved.closedSockets;
    await recipient.getByRole("button", { name: "Disconnect radio" }).click();
    await expect.poll(() => recipientObserved.closedSockets, { timeout: 20_000 }).toBeGreaterThan(closedBeforeReplay);
    await recipient.getByRole("button", { name: "Connect radio" }).click();
    await expect(recipient.locator(".connection-status")).toHaveClass(/status-online/, { timeout: 30_000 });
    await expect(recipientLog.getByText(firstBody, { exact: true })).toHaveCount(1);
    await expect(recipientLog.getByText(secondBody, { exact: true })).toHaveCount(1);
    const finalRows = await rowsForRoom(recipient, room);
    expect(finalRows).toHaveLength(2);
    expect(new Set(finalRows.map((row) => row.packet.id))).toEqual(new Set([senderMessageId, secondMessageId]));
  } finally {
    await Promise.all([senderContext.close(), recipientContext.close()]);
  }

  expect(externalAttempts).toEqual([]);
});
