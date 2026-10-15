import { chromium, expect, test, type BrowserContext, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

type DirectEvent = { kind: "persisted" | "ack"; id: string; time: number };
type StoredMessage = {
  packet: { id: string; room: string; body: string };
  direction: string;
  delivery: string;
  transport?: string;
};

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackHttpOrWebSocket(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function guardContext(context: BrowserContext, externalAttempts: string[]): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (["http:", "https:", "ws:", "wss:"].includes(new URL(url).protocol) && !isLoopbackHttpOrWebSocket(url)) {
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

async function waitForSetupReady(page: Page): Promise<void> {
  const diagnostics = page.locator(".diagnostics-panel");
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
}

async function withinStage<T>(name: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out during ${name} after 20 seconds.`)), 20_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readMessages(page: Page, room: string): Promise<StoredMessage[]> {
  return page.evaluate(async (roomName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nearlink-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<StoredMessage[]>((resolve, reject) => {
      const request = database.transaction("messages", "readonly").objectStore("messages").getAll();
      request.onsuccess = () => resolve(request.result as StoredMessage[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return rows.filter((row) => row.packet.room === roomName);
  }, room);
}

function sdpFingerprint(signalJson: string): string {
  const signal = JSON.parse(signalJson) as { sdp?: string };
  const match = signal.sdp?.match(/(?:^|\r?\n)a=fingerprint:(sha-256|sha-384|sha-512)\s+([0-9A-Fa-f:]+)(?:\r?\n|$)/i);
  expect(match, "local SDP contains a complete DTLS fingerprint").toBeTruthy();
  return `${match![1].toLowerCase()} ${match![2].toUpperCase()}`;
}

async function installReceiverEvidence(page: Page, closeOnBody: string): Promise<void> {
  await page.addInitScript((queuedBody) => {
    const events: DirectEvent[] = [];
    const pendingRows = new WeakMap<IDBTransaction, { id: string; body?: string }>();
    Object.defineProperty(window, "__nearlinkDirectEvents", { configurable: false, value: events });
    Object.defineProperty(window, "__nearlinkCloseTriggered", { configurable: false, writable: true, value: false });

    const nativeTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (): IDBTransaction {
      const transaction = Reflect.apply(nativeTransaction, this, arguments) as IDBTransaction;
      if (transaction.mode === "readwrite" && transaction.objectStoreNames.contains("messages")) {
        transaction.addEventListener("complete", () => {
          const row = pendingRows.get(transaction);
          if (!row) return;
          events.push({ kind: "persisted", id: row.id, time: performance.now() });
          if (row.body === queuedBody) {
            Object.defineProperty(window, "__nearlinkCloseTriggered", { configurable: true, writable: true, value: true });
            document.querySelector<HTMLButtonElement>(".direct-close")?.click();
          }
        }, { once: true });
      }
      return transaction;
    };

    const nativeAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const row = value as { packet?: { id?: string; body?: string } };
      const id = row?.packet?.id;
      const body = row?.packet?.body;
      if (this.name === "messages" && id) {
        pendingRows.set(this.transaction, { id, body });
      }
      return key === undefined ? nativeAdd.call(this, value) : nativeAdd.call(this, value, key);
    };

    const nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data: string | Blob | ArrayBuffer | ArrayBufferView): void {
      let acknowledgmentId: string | null = null;
      if (typeof data === "string") {
        try {
          const packet = JSON.parse(data) as { type?: string; id?: string };
          if (packet.type === "ack" && packet.id) acknowledgmentId = packet.id;
        } catch {
          // Keep the observer passive when the data channel carries other frames.
        }
      }
      nativeSend.call(this, data);
      if (acknowledgmentId) events.push({ kind: "ack", id: acknowledgmentId, time: performance.now() });
    };
  }, closeOnBody);
}

async function readDirectEvents(page: Page): Promise<DirectEvent[]> {
  return page.evaluate(() => (window as Window & { __nearlinkDirectEvents: DirectEvent[] }).__nearlinkDirectEvents);
}

test("direct conversation uses real Chromium and Firefox WebRTC contexts", async ({ browser }) => {
  test.setTimeout(120_000);
  const mark = (stage: string) => console.log(`[direct-cross-browser] ${stage}`);
  const externalAttempts: string[] = [];
  const room = `direct-compat-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const acceptedBody = "Cross-browser direct message with durable peer acceptance";
  const queuedBody = "Cross-browser direct message closed before peer acceptance";
  let chromiumBrowser: Browser | undefined;
  let chromiumContext: BrowserContext | undefined;
  let firefoxContext: BrowserContext | undefined;
  try {
    mark("before Chromium launch");
    const executablePath = process.env.NEARLINK_CHROMIUM_EXECUTABLE;
    chromiumBrowser = await chromium.launch(executablePath ? { executablePath, timeout: 20_000 } : { timeout: 20_000 });
    mark("after Chromium launch, before Chromium context creation");
    const chromiumCtx = await withinStage("Chromium context creation", chromiumBrowser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" }));
    chromiumContext = chromiumCtx;
    mark("after Chromium context creation, before Firefox context creation");
    const firefoxCtx = await withinStage("Firefox context creation", browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" }));
    firefoxContext = firefoxCtx;
    mark("after Firefox context creation, before route guards");
    await withinStage("route guard setup", Promise.all([guardContext(chromiumCtx, externalAttempts), guardContext(firefoxCtx, externalAttempts)]));
    mark("after route guards, before page creation");
    const chromiumPage = await withinStage("Chromium page creation", chromiumCtx.newPage());
    const firefoxPage = await withinStage("Firefox page creation", firefoxCtx.newPage());
    mark("after page creation, before evidence instrumentation");
    await installReceiverEvidence(firefoxPage, queuedBody);
    mark("after evidence instrumentation");

    mark("load production pages and wait for protocol setup");
    await Promise.all([chromiumPage.goto("/", { waitUntil: "domcontentloaded" }), firefoxPage.goto("/", { waitUntil: "domcontentloaded" })]);
    await Promise.all([waitForSetupReady(chromiumPage), waitForSetupReady(firefoxPage)]);

    for (const [page, name] of [[chromiumPage, "Chromium Sender"], [firefoxPage, "Firefox Recipient"]] as const) {
      const directPanel = page.locator(".direct-panel");
      if (!(await directPanel.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await directPanel.locator("summary").click();
      }
      await page.getByLabel("Your call sign").fill(name);
      await page.getByLabel("Room frequency").fill(room);
      await page.getByLabel("Message transport").selectOption("direct");
      await page.getByRole("button", { name: "Save profile for direct link" }).click();
      await expect(page.getByRole("button", { name: "Save profile for direct link" })).toBeVisible();
    }

    mark("create Chromium offer and accept it in Firefox");
    await chromiumPage.getByRole("button", { name: "Create offer" }).click();
    const offerField = chromiumPage.getByLabel("Your signaling JSON to share");
    await expect.poll(async () => JSON.parse(await offerField.inputValue()).type).toBe("offer");
    const offer = await offerField.inputValue();
    const chromiumLocalFingerprint = sdpFingerprint(offer);

    await firefoxPage.getByLabel("Paste peer offer or answer JSON").fill(offer);
    await firefoxPage.getByRole("button", { name: "Accept offer" }).click();
    const answerField = firefoxPage.getByLabel("Your signaling JSON to share");
    await expect.poll(async () => JSON.parse(await answerField.inputValue()).type).toBe("answer");
    const answer = await answerField.inputValue();
    const firefoxLocalFingerprint = sdpFingerprint(answer);

    await chromiumPage.getByLabel("Paste peer offer or answer JSON").fill(answer);
    await chromiumPage.getByRole("button", { name: "Accept answer" }).click();
    mark("wait for Chromium to Firefox direct channel");
    await Promise.all([
      expect(chromiumPage.locator(".direct-state")).toContainText("Direct channel: connected", { timeout: 30_000 }),
      expect(firefoxPage.locator(".direct-state")).toContainText("Direct channel: connected", { timeout: 30_000 }),
    ]);

    const chromiumRemoteFingerprint = await chromiumPage.getByLabel("Remote SDP DTLS fingerprint").innerText();
    const firefoxRemoteFingerprint = await firefoxPage.getByLabel("Remote SDP DTLS fingerprint").innerText();
    expect(chromiumRemoteFingerprint).toBe(firefoxLocalFingerprint);
    expect(firefoxRemoteFingerprint).toBe(chromiumLocalFingerprint);

    mark("reject mismatched fingerprint then confirm both peers");
    await chromiumPage.getByLabel(/Fingerprint compared in person/).fill("sha-256 00:00:00");
    await chromiumPage.getByRole("button", { name: "Compare fingerprints" }).click();
    await expect(chromiumPage.getByText("Fingerprint does not match. Compare the complete fingerprint over your separate trusted channel.")).toBeVisible();
    await expect(chromiumPage.locator(".direct-state")).toContainText("Messages over this link require fingerprint confirmation");
    await expect(chromiumPage.getByRole("status").filter({ hasText: "Direct messages remain queued until session confirmation" })).toBeVisible();

    mark("send a message while Chromium fingerprint confirmation is rejected");
    await chromiumPage.getByRole("textbox", { name: "Write a message" }).fill(acceptedBody);
    await chromiumPage.getByRole("button", { name: "Send message" }).click();
    await expect.poll(async () => (await readMessages(chromiumPage, room)).find((row) => row.packet.body === acceptedBody)).toMatchObject({
      direction: "outgoing",
      delivery: "queued",
      transport: "direct",
    });
    expect((await readMessages(firefoxPage, room)).filter((row) => row.packet.body === acceptedBody)).toHaveLength(0);

    await firefoxPage.getByLabel(/Fingerprint compared in person/).fill(chromiumLocalFingerprint);
    await firefoxPage.getByRole("button", { name: "Compare fingerprints" }).click();
    await expect(firefoxPage.locator(".direct-state")).toContainText("Fingerprint confirmed for this session.");
    await chromiumPage.getByLabel(/Fingerprint compared in person/).fill(firefoxLocalFingerprint);
    await chromiumPage.getByRole("button", { name: "Compare fingerprints" }).click();
    await expect(chromiumPage.locator(".direct-state")).toContainText("Fingerprint confirmed for this session.");

    mark("verify the queued message is accepted after fingerprint confirmation");
    const recipientLog = firefoxPage.getByRole("log", { name: `Messages in ${room}` });
    await expect(recipientLog.getByText(acceptedBody, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readMessages(firefoxPage, room)).find((row) => row.packet.body === acceptedBody)).toMatchObject({
      direction: "incoming",
      delivery: "sent",
      transport: "direct",
    });
    const receiverRows = await readMessages(firefoxPage, room);
    const received = receiverRows.find((row) => row.packet.body === acceptedBody)!;
    await expect.poll(async () => readDirectEvents(firefoxPage)).toMatchObject(expect.arrayContaining([
      expect.objectContaining({ kind: "persisted", id: received.packet.id }),
      expect.objectContaining({ kind: "ack", id: received.packet.id }),
    ]));
    const directEvents = await readDirectEvents(firefoxPage);
    const persistedEvent = directEvents.find((event) => event.kind === "persisted" && event.id === received.packet.id)!;
    const ackEvent = directEvents.find((event) => event.kind === "ack" && event.id === received.packet.id)!;
    expect(persistedEvent.time).toBeLessThanOrEqual(ackEvent.time);
    const senderLog = chromiumPage.getByRole("log", { name: `Messages in ${room}` });
    await expect(senderLog.getByText(acceptedBody, { exact: true }).locator("..")).toContainText("Accepted by peer device", { timeout: 20_000 });
    await expect.poll(async () => (await readMessages(chromiumPage, room)).find((row) => row.packet.body === acceptedBody)).toMatchObject({
      direction: "outgoing",
      delivery: "sent",
      transport: "direct",
    });

    mark("send second message and close receiver after its IndexedDB commit");
    await chromiumPage.getByRole("textbox", { name: "Write a message" }).fill(queuedBody);
    await chromiumPage.getByRole("button", { name: "Send message" }).click();
    await expect.poll(async () => (await readMessages(firefoxPage, room)).find((row) => row.packet.body === queuedBody)).toMatchObject({
      direction: "incoming",
      delivery: "sent",
      transport: "direct",
    });
    await expect.poll(async () => firefoxPage.evaluate(() => (window as Window & { __nearlinkCloseTriggered: boolean }).__nearlinkCloseTriggered)).toBe(true);
    await expect(chromiumPage.locator(".direct-state")).toContainText(/Direct channel: (closed|failed)\./);
    await expect.poll(async () => (await readMessages(chromiumPage, room)).find((row) => row.packet.body === queuedBody)).toMatchObject({
      direction: "outgoing",
      delivery: "queued",
      transport: "direct",
    });
    const queuedRow = (await readMessages(chromiumPage, room)).find((row) => row.packet.body === queuedBody);
    expect(queuedRow).toBeTruthy();
    await expect(senderLog.getByText(queuedBody, { exact: true }).locator("..")).toContainText("Queued on this device");
    await expect(senderLog.getByText(queuedBody, { exact: true }).locator("..")).not.toContainText("Accepted by peer device");
  } finally {
    mark("close browser contexts");
    const contextClosures = [chromiumContext?.close(), firefoxContext?.close()].filter((close): close is Promise<void> => Boolean(close));
    await Promise.allSettled(contextClosures);
    await chromiumBrowser?.close().catch(() => undefined);
  }

  expect(externalAttempts).toEqual([]);
});
