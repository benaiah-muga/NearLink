import { defineConfig, devices } from "@playwright/test";

const localChromiumPath = process.env.NEARLINK_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: localChromiumPath ? { executablePath: localChromiumPath } : undefined,
      },
      testIgnore: "cross-browser-smoke.spec.ts",
    },
    {
      name: "firefox-smoke",
      testMatch: ["cross-browser-smoke.spec.ts", "real-hub-compat.spec.ts"],
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-smoke",
      testMatch: ["cross-browser-smoke.spec.ts", "real-hub-compat.spec.ts"],
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: [
    {
      command: "npm run preview --workspace @nearlink/web -- --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
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
