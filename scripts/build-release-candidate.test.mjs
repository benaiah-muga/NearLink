import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  forbiddenArtifactPath,
  validateOutputDirectory,
  validateVersion,
  validateWebBundleEntries,
} from "./build-release-candidate.mjs";

test("accepts plain release versions and rejects path or shell syntax", () => {
  assert.equal(validateVersion("1.2.3"), "1.2.3");
  assert.equal(validateVersion("1.2.3-rc.1+build.9"), "1.2.3-rc.1+build.9");
  for (const version of ["", "latest", "01.2.3", "1.2.3-", "1.2.3+", "../1.2.3", "1.2.3/other", "1.2.3;echo"]) {
    assert.throws(() => validateVersion(version));
  }
});

test("rejects an output path that reaches the checkout through a symlink", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nearlink-output-path-test-"));
  const checkoutLink = path.join(temporary, "checkout-link");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await symlink(repositoryRoot, checkoutLink, "dir");
    await assert.rejects(
      validateOutputDirectory(path.join(checkoutLink, "candidate-artifacts")),
      /outside the source checkout/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects secret and local browser state paths from package inputs", () => {
  for (const entry of [
    ".env",
    ".env.production",
    "config/credentials.json",
    "keys/id_ed25519",
    "private.pem",
    "data/history.sqlite",
    "profile/IndexedDB/000001.log",
    "state/local-state.json",
  ]) {
    assert.equal(forbiddenArtifactPath(entry), true, entry);
  }
  for (const entry of ["src/App.tsx", "docs/security/threat-model.md", "apps/web/public/icon.svg"]) {
    assert.equal(forbiddenArtifactPath(entry), false, entry);
  }
});

test("requires the production shell, service worker, manifest, and icon", () => {
  assert.doesNotThrow(() =>
    validateWebBundleEntries(["index.html", "manifest.webmanifest", "sw.js", "icon.svg", "assets/app.js"]),
  );
  assert.throws(() => validateWebBundleEntries(["index.html", "manifest.webmanifest", "sw.js"]), /icon.svg/);
  assert.throws(
    () => validateWebBundleEntries(["index.html", "manifest.webmanifest", "sw.js", "icon.svg", ".env"]),
    /prohibited/,
  );
});
