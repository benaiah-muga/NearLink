import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "py" : "python3";
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this verifier through npm so npm_execpath is available.");
  process.exit(2);
}

const checks = [
  [process.execPath, [npmCli, "run", "build"]],
  [process.execPath, [npmCli, "run", "test:unit"]],
  [python, ["-m", "pytest", "-q", "services/local-hub/tests"]],
  ["node", ["scripts/check-em-dash.mjs"]],
];

for (const [command, args] of checks) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start ${command}: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 2);
  }
}

console.log("\nNEARLINK_FOUNDATION_VERIFY_OK");
console.log("NEARLINK_FULL_VERIFY_OK");
