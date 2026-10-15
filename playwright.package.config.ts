import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["packaged-web-smoke.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    serviceWorkers: "allow",
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: process.env.NEARLINK_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.NEARLINK_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  webServer: [
    {
      command: "node scripts/serve-extracted-web.mjs",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "python3 scripts/start-e2e-hub.py",
      url: "http://127.0.0.1:8000/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
