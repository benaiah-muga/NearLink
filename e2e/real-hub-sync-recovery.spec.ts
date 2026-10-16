import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

type Packet = Record<string, unknown> & { type?: string; id?: string; syncId?: string; requestId?: string };
type StoredRow = { packet: { id: string; room: string; body: string }; direction: string; delivery: string };

const appUrl = "http://127.0.0.1:4173";
const hubUrl = "ws://127.0.0.1:8000/ws";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function guardLoopback(context: BrowserContext, externalAttempts: string[], beforeCompletion?: (packet: Packet) => Promise<void>) {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isLoopbackUrl(url)) {
      externalAttempts.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", async (route) => {
    const url = route.url();
    if (!isLoopbackUrl(url)) {
      externalAttempts.push(url);
      await route.close();
      return;
    }
    const server = route.connectToServer();
    if (beforeCompletion && url === hubUrl) {
      route.onMessage((message) => server.send(message));
      server.onMessage(async (message) => {
        const packet = parseFrame(message);
        if (packet?.type === "sync_page_complete") await beforeCompletion(packet);
        route.send(message);
      });
    }
  });
}

async function waitForSetupReady(page: Page) {
  const diagnostics = page.locator(".diagnostics-panel");
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible();
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
}

async function openProfile(page: Page, callSign: string, room: string) {
  await page.goto(appUrl);
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill(callSign);
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Hub address").fill(hubUrl);
}

async function joinRoom(page: Page) {
  await page.getByRole("button", { name: "Save and join room" }).click();
  await expect(page.locator(".connection-status")).toContainText("connected", { timeout: 20_000 });
}

async function storedMessages(page: Page, room: string): Promise<StoredRow[]> {
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

async function waitForLocalIdentity(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nearlink-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = await new Promise<{ sender?: string; senderName?: string } | undefined>((resolve, reject) => {
      const request = database.transaction("identity", "readonly").objectStore("identity").get("profile");
      request.onsuccess = () => resolve(request.result as { sender?: string; senderName?: string } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return identity?.sender ? identity : null;
  })).toMatchObject({ sender: expect.any(String) });
}

async function seedAcceptedMessage(page: Page, room: string, id: string, body: string) {
  await page.evaluate(async ({ roomName, messageId, messageBody }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nearlink-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = await new Promise<{ sender: string }>((resolve, reject) => {
      const request = database.transaction("identity", "readonly").objectStore("identity").get("profile");
      request.onsuccess = () => {
        const value = request.result as { sender?: string } | undefined;
        if (!value?.sender) reject(new Error("The local identity was not ready for message seeding."));
        else resolve({ sender: value.sender });
      };
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({
        packet: {
          version: 1,
          type: "message",
          id: messageId,
          room: roomName,
          sender: identity.sender,
          senderName: "Recovery Sender",
          createdAt: new Date().toISOString(),
          body: messageBody,
        },
        direction: "outgoing",
        delivery: "sent",
        transport: "hub",
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { roomName: room, messageId: id, messageBody: body });
}

function parseFrame(payload: string | Buffer): Packet | null {
  if (typeof payload !== "string") return null;
  try { return JSON.parse(payload) as Packet; } catch { return null; }
}

test("real hub sync recovers a saved message across recipient reload without duplicate work", async ({ browser }) => {
  test.setTimeout(120_000);
  expect(isLoopbackUrl(appUrl)).toBe(true);
  expect(isLoopbackUrl(hubUrl)).toBe(true);

  const externalAttempts: string[] = [];
  const room = `sync-e2e-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const messageId = `saved-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const body = "Saved message recovered through hub synchronization";
  const senderContext = await browser.newContext({ baseURL: appUrl });
  const recipientContext = await browser.newContext({ baseURL: appUrl });
  const sender = await senderContext.newPage();
  const recipient = await recipientContext.newPage();
  let completionCommittedBeforeRelease = false;
  await guardLoopback(senderContext, externalAttempts);
  await guardLoopback(recipientContext, externalAttempts, async (packet) => {
    const ids = packet.messageIds as string[] | undefined;
    if (!ids?.includes(messageId)) return;
    const rows = await storedMessages(recipient, room);
    completionCommittedBeforeRelease = rows.filter((row) => row.packet.id === messageId).length === 1;
  });
  const senderSent: Packet[] = [];
  const senderFrames: Packet[] = [];
  const recipientSent: Packet[] = [];
  const recipientCompletionEvidence: Array<{ packet: Packet; rows: StoredRow[] }> = [];

  sender.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const packet = parseFrame(payload);
      if (packet) senderSent.push(packet);
    });
    socket.on("framereceived", ({ payload }) => {
      const packet = parseFrame(payload);
      if (packet) senderFrames.push(packet);
    });
  });
  recipient.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const packet = parseFrame(payload);
      if (packet) recipientSent.push(packet);
    });
    socket.on("framereceived", ({ payload }) => {
      const packet = parseFrame(payload);
      if (packet?.type === "sync_page_complete") {
        void storedMessages(recipient, room).then((rows) => recipientCompletionEvidence.push({ packet, rows }));
      }
    });
  });

  try {
    await openProfile(sender, "Recovery Sender", room);
    await waitForLocalIdentity(sender);
    await seedAcceptedMessage(sender, room, messageId, body);
    await joinRoom(sender);
    await expect.poll(() => senderFrames.filter((packet) => packet.type === "joined").length).toBe(1);
    await expect.poll(() => senderSent.some((packet) => packet.type === "sync_inventory_page")).toBe(true);

    await openProfile(recipient, "Recovery Recipient", room);
    await joinRoom(recipient);
    await expect.poll(() => recipientSent.some((packet) => packet.type === "sync_missing_request" && (packet.messageIds as string[] | undefined)?.includes(messageId)), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await storedMessages(recipient, room)).filter((row) => row.packet.id === messageId).length, { timeout: 20_000 }).toBe(1);
    const firstRecipientInventory = recipientSent.find((packet) => packet.type === "sync_inventory_page");
    expect(firstRecipientInventory?.syncId).toEqual(expect.any(String));
    const firstSyncId = firstRecipientInventory?.syncId;
    const request = recipientSent.find((packet) => packet.type === "sync_missing_request" && (packet.messageIds as string[] | undefined)?.includes(messageId));
    expect(request).toBeTruthy();
    await expect.poll(() => recipientCompletionEvidence.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const completion = recipientCompletionEvidence.find((item) => (item.packet.messageIds as string[] | undefined)?.includes(messageId));
    expect(completion).toBeTruthy();
    expect(completion!.rows.filter((row) => row.packet.id === messageId)).toHaveLength(1);
    expect(completion!.rows.find((row) => row.packet.id === messageId)).toMatchObject({ direction: "incoming", delivery: "sent" });
    expect(completionCommittedBeforeRelease).toBe(true);

    const firstRows = await storedMessages(recipient, room);
    expect(firstRows.filter((row) => row.packet.id === messageId)).toHaveLength(1);
    await recipient.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(recipient.locator(".connection-status")).not.toContainText("connected");
    await recipient.reload();
    await waitForSetupReady(recipient);
    await recipient.getByLabel("Your call sign").fill("Recovery Recipient");
    await recipient.getByLabel("Room frequency").fill(room);
    await recipient.getByLabel("Hub address").fill(hubUrl);
    await joinRoom(recipient);

    await expect.poll(() => recipientSent.some((packet) => packet.type === "sync_inventory_page" && packet.syncId !== firstSyncId), { timeout: 20_000 }).toBe(true);
    const inventories = recipientSent.filter((packet) => packet.type === "sync_inventory_page");
    const recoveredInventory = inventories.findLast((packet) => packet.type === "sync_inventory_page" && packet.syncId !== firstSyncId)!;
    expect(recoveredInventory.syncId).not.toBe(firstSyncId);
    expect(recoveredInventory.messageIds).toContain(messageId);
    await expect(recipient.locator(".sync-status")).toContainText("The peer inventory contains no message IDs missing from this local snapshot.", { timeout: 20_000 });
    await expect.poll(() => recipientSent.filter((packet) => packet.type === "sync_missing_request" && (packet.messageIds as string[] | undefined)?.includes(messageId)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await storedMessages(recipient, room)).filter((row) => row.packet.id === messageId).length, { timeout: 20_000 }).toBe(1);
    expect(externalAttempts).toEqual([]);
  } finally {
    await Promise.all([senderContext.close(), recipientContext.close()]);
  }
});
