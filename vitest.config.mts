import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "apps/web/**/*.test.{ts,tsx}"],
    environment: "node",
    // App and storage tests share fake IndexedDB state across files.
    fileParallelism: false,
  },
});
