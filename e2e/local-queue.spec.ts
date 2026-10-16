import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const accessibilityTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectAccessible(page: import("@playwright/test").Page, state: string) {
  const result = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    elements: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
  }));
  expect(violations, `Accessibility violations on ${state}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function waitForSetupReady(page: import("@playwright/test").Page) {
  const diagnostics = page.locator(".diagnostics-panel");
  const wasOpen = await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!wasOpen) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible();
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
  if (!wasOpen) {
    await diagnostics.locator("summary").click();
  }
}

test("saves a station profile and keeps a message queued through reload without a hub", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("Clipboard access is blocked."); } },
    });
  });
  const hubAttempts: string[] = [];
  const hubSocketErrors: string[] = [];
  page.on("websocket", (socket) => {
    hubAttempts.push(socket.url());
    socket.on("socketerror", (error) => hubSocketErrors.push(error));
  });

  await page.goto("/");
  await waitForSetupReady(page);
  await expectAccessible(page, "the loaded station screen");
  const diagnostics = page.locator(".diagnostics-panel");
  const diagnosticsSummary = diagnostics.locator("summary");
  await diagnosticsSummary.focus();
  await page.keyboard.press("Enter");
  await expect(diagnostics).toHaveAttribute("open", "");
  await expect(diagnostics.getByText("Unavailable while the selected conversation loads or changes")).toBeVisible();
  await expectAccessible(page, "diagnostics opened with the keyboard");
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill("Test Station");
  await page.getByLabel("Room frequency").fill("chromium-queue-check");
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:1/ws");
  await page.getByRole("button", { name: "Save and join room" }).click();

  await expect(page.getByRole("button", { name: "Station settings saved" })).toBeVisible();
  await expect.poll(() => hubAttempts).toContain("ws://127.0.0.1:1/ws");
  await expect.poll(() => hubSocketErrors.length).toBeGreaterThan(0);

  const message = "Persist this while the hub is unavailable";
  await page.getByRole("textbox", { name: "Write a message" }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();

  const messageLog = page.getByRole("log", { name: "Messages in chromium-queue-check" });
  await expect(messageLog.getByText(message)).toBeVisible();
  await expect(messageLog.getByText("Queued on this device")).toBeVisible();
  await diagnostics.getByRole("button", { name: "Copy diagnostics summary" }).click();
  const manualCopy = diagnostics.getByLabel("Copy this summary manually");
  await expect(manualCopy).toBeVisible();
  const copiedDiagnostics = await manualCopy.inputValue();
  expect(copiedDiagnostics).not.toContain("chromium-queue-check");
  expect(copiedDiagnostics).not.toContain("Test Station");
  expect(copiedDiagnostics).not.toContain("127.0.0.1:1");
  expect(copiedDiagnostics).not.toContain(message);
  await expectAccessible(page, "the diagnostics manual-copy fallback");
  await expectAccessible(page, "the queued message screen");

  await page.reload();

  await expect(page.getByLabel("Your call sign")).toHaveValue("Test Station");
  await expect(page.getByLabel("Room frequency")).toHaveValue("chromium-queue-check");
  await expect(page.getByLabel("Hub address")).toHaveValue("ws://127.0.0.1:1/ws");
  const restoredLog = page.getByRole("log", { name: "Messages in chromium-queue-check" });
  await expect(restoredLog.getByText(message)).toBeVisible();
  await expect(restoredLog.getByText("Queued on this device")).toBeVisible();

  const clearConversation = page.getByRole("button", { name: "Clear this device's saved conversation" });
  const confirmation = page.getByRole("dialog", { name: "Clear saved messages for chromium-queue-check?" });
  await expect(confirmation).toBeHidden();
  await clearConversation.click();
  await expect(confirmation).toBeVisible();
  await expectAccessible(page, "the local conversation deletion confirmation");
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(clearConversation).toBeFocused();

  await clearConversation.click();
  await confirmation.getByRole("button", { name: "Delete local messages" }).click();
  await expect(confirmation).toBeHidden();
  await expect(restoredLog.getByText(message)).toBeHidden();
  await expect(page.getByLabel("Your call sign")).toHaveValue("Test Station");
  await expect(page.getByLabel("Room frequency")).toHaveValue("chromium-queue-check");
  await expect(page.getByText(/Hub history was not deleted and may appear after you reconnect/)).toBeVisible();
  await expectAccessible(page, "the cleared local conversation screen");
});

test("keeps the first-run queue journey usable at narrow Chromium widths", async ({ browser }) => {
  for (const width of [320, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
      const callSign = page.getByLabel("Your call sign");
      const roomFrequency = page.getByLabel("Room frequency");
      const save = page.getByRole("button", { name: "Save and join room" });
      await expect(callSign).toBeVisible();
      await expect(roomFrequency).toBeVisible();
      await expect(save).toBeVisible();
      await expectWithinViewport(callSign, width, "call sign field");
      await expectWithinViewport(roomFrequency, width, "room frequency field");
      await expectWithinViewport(save, width, "save button");
      await expectNoHorizontalOverflow(page, width);
      await expectAccessible(page, `the first-run screen at ${width}px`);

      const diagnostics = page.locator(".diagnostics-panel");
      const diagnosticsSummary = diagnostics.locator("summary");
      await diagnosticsSummary.focus();
      await page.keyboard.press("Enter");
      await expect(diagnostics).toHaveAttribute("open", "");
      await expectWithinViewport(diagnosticsSummary, width, "diagnostics summary");
      await expectNoHorizontalOverflow(page, width);
      await expectAccessible(page, `keyboard-opened diagnostics at ${width}px`);

      const copyDiagnostics = diagnostics.getByRole("button", { name: "Copy diagnostics summary" });
      await expect(copyDiagnostics).toBeVisible();
      await expectWithinViewport(copyDiagnostics, width, "copy diagnostics button");
      await callSign.fill("Narrow Test Station");
      await roomFrequency.fill(`chromium-narrow-${width}`);
      await page.getByLabel("Hub address").fill("ws://127.0.0.1:1/ws");
      await expect(save).toBeEnabled();
      await expectWithinViewport(save, width, "save button before submission");
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Station settings saved" })).toBeVisible();

      const message = `Narrow queue at ${width}px`;
      const composer = page.getByRole("textbox", { name: "Write a message" });
      await expect(composer).toBeVisible();
      await expect(composer).toBeEnabled();
      await expectWithinViewport(composer, width, "message composer");
      await composer.fill(message);
      const send = page.getByRole("button", { name: "Send message" });
      await expect(send).toBeEnabled();
      await expectWithinViewport(send, width, "send button before submission");
      await send.focus();
      await page.keyboard.press("Enter");

      const messageLog = page.getByRole("log", { name: `Messages in chromium-narrow-${width}` });
      await expect(messageLog.getByText(message)).toBeVisible();
      await expect(messageLog.getByText("Queued on this device")).toBeVisible();
      await expectWithinViewport(messageLog, width, "message log");
      await expectNoHorizontalOverflow(page, width);
      await expectAccessible(page, `the queued conversation at ${width}px`);
    } finally {
      await context.close();
    }
  }
});

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page, width: number) {
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
    containers: Array.from(document.querySelectorAll(".station-shell, .station-sidebar, .diagnostics-panel, .message-scroll, .composer-wrap, .composer, .composer-tools, .composer-foot"))
      .map((element) => ({
        selector: element.className || element.tagName.toLowerCase(),
        scroll: element.scrollWidth,
        client: element.clientWidth,
      })),
  }));
  expect(dimensions.viewport).toBe(width);
  expect(dimensions.document, `Document overflow at ${width}px: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(width);
  expect(dimensions.body, `Body overflow at ${width}px: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(width);
  for (const container of dimensions.containers) {
    expect(container.scroll, `Horizontal overflow in ${container.selector} at ${width}px: ${JSON.stringify(container)}`).toBeLessThanOrEqual(container.client);
  }
}

async function expectWithinViewport(locator: import("@playwright/test").Locator, width: number, label: string) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  const bounds = await locator.evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  expect(bounds.viewportWidth).toBe(width);
  expect(bounds.left, `${label} extends past the left edge at ${width}px: ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(0);
  expect(bounds.right, `${label} extends past the right edge at ${width}px: ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(width);
  expect(bounds.top, `${label} is above the viewport at ${width}px: ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom, `${label} is below the viewport at ${width}px: ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(bounds.viewportHeight);
}

test("loads older hub history in accepted order and retries the same cursor", async ({ page }) => {
  let historyRequests = 0;
  const boundary = {
    version: 1, type: "message", id: "e2e-history-boundary", room: "chromium-history-check",
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T10:00:00.000Z", body: "Joined replay boundary",
  };
  const pageNewest = {
    version: 1, type: "message", id: "e2e-history-newest", room: "chromium-history-check",
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T08:00:00.000Z", body: "Accepted later, older timestamp",
  };
  const pageOldest = {
    version: 1, type: "message", id: "e2e-history-oldest", room: "chromium-history-check",
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T22:00:00.000Z", body: "Accepted first, newer timestamp",
  };
  const syncMessage = {
    version: 1, type: "message", id: "e2e-sync-message", room: "chromium-history-check",
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T09:00:00.000Z", body: "Received through bounded sync",
  };
  const cursors: (string | null)[] = [];
  await page.routeWebSocket("ws://127.0.0.1:8000/ws", (socket) => {
    socket.onMessage((raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.type === "join") {
        socket.send(JSON.stringify({ version: 1, type: "joined", room: packet.room, peers: 1 }));
        socket.send(JSON.stringify(boundary));
        socket.send(JSON.stringify({ version: 1, type: "presence", room: packet.room, peers: 1 }));
      }
      if (packet.type === "history_request") {
        historyRequests += 1;
        cursors.push(packet.cursor);
        if (historyRequests === 1) {
          socket.send(JSON.stringify({ version: 1, type: "error", code: "history_page_too_large", message: "Reduce the page size." }));
          return;
        }
        socket.send(JSON.stringify(pageNewest));
        socket.send(JSON.stringify(pageOldest));
        const pageBytes = Buffer.byteLength(JSON.stringify(pageNewest), "utf8") + Buffer.byteLength(JSON.stringify(pageOldest), "utf8");
        socket.send(JSON.stringify({
          version: 1, type: "history_page_complete", requestId: packet.requestId,
          room: packet.room, messageIds: [pageNewest.id, pageOldest.id], pageBytes,
          nextCursor: null, hasMore: false, historyTruncated: false,
        }));
      }
      if (packet.type === "sync_inventory_page" && packet.cursor === null) {
        socket.send(JSON.stringify({
          version: 1, type: "sync_inventory_page", room: packet.room, syncId: "e2e-peer-sync",
          sender: "station-b", cursor: null, messageIds: [syncMessage.id], nextCursor: syncMessage.id,
          hasMore: false, limitReached: false,
        }));
      }
      if (packet.type === "sync_missing_request" && packet.targetSender === "station-b") {
        socket.send(JSON.stringify(syncMessage));
        socket.send(JSON.stringify({
          version: 1, type: "sync_page_complete", room: packet.room, syncId: packet.syncId,
          requestId: packet.requestId, sender: "station-b", targetSender: packet.sender,
          messageIds: [syncMessage.id],
        }));
      }
    });
  });

  await page.goto("/");
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill("History Tester");
  await page.getByLabel("Room frequency").fill("chromium-history-check");
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
  const saveAndJoin = page.getByRole("button", { name: "Save and join room" });
  await expect(saveAndJoin).toBeEnabled();
  await saveAndJoin.click();
  const messageLog = page.getByRole("log", { name: "Messages in chromium-history-check" });
  await expect(messageLog.getByText(boundary.body)).toBeVisible();
  await expect(messageLog.getByText(syncMessage.body)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Requested message pages were received and verified in local storage." })).toBeVisible();
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.getByRole("button", { name: "Retry loading older messages" })).toBeVisible();
  await page.getByRole("button", { name: "Retry loading older messages" }).click();
  await expect(messageLog.getByText(pageOldest.body)).toBeVisible();
  await expect.poll(() => cursors).toEqual([boundary.id, boundary.id]);
  await expect(messageLog.getByText("No more retained hub history is available.")).toBeVisible();
  const displayedBodies = await messageLog.locator(".message-bubble").allTextContents();
  expect(displayedBodies).toEqual([pageOldest.body, pageNewest.body, boundary.body, syncMessage.body]);
  await expectAccessible(page, "the loaded and retried history page");
});

test("rebuilds the sync inventory after reload and does not complete when a sync message cannot be saved", async ({ page }) => {
  test.setTimeout(60_000);
  const room = "chromium-sync-reload-check";
  const acceptedId = "e2e-sync-reload-accepted";
  const failingId = "e2e-sync-reload-storage-failure";
  const acceptedMessage = {
    version: 1, type: "message", id: acceptedId, room,
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T10:00:00.000Z", body: "Accepted before reload",
  };
  const failingMessage = {
    version: 1, type: "message", id: failingId, room,
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T11:00:00.000Z", body: "This sync message cannot be persisted",
  };
  const inventories: Array<{ connection: number; packet: Record<string, unknown> }> = [];
  const outgoingCompletions: Array<Record<string, unknown>> = [];
  let connection = 0;
  let secondPeerInventorySent = false;

  await page.addInitScript((storageFailureId) => {
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    const failTargetedRow = (value: unknown) => {
      const packet = (value as { packet?: { id?: string } } | null)?.packet;
      if (packet?.id === storageFailureId) throw new DOMException("Injected persistence failure.", "QuotaExceededError");
    };
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      failTargetedRow(value);
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
      failTargetedRow(value);
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    };
  }, failingId);

  await page.routeWebSocket("ws://127.0.0.1:8000/ws", (socket) => {
    const thisConnection = ++connection;
    socket.onMessage((raw) => {
      const packet = JSON.parse(String(raw)) as Record<string, unknown>;
      if (packet.type === "join") {
        socket.send(JSON.stringify({ version: 1, type: "joined", room: packet.room, peers: 1 }));
        socket.send(JSON.stringify({ version: 1, type: "presence", room: packet.room, peers: 1 }));
      }
      if (packet.type === "sync_inventory_page") {
        inventories.push({ connection: thisConnection, packet });
        if (thisConnection === 1) {
          socket.send(JSON.stringify(acceptedMessage));
        } else if (thisConnection === 2 && packet.cursor === null && !secondPeerInventorySent) {
          secondPeerInventorySent = true;
          socket.send(JSON.stringify({
            version: 1, type: "sync_inventory_page", room, syncId: "e2e-reload-peer-session",
            sender: "station-b", cursor: null, messageIds: [failingId], nextCursor: failingId,
            hasMore: false, limitReached: false,
          }));
        }
      }
      if (packet.type === "sync_missing_request" && thisConnection === 2) {
        socket.send(JSON.stringify(failingMessage));
        socket.send(JSON.stringify({
          version: 1, type: "sync_page_complete", room, syncId: packet.syncId,
          requestId: packet.requestId, sender: "station-b", targetSender: packet.sender,
          messageIds: [failingId],
        }));
      }
      if (packet.type === "sync_page_complete") outgoingCompletions.push(packet);
    });
  });

  await page.goto("/");
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill("Reload Tester");
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
  await page.getByRole("button", { name: "Save and join room" }).click();

  const messageLog = page.getByRole("log", { name: `Messages in ${room}` });
  await expect(messageLog.getByText(acceptedMessage.body)).toBeVisible();
  await expect.poll(() => inventories.filter((item) => item.connection === 1).length).toBeGreaterThan(0);
  expect((inventories.find((item) => item.connection === 1)!.packet.messageIds as string[])).not.toContain(acceptedId);

  await page.reload();
  await expect(page.getByLabel("Your call sign")).toHaveValue("Reload Tester");
  await expect(page.getByLabel("Room frequency")).toHaveValue(room);
  await expect(page.getByRole("log", { name: `Messages in ${room}` }).getByText(acceptedMessage.body)).toBeVisible();
  await page.getByRole("button", { name: "Save and join room" }).click();

  await expect.poll(() => inventories.filter((item) => item.connection === 2).length).toBeGreaterThan(0);
  const reloadedInventory = inventories.find((item) => item.connection === 2)!.packet;
  expect(reloadedInventory.messageIds).toEqual([acceptedId]);
  expect(reloadedInventory.syncId).not.toBe(inventories.find((item) => item.connection === 1)!.packet.syncId);

  const syncStatus = page.locator(".sync-status");
  await expect(syncStatus).toContainText("A requested sync message could not be saved. Reconnect to restart synchronization.");
  expect(outgoingCompletions).toEqual([]);
  await expect(page.getByRole("log", { name: `Messages in ${room}` }).getByText(failingMessage.body)).toBeHidden();
});

test("restarts sync from the durable inventory after the peer completion is lost", async ({ page }) => {
  test.setTimeout(60_000);
  const room = "chromium-sync-lost-completion";
  const acceptedId = "e2e-sync-durable-after-lost-completion";
  const acceptedMessage = {
    version: 1, type: "message", id: acceptedId, room,
    sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T10:00:00.000Z", body: "Saved before the sync completion was lost",
  };
  const localInventories: Array<{ connection: number; packet: Record<string, unknown> }> = [];
  const peerRequests: Array<{ connection: number; packet: Record<string, unknown> }> = [];
  const connections = new Set<number>();
  const peerInventorySent = new Set<number>();
  let connection = 0;

  await page.routeWebSocket("ws://127.0.0.1:8000/ws", (socket) => {
    const thisConnection = ++connection;
    connections.add(thisConnection);
    socket.onMessage((raw) => {
      const packet = JSON.parse(String(raw)) as Record<string, unknown>;
      if (packet.type === "join") {
        socket.send(JSON.stringify({ version: 1, type: "joined", room: packet.room, peers: 1 }));
        socket.send(JSON.stringify({ version: 1, type: "presence", room: packet.room, peers: 1 }));
      }
      if (packet.type === "sync_inventory_page") {
        localInventories.push({ connection: thisConnection, packet });
        if (packet.cursor === null && !peerInventorySent.has(thisConnection)) {
          peerInventorySent.add(thisConnection);
          socket.send(JSON.stringify({
            version: 1, type: "sync_inventory_page", room,
            syncId: thisConnection === 1 ? "e2e-lost-completion-peer-first" : "e2e-lost-completion-peer-restart",
            sender: "station-b", cursor: null, messageIds: [acceptedId], nextCursor: acceptedId,
            hasMore: false, limitReached: false,
          }));
        }
      }
      if (packet.type === "sync_missing_request") {
        peerRequests.push({ connection: thisConnection, packet });
        if (thisConnection === 1 && (packet.messageIds as string[]).includes(acceptedId)) {
          socket.send(JSON.stringify(acceptedMessage));
          // Intentionally omit sync_page_complete to model a lost peer completion.
        }
      }
    });
  });

  await page.goto("/");
  await waitForSetupReady(page);
  await page.getByLabel("Your call sign").fill("Reload Tester");
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Hub address").fill("ws://127.0.0.1:8000/ws");
  await page.getByRole("button", { name: "Save and join room" }).click();

  const firstLog = page.getByRole("log", { name: `Messages in ${room}` });
  await expect(firstLog.getByText(acceptedMessage.body)).toBeVisible();
  await expect.poll(() => peerRequests.filter((item) => item.connection === 1).length).toBeGreaterThan(0);
  expect((peerRequests.find((item) => item.connection === 1)!.packet.messageIds as string[])).toEqual([acceptedId]);
  expect((await page.evaluate(async (messageId) => {
    const request = indexedDB.open("nearlink-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction("messages", "readonly");
        const lookup = transaction.objectStore("messages").get(["chromium-sync-lost-completion", messageId]);
        lookup.onsuccess = () => resolve(Boolean(lookup.result));
        lookup.onerror = () => reject(lookup.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, acceptedId))).toBe(true);
  expect(localInventories.some((item) => item.connection === 1 && (item.packet.messageIds as string[]).includes(acceptedId))).toBe(false);
  await expect(page.locator(".sync-status")).toContainText("Exchanging bounded local message inventories");

  await page.reload();
  await expect(page.getByLabel("Your call sign")).toHaveValue("Reload Tester");
  await expect(page.getByLabel("Room frequency")).toHaveValue(room);
  const restoredLog = page.getByRole("log", { name: `Messages in ${room}` });
  await expect(restoredLog.getByText(acceptedMessage.body)).toBeVisible();
  await page.getByRole("button", { name: "Save and join room" }).click();

  await expect.poll(() => localInventories.some((item) => item.connection === 2 && (item.packet.messageIds as string[]).includes(acceptedId))).toBe(true);
  const firstInventory = localInventories.find((item) => item.connection === 1)!;
  const restartedInventory = localInventories.find((item) => item.connection === 2 && (item.packet.messageIds as string[]).includes(acceptedId))!;
  expect(restartedInventory.packet.syncId).not.toBe(firstInventory.packet.syncId);
  expect(peerRequests.filter((item) => item.connection === 2 && (item.packet.messageIds as string[]).includes(acceptedId))).toEqual([]);
  await expect(page.locator(".sync-status")).toContainText("The peer inventory contains no message IDs missing from this local snapshot.");
  await expect(restoredLog.getByText(acceptedMessage.body)).toHaveCount(1);
  expect(connections).toEqual(new Set([1, 2]));
});

test("reconciles a persisted message over a confirmed direct Chromium session", async ({ browser }) => {
  test.setTimeout(60_000);
  const left = await browser.newPage();
  const right = await browser.newPage();
  const room = "chromium-direct-sync";
  const body = "Received over direct synchronization";
  try {
    await Promise.all([left.goto("/"), right.goto("/")]);
    await Promise.all([
      expect(left.getByText("Start with three details")).toBeVisible(),
      expect(right.getByText("Start with three details")).toBeVisible(),
    ]);
    await Promise.all([waitForSetupReady(left), waitForSetupReady(right)]);
    for (const page of [left, right]) {
      const directSetup = page.locator(".direct-panel");
      const summary = directSetup.locator("summary");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(directSetup).toHaveAttribute("open", "");
      await expect(directSetup.getByRole("button", { name: "Create offer" })).toBeVisible();
    }
    await left.getByLabel("Your call sign").fill("Direct Left");
    await right.getByLabel("Your call sign").fill("Direct Right");
    await left.getByLabel("Room frequency").fill(room);
    await right.getByLabel("Room frequency").fill(room);
    await Promise.all([left.getByLabel("Message transport").selectOption("direct"), right.getByLabel("Message transport").selectOption("direct")]);
    await Promise.all([
      left.getByRole("button", { name: "Save profile for direct link" }).click(),
      right.getByRole("button", { name: "Save profile for direct link" }).click(),
    ]);
    await Promise.all([left.getByRole("button", { name: "Create offer" }).click(), right.getByRole("button", { name: "Create offer" }).click()]);
    const seeded = await left.evaluate(async ({ roomName, messageBody }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("nearlink-local");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(["identity", "messages"], "readwrite");
      const result = await new Promise<string>((resolve, reject) => {
        const request = transaction.objectStore("identity").get("profile");
        request.onsuccess = () => {
          const identity = request.result as { sender: string; senderName: string };
          const packet = {
            version: 1, type: "message", id: "chromium-direct-sync-message", room: roomName,
            sender: identity.sender, senderName: identity.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: messageBody,
          };
          transaction.objectStore("messages").put({ packet, direction: "outgoing", delivery: "sent", transport: "direct" });
          resolve(identity.sender);
        };
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return result;
    }, { roomName: room, messageBody: body });
    expect(seeded).toBeTruthy();

    const offer = await left.getByLabel("Your signaling JSON to share").inputValue();
    await right.getByLabel("Paste peer offer or answer JSON").fill(offer);
    await right.getByRole("button", { name: "Accept offer" }).click();
    const answerLabel = right.getByLabel("Your signaling JSON to share");
    await expect.poll(async () => JSON.parse(await answerLabel.inputValue()).type).toBe("answer");
    const answer = await answerLabel.inputValue();
    await left.getByLabel("Paste peer offer or answer JSON").fill(answer);
    await left.getByRole("button", { name: "Accept answer" }).click();
    await Promise.all([
      left.getByLabel("Remote SDP DTLS fingerprint").waitFor(),
      right.getByLabel("Remote SDP DTLS fingerprint").waitFor(),
    ]);
    const leftFingerprint = await left.getByLabel("Remote SDP DTLS fingerprint").innerText();
    const rightFingerprint = await right.getByLabel("Remote SDP DTLS fingerprint").innerText();
    await left.getByLabel(/Fingerprint compared in person/).fill(leftFingerprint);
    await right.getByLabel(/Fingerprint compared in person/).fill(rightFingerprint);
    await Promise.all([
      left.getByRole("button", { name: "Compare fingerprints" }).click(),
      right.getByRole("button", { name: "Compare fingerprints" }).click(),
    ]);
    await expect(right.getByRole("log", { name: `Messages in ${room}` }).getByText(body)).toBeVisible({ timeout: 30000 });
    await expect(right.getByRole("status").filter({ hasText: "Requested message pages were received and verified in local storage." })).toBeVisible();

    const burstBodies = Array.from({ length: 70 }, (_, index) => `Direct burst ${index + 1} ${"x".repeat(3_800)}`);
    const readBurstRows = () => left.evaluate(async ({ roomName, prefix }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("nearlink-local");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise<Array<{ packet: { room: string; body: string; id: string }; direction: string; delivery: string }>>((resolve, reject) => {
        const request = database.transaction("messages", "readonly").objectStore("messages").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ packet: { room: string; body: string; id: string }; direction: string; delivery: string }>);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return rows.filter((row) => row.packet.room === roomName && row.direction === "outgoing" && row.packet.body.startsWith(prefix));
    }, { roomName: room, prefix: "Direct burst " });
    for (let index = 0; index < burstBodies.length; index += 1) {
      const burstBody = burstBodies[index];
      await left.getByRole("textbox", { name: "Write a message" }).fill(burstBody);
      await left.getByRole("button", { name: "Send message" }).click();
      await expect(left.getByRole("textbox", { name: "Write a message" })).toHaveValue("");
    }
    await left.getByRole("button", { name: "Close direct link" }).click();
    await expect(left.locator(".direct-state")).toContainText("Direct channel: closed");
    const burstRows = await readBurstRows();
    expect(new Set(burstRows.map((row) => row.packet.id)).size).toBe(burstBodies.length);
    expect(burstRows.every((row) => row.delivery === "queued" || row.delivery === "sent")).toBe(true);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});
