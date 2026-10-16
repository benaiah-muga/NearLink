import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditOpenMlsResearchLock, evaluateAuditReport } from "./audit-openmls-rustsec.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(resolve(here, "fixtures", name), "utf8"));
}

test("accepts the documented proc-macro-error2 warning and keeps it reportable", async () => {
  const report = await fixture("openmls-audit-expected-warning.json");
  assert.deepEqual(evaluateAuditReport(report), {
    acceptedWarning: true,
    advisoryId: "RUSTSEC-2026-0173",
    packageName: "proc-macro-error2",
  });
});

test("rejects any additional or unknown warning", async () => {
  const report = await fixture("openmls-audit-unknown-warning.json");
  assert.throws(() => evaluateAuditReport(report), /reported 2 warnings/);
});

test("rejects a vulnerability even when warning categories are empty", async () => {
  const report = await fixture("openmls-audit-vulnerability.json");
  assert.throws(() => evaluateAuditReport(report), /reported vulnerabilities/);
});

test("rejects malformed reports and changed ignore settings", async () => {
  assert.throws(() => evaluateAuditReport({}), /ignore settings/);
  const report = await fixture("openmls-audit-expected-warning.json");
  report.settings.ignore.push("RUSTSEC-2026-0173");
  assert.throws(() => evaluateAuditReport(report), /ignore settings/);
});

test("rejects malformed cargo audit JSON", async () => {
  await assert.rejects(
    auditOpenMlsResearchLock({ root: here, run: () => ({ status: 0, stdout: "not json" }) }),
    /did not produce valid JSON/,
  );
});

test("fails when cargo audit exits unsuccessfully", async () => {
  await assert.rejects(
    auditOpenMlsResearchLock({ root: here, run: () => ({ status: 1, stdout: "", stderr: "" }) }),
    /exited with status 1/,
  );
});
