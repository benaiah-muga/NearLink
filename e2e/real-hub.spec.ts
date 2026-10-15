import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

type HubPacket = Record<string, unknown> & { type?: string; id?: string };

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function guardContext(context: BrowserContext, externalAttempts: string[]) {
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
    await route.connectToServer();
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

async function configureAndJoin(page: Page, name: string, room: string) {
  await page.goto("/");
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill(name);
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
  await page.getByRole("button", { name: "Save and join room" }).click();
  await expect(page.locator(".connection-status")).toContainText("connected");
}

async function storedMessages(page: Page, room: string) {
  return page.evaluate(async (roomName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nearlink-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const messages = await new Promise<Array<{ packet: { id: string; room: string; body: string }; direction: string; delivery: string }>>((resolve, reject) => {
      const request = database.transaction("messages", "readonly").objectStore("messages").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return messages.filter((item) => item.packet.room === roomName);
  }, room);
}

async function seedRetainedHistory(room: string) {
  const seedUrl = "ws://127.0.0.1:8000/ws";
  expect(isLoopbackUrl(seedUrl)).toBe(true);
  const socket = new WebSocket(seedUrl);
  const sender = `seed-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const seedIds = Array.from({ length: 101 }, (_, index) => `history-seed-${String(index).padStart(3, "0")}`);
  let joined = false;
  const pendingAcks = new Map<string, () => void>();
  const packets: HubPacket[] = [];
  socket.addEventListener("message", (event) => {
    let packet: HubPacket;
    try {
      packet = JSON.parse(String(event.data)) as HubPacket;
    } catch {
      return;
    }
    packets.push(packet);
    if (packet.type === "joined") joined = true;
    if (packet.type === "ack" && packet.id) pendingAcks.get(packet.id)?.();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("The local hub did not join the history seeder.")), 5_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ version: 1, type: "join", room, sender, senderName: "History Seed" }));
        const poll = setInterval(() => {
          if (!joined) return;
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }, 5);
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(deadline);
        reject(new Error("The history seeder could not connect to the loopback hub."));
      }, { once: true });
    });
    for (const [index, id] of seedIds.entries()) {
      const acknowledged = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingAcks.delete(id);
          reject(new Error(`The local hub did not acknowledge seeded message ${index}.`));
        }, 5_000);
        pendingAcks.set(id, () => {
          clearTimeout(timeout);
          pendingAcks.delete(id);
          resolve();
        });
      });
      socket.send(JSON.stringify({
        version: 1,
        type: "message",
        id,
        room,
        sender,
        senderName: "History Seed",
        createdAt: new Date(Date.now() + index).toISOString(),
        body: `Retained history item ${index}`,
      }));
      await acknowledged;
    }
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
      socket.close();
      await closed;
    }
  }
  expect(packets.filter((packet) => packet.type === "ack")).toHaveLength(seedIds.length);
  return { seedIds, seedBodies: seedIds.map((_, index) => `Retained history item ${index}`) };
}

test("real local hub accepts, replays, persists, and pages a two-client conversation", async ({ browser }) => {
  test.setTimeout(60_000);
  const externalAttempts: string[] = [];
  const room = `e2e-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const bodies = [
    "Hub acceptance before recipient join",
    "Second retained hub message",
    "Third retained hub message",
    "Replay this message after recipient reconnect",
  ];
  const { seedIds, seedBodies } = await seedRetainedHistory(room);
  const senderContext = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const recipientContext = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  await guardContext(senderContext, externalAttempts);
  await guardContext(recipientContext, externalAttempts);
  const sender = await senderContext.newPage();
  const recipient = await recipientContext.newPage();
  const hubFrames: Array<{ type?: string; messageIds?: string[]; pageBytes?: number; limit?: number }> = [];
  const sentMessageIds: string[] = [];
  const acknowledgedMessageIds: string[] = [];
  const historyRequests: Array<{ type?: string; limit?: number }> = [];
  let resolveSenderClosed!: () => void;
  const firstSenderSocketClosed = new Promise<void>((resolve) => { resolveSenderClosed = resolve; });
  let resolveRecipientClosed!: () => void;
  const firstRecipientSocketClosed = new Promise<void>((resolve) => { resolveRecipientClosed = resolve; });

  for (const page of [sender, recipient]) {
    page.on("websocket", (socket) => {
      if (page === sender) socket.on("close", () => resolveSenderClosed());
      if (page === recipient) socket.on("close", () => resolveRecipientClosed());
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        try {
          const packet = JSON.parse(payload) as { type?: string; id?: string; limit?: number };
          if (packet.type === "history_request") historyRequests.push(packet);
          if (packet.type === "message" && packet.id) sentMessageIds.push(packet.id);
        } catch {
          // The application validates packets before sending; ignore unrelated non-JSON frames.
        }
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        try {
          const packet = JSON.parse(payload) as { type?: string; id?: string; messageIds?: string[]; pageBytes?: number; limit?: number };
          if (["ack", "message", "history_page_complete"].includes(packet.type ?? "")) hubFrames.push(packet);
          if (packet.type === "ack" && packet.id) acknowledgedMessageIds.push(packet.id);
        } catch {
          // The browser already handles invalid frames; this listener records only parseable evidence.
        }
      });
    });
  }

  try {
    await recipient.goto("/");
    await waitForSetupReady(recipient);
    await configureAndJoin(sender, "Hub Sender", room);
    const senderLog = sender.getByRole("log", { name: `Messages in ${room}` });
    const sendAndWaitForHubAcceptance = async (body: string) => {
      const priorCount = sentMessageIds.length;
      await sender.getByRole("textbox", { name: "Write a message" }).fill(body);
      await sender.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => sentMessageIds.length).toBeGreaterThan(priorCount);
      const sentId = sentMessageIds.at(-1);
      expect(sentId).toBeTruthy();
      await expect.poll(() => acknowledgedMessageIds).toContain(sentId);
      const bubble = senderLog.getByText(body);
      await expect(bubble).toBeVisible();
      await expect(bubble.locator("..")).toContainText("Accepted by hub");
    };
    await sendAndWaitForHubAcceptance(bodies[0]);
    await expect.poll(async () => (await storedMessages(sender, room)).length, { timeout: 20_000 }).toBe(101);
    const senderRows = await storedMessages(sender, room);
    expect(senderRows).toHaveLength(101);
    expect(senderRows.filter((item) => item.direction === "outgoing" && item.delivery === "sent")).toHaveLength(1);
    expect(await storedMessages(recipient, room)).toHaveLength(0);
    await sender.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(sender.locator(".connection-status")).not.toContainText("connected");
    await firstSenderSocketClosed;

    await configureAndJoin(recipient, "Hub Recipient", room);
    const recipientLog = recipient.getByRole("log", { name: `Messages in ${room}` });
    await expect(recipientLog.getByText(bodies[0])).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await storedMessages(recipient, room)).length, { timeout: 20_000 }).toBe(100);
    const receivedRows = await storedMessages(recipient, room);
    expect(receivedRows).toHaveLength(100);
    expect(receivedRows.every((item) => item.direction === "incoming")).toBe(true);
    const receivedIds = new Set(receivedRows.map((item) => item.packet.id));
    expect(receivedIds.size).toBe(100);
    expect(receivedIds.has(sentMessageIds[0])).toBe(true);
    expect(receivedIds.has(seedIds[0])).toBe(false);
    expect(receivedIds.has(seedIds[1])).toBe(false);
    expect(seedIds.slice(2).every((id) => receivedIds.has(id))).toBe(true);

    await recipient.getByRole("button", { name: "Load older messages" }).click();
    await expect(recipientLog.getByText(seedBodies[0], { exact: true })).toBeVisible();
    await expect(recipientLog.getByText(seedBodies[1], { exact: true })).toBeVisible();
    await expect(recipient.getByRole("status").filter({ hasText: "No more retained hub history is available." })).toBeVisible();
    const historyRows = await storedMessages(recipient, room);
    expect(historyRows).toHaveLength(102);
    expect(new Set(historyRows.map((item) => item.packet.id)).size).toBe(102);
    const historyCompletions = hubFrames.filter((packet) => packet.type === "history_page_complete");
    expect(historyCompletions).toHaveLength(1);
    expect(historyRequests.length).toBeGreaterThan(0);
    for (const request of historyRequests) {
      expect(request.limit).toEqual(expect.any(Number));
      expect(request.limit ?? 0).toBeGreaterThan(0);
      expect(request.limit ?? 0).toBeLessThanOrEqual(100);
    }
    for (const completion of historyCompletions) {
      expect(completion.messageIds).toEqual(seedIds.slice(0, 2).reverse());
      expect(completion.messageIds?.length ?? 0).toBeGreaterThan(0);
      expect(completion.messageIds?.length ?? 0).toBeLessThanOrEqual(100);
      expect(completion.pageBytes).toEqual(expect.any(Number));
      expect(completion.pageBytes ?? -1).toBeGreaterThanOrEqual(0);
      expect(completion.pageBytes ?? -1).toBeLessThanOrEqual(512 * 1024);
    }

    await sender.getByRole("button", { name: "Connect radio" }).click();
    await expect(sender.locator(".connection-status")).toContainText("connected");
    for (const body of bodies.slice(1, 3)) {
      await sendAndWaitForHubAcceptance(body);
      await expect(recipientLog.getByText(body)).toBeVisible();
    }
    for (const body of bodies.slice(0, 3)) await expect(recipientLog.getByText(body)).toHaveCount(1);
    await expect.poll(async () => (await storedMessages(sender, room)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(103);
    await expect.poll(async () => (await storedMessages(recipient, room)).length, { timeout: 20_000 }).toBe(104);

    await recipient.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(recipient.locator(".connection-status")).not.toContainText("connected");
    await firstRecipientSocketClosed;
    await sendAndWaitForHubAcceptance(bodies[3]);
    expect(await storedMessages(recipient, room)).toHaveLength(104);
    await recipient.getByRole("button", { name: "Connect radio" }).click();
    await expect(recipient.locator(".connection-status")).toContainText("connected");
    for (const body of bodies.slice(0, 3)) await expect(recipientLog.getByText(body, { exact: true })).toHaveCount(1);
    await expect(recipientLog.getByText(bodies[3], { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await storedMessages(recipient, room)).length, { timeout: 20_000 }).toBe(105);
    const reconnectedRows = await storedMessages(recipient, room);
    expect(reconnectedRows).toHaveLength(105);
    expect(new Set(reconnectedRows.map((item) => item.packet.id)).size).toBe(105);
    expect(hubFrames.filter((packet) => packet.type === "ack").length).toBeGreaterThanOrEqual(bodies.length);
    expect(hubFrames.filter((packet) => packet.type === "message").length).toBeGreaterThanOrEqual(bodies.length);
  } finally {
    await Promise.all([senderContext.close(), recipientContext.close()]);
  }

  expect(externalAttempts).toEqual([]);
});
