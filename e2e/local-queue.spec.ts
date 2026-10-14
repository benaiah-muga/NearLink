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

test("saves a station profile and keeps a message queued through reload without a hub", async ({ page }) => {
  const hubAttempts: string[] = [];
  const hubSocketErrors: string[] = [];
  page.on("websocket", (socket) => {
    hubAttempts.push(socket.url());
    socket.on("socketerror", (error) => hubSocketErrors.push(error));
  });

  await page.goto("/");
  await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
  await expectAccessible(page, "the loaded station screen");
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
