import { expect, test } from "@playwright/test";

test("saves a station profile and keeps a message queued through reload without a hub", async ({ page }) => {
  const hubAttempts: string[] = [];
  const hubSocketErrors: string[] = [];
  page.on("websocket", (socket) => {
    hubAttempts.push(socket.url());
    socket.on("socketerror", (error) => hubSocketErrors.push(error));
  });

  await page.goto("/");
  await expect(page.getByText("Messages save locally until a hub is connected")).toBeVisible();
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

  await page.reload();

  await expect(page.getByLabel("Your call sign")).toHaveValue("Test Station");
  await expect(page.getByLabel("Room frequency")).toHaveValue("chromium-queue-check");
  await expect(page.getByLabel("Hub address")).toHaveValue("ws://127.0.0.1:1/ws");
  const restoredLog = page.getByRole("log", { name: "Messages in chromium-queue-check" });
  await expect(restoredLog.getByText(message)).toBeVisible();
  await expect(restoredLog.getByText("Queued on this device")).toBeVisible();
});
