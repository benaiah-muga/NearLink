import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESEARCH_LOCK = "research/openmls-compat-spike/Cargo.lock";
const ALLOWED_IGNORES = ["RUSTSEC-2026-0330", "RUSTSEC-2026-0331"];
const EXPECTED_WARNING_ID = "RUSTSEC-2026-0173";
const EXPECTED_WARNING_PACKAGE = "proc-macro-error2";

function fail(message) {
  throw new Error(message);
}

export function evaluateAuditReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("RustSec report must be a JSON object.");
  }

  const ignores = report.settings?.ignore;
  if (!Array.isArray(ignores)
    || ignores.length !== ALLOWED_IGNORES.length
    || ALLOWED_IGNORES.some((id) => !ignores.includes(id))) {
    fail("RustSec ignore settings do not match the two documented OpenMLS exceptions.");
  }

  const vulnerabilities = report.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object"
    || typeof vulnerabilities.found !== "boolean"
    || !Number.isInteger(vulnerabilities.count)
    || !Array.isArray(vulnerabilities.list)) {
    fail("RustSec report has a malformed vulnerabilities section.");
  }
  if (vulnerabilities.found || vulnerabilities.count !== 0 || vulnerabilities.list.length !== 0) {
    const ids = vulnerabilities.list
      .map((item) => item?.advisory?.id)
      .filter((id) => typeof id === "string");
    fail(`RustSec reported vulnerabilities${ids.length ? `: ${ids.join(", ")}` : "."}`);
  }

  const warningGroups = report.warnings;
  if (!warningGroups || typeof warningGroups !== "object" || Array.isArray(warningGroups)) {
    fail("RustSec report has a malformed warnings section.");
  }

  const warnings = [];
  for (const [kind, items] of Object.entries(warningGroups)) {
    if (!Array.isArray(items)) fail(`RustSec warning group ${kind} is not an array.`);
    for (const item of items) warnings.push({ kind, item });
  }

  if (warnings.length === 0) return { acceptedWarning: false };
  if (warnings.length !== 1) {
    fail(`RustSec reported ${warnings.length} warnings; only ${EXPECTED_WARNING_ID} is permitted.`);
  }

  const [{ kind, item }] = warnings;
  const advisoryId = item?.advisory?.id;
  const packageName = item?.package?.name;
  if (kind !== "unmaintained"
    || advisoryId !== EXPECTED_WARNING_ID
    || packageName !== EXPECTED_WARNING_PACKAGE) {
    fail(`Unexpected RustSec warning: ${kind} ${advisoryId ?? "without an advisory ID"} for ${packageName ?? "an unknown package"}.`);
  }

  return { acceptedWarning: true, advisoryId, packageName };
}

export async function auditOpenMlsResearchLock({ root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), run = spawnSync } = {}) {
  const lockPath = resolve(root, RESEARCH_LOCK);
  const result = run("cargo", ["audit", "--json", "--file", lockPath], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.error) fail(`Could not run cargo audit: ${result.error.message}`);
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`cargo audit exited with status ${result.status ?? "unknown"}.`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail("cargo audit did not produce valid JSON.");
  }

  const outcome = evaluateAuditReport(report);
  if (outcome.acceptedWarning) {
    console.log(`::warning title=${outcome.advisoryId}::${outcome.advisoryId}: ${outcome.packageName} is unmaintained. This known warning is permitted only for the isolated OpenMLS research lock and is not product approval.`);
  } else {
    console.log("RustSec reported no vulnerabilities or unapproved warnings in the OpenMLS research lock.");
  }
  return outcome;
}

async function main() {
  try {
    await auditOpenMlsResearchLock();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
