import { expect, test } from "@playwright/test";

test("saves a profile and queued message across reload", async ({ page }) => {
  const callSign = "Cross Engine Tester";
  const room = "cross-engine-smoke-room";
  const message = "Cross-browser local persistence smoke";

  await page.goto("/");
  const diagnostics = page.locator(".diagnostics-panel");
  if (!(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await diagnostics.locator("summary").click();
  }
  await expect(diagnostics.locator(".diagnostics-grid").getByText("ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Your call sign")).toBeEnabled();

  await page.getByLabel("Your call sign").fill(callSign);
  await page.getByLabel("Room frequency").fill(room);
  await page.getByLabel("Message transport").selectOption("direct");
  await page.getByRole("button", { name: "Save profile for direct link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved for direct peer setup" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Write a message" });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await page.getByRole("button", { name: "Send message" }).click();

  const messageLog = page.getByRole("log", { name: `Messages in ${room}` });
  await expect(messageLog.getByText(message)).toBeVisible();
  await expect(messageLog.getByText("Queued on this device")).toBeVisible();

  await page.reload();

  await expect(page.getByLabel("Your call sign")).toHaveValue(callSign);
  await expect(page.getByLabel("Room frequency")).toHaveValue(room);
  const restoredLog = page.getByRole("log", { name: `Messages in ${room}` });
  await expect(restoredLog.getByText(message)).toBeVisible();
  await expect(restoredLog.getByText("Queued on this device")).toBeVisible();
});
