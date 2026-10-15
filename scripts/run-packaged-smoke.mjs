import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = process.argv[2];
if (!artifactDir) {
  console.error("Usage: node scripts/run-packaged-smoke.mjs <artifact-directory>");
  process.exit(2);
}

const extraction = await mkdtemp(path.join(os.tmpdir(), "nearlink-packaged-smoke-"));
try {
  const inspect = spawnSync("python3", [path.join(root, "scripts/inspect-web-archive.py"), artifactDir, extraction], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (inspect.error) throw inspect.error;
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);
  if (inspect.status !== 0) process.exitCode = inspect.status ?? 1;
  else {
    const packageDir = inspect.stdout.trim().split(/\r?\n/).at(-1);
    const test = spawnSync("npx", ["playwright", "test", "--config", "playwright.package.config.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      env: { ...process.env, NEARLINK_EXTRACTED_WEB_DIR: packageDir },
    });
    if (test.error) throw test.error;
    process.exitCode = test.status ?? 1;
  }
} finally {
  await rm(extraction, { recursive: true, force: true });
}
