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
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible();
  await expect(page.getByLabel("Your call sign")).toBeEnabled();
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
  await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
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
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.getByRole("button", { name: "Retry loading older messages" })).toBeVisible();
  await page.getByRole("button", { name: "Retry loading older messages" }).click();
  await expect(messageLog.getByText(pageOldest.body)).toBeVisible();
  await expect.poll(() => cursors).toEqual([boundary.id, boundary.id]);
  await expect(messageLog.getByText("No more retained hub history is available.")).toBeVisible();
  const displayedBodies = await messageLog.locator(".message-bubble").allTextContents();
  expect(displayedBodies).toEqual([pageOldest.body, pageNewest.body, boundary.body]);
  await expectAccessible(page, "the loaded and retried history page");
});
