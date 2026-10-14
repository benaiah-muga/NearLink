import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [cli, "run"], { stdio: "inherit" });

if (result.error) {
  console.error(`Could not start Vitest: ${result.error.message}`);
  process.exit(2);
}
if (result.status !== 0) {
  process.exit(result.status ?? 2);
}

console.log("NEARLINK_UNIT_TESTS_OK");
