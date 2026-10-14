import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ignoredDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  ".unlazy",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const emDash = Buffer.from([0xe2, 0x80, 0x94]);
const containsEmDash = (contents) => contents.indexOf(emDash) !== -1;

if (!containsEmDash(Buffer.from([0xe2, 0x80, 0x94])) || containsEmDash(Buffer.from("plain text"))) {
  console.error("Em dash scanner self-check failed.");
  process.exit(2);
}

const listing = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024,
  },
);

if (listing.error) {
  console.error(`Could not list tracked files: ${listing.error.message}`);
  process.exit(2);
}
if (listing.status !== 0) {
  process.stderr.write(listing.stderr ?? Buffer.alloc(0));
  process.exit(listing.status ?? 2);
}

const paths = listing.stdout.toString("utf8").split("\0").filter(Boolean);
const violations = [];
const readErrors = [];

for (const filePath of paths) {
  if (filePath.split("/").some((part) => ignoredDirectoryNames.has(part))) {
    continue;
  }

  let contents;
  try {
    contents = readFileSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      continue;
    }
    readErrors.push(`${filePath}: ${error.message}`);
    continue;
  }

  const offset = contents.indexOf(emDash);
  if (containsEmDash(contents)) {
    violations.push(`${filePath}: U+2014 found at byte offset ${offset}`);
  }
}

if (readErrors.length > 0) {
  console.error("Could not read all tracked files:");
  for (const error of readErrors) console.error(`  ${error}`);
  process.exit(2);
}

if (violations.length > 0) {
  console.error("Em dash check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Em dash check passed for ${paths.length} project paths.`);
console.log("NO_EM_DASH_OK");
