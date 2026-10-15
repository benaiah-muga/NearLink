import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolWasmManifest = "crates/protocol-wasm/Cargo.toml";
const maxCommandOutput = 512 * 1024 * 1024;

export function validateVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (!semver.test(version)) {
    throw new Error("Release version must be a plain semantic version.");
  }
  return version;
}

export function forbiddenArtifactPath(entry) {
  const normalized = entry.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const patterns = [
    /^\.env(?:$|\.)/i,
    /^\.npmrc$/i,
    /^\.netrc$/i,
    /^credentials?(?:$|\.)/i,
    /^secrets?(?:$|\.)/i,
    /^id_(?:rsa|ed25519)(?:$|\.)/i,
    /\.(?:pem|key|p12|pfx|sqlite3?|db|log)$/i,
    /(?:^|[-_.])(?:local[-_.]?state|browser[-_.]?(?:profile|data)|indexeddb)(?:$|[-_.])/i,
  ];
  return parts.some((part) => patterns.some((pattern) => pattern.test(part)));
}

export function validateWebBundleEntries(entries) {
  const names = new Set(entries.map((entry) => entry.replace(/^\.\//, "")));
  for (const required of ["index.html", "manifest.webmanifest", "sw.js", "icon.svg"]) {
    if (!names.has(required)) throw new Error(`Web bundle is missing required PWA file: ${required}`);
  }
  const forbidden = entries.find(forbiddenArtifactPath);
  if (forbidden) throw new Error(`Web bundle contains a prohibited secret or local-state path: ${forbidden}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    env: process.env,
    maxBuffer: maxCommandOutput,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.${detail}`);
  }
  return result.stdout ?? "";
}

function git(args) {
  return run("git", args, { capture: true }).trim();
}

function requireCleanCheckout(commit) {
  const head = git(["rev-parse", "HEAD"]);
  if (head !== commit) throw new Error(`Checkout HEAD ${head} does not match candidate commit ${commit}.`);
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) {
    throw new Error(`Candidate commit ${commit} does not match GITHUB_SHA ${process.env.GITHUB_SHA}.`);
  }
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Candidate build requires a clean checkout with no tracked or untracked changes.");
  }
}

function readTrackedPaths(commit) {
  const output = run("git", ["ls-tree", "-r", "--name-only", "-z", commit], { capture: true });
  return output.split("\0").filter(Boolean);
}

function rejectUnsafeSourcePaths(commit) {
  const unsafe = readTrackedPaths(commit).find(forbiddenArtifactPath);
  if (unsafe) throw new Error(`Source archive contains a prohibited secret or local-state path: ${unsafe}`);
}

async function listFiles(directory, prefix = "") {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(absolute);
    if (info.isDirectory()) entries.push(...(await listFiles(absolute, relative)));
    else if (info.isFile()) entries.push(relative);
    else throw new Error(`Web bundle contains an unsupported filesystem entry: ${relative}`);
  }
  return entries;
}

function archiveTar(tarArgs, destination) {
  const tar = spawnSync("tar", tarArgs, {
    cwd: root,
    encoding: null,
    maxBuffer: maxCommandOutput,
  });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr?.toString("utf8") ?? "unknown error"}`);
  const compressed = spawnSync("gzip", ["-n"], {
    cwd: root,
    encoding: null,
    input: tar.stdout,
    maxBuffer: maxCommandOutput,
  });
  if (compressed.error) throw compressed.error;
  if (compressed.status !== 0) throw new Error(`gzip failed: ${compressed.stderr?.toString("utf8") ?? "unknown error"}`);
  return writeFile(destination, compressed.stdout);
}

function archiveGitCommit(commit, prefix, destination) {
  const archive = spawnSync("git", ["archive", "--format=tar", `--prefix=${prefix}`, commit], {
    cwd: root,
    encoding: null,
    maxBuffer: maxCommandOutput,
  });
  if (archive.error) throw archive.error;
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr?.toString("utf8") ?? "unknown error"}`);
  const compressed = spawnSync("gzip", ["-n"], {
    cwd: root,
    encoding: null,
    input: archive.stdout,
    maxBuffer: maxCommandOutput,
  });
  if (compressed.error) throw compressed.error;
  if (compressed.status !== 0) throw new Error(`gzip failed: ${compressed.stderr?.toString("utf8") ?? "unknown error"}`);
  return writeFile(destination, compressed.stdout);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function archiveWeb(dist, version, epoch, destination) {
  const entries = await listFiles(dist);
  validateWebBundleEntries(entries);
  const manifest = JSON.parse(await readFile(path.join(dist, "manifest.webmanifest"), "utf8"));
  if (!Array.isArray(manifest.icons) || !manifest.icons.some((icon) => icon.src === "/icon.svg")) {
    throw new Error("PWA manifest must reference the packaged /icon.svg icon.");
  }
  const stage = await mkdtemp(path.join(os.tmpdir(), "nearlink-web-stage-"));
  const packageRoot = `nearlink-${version}-web`;
  try {
    await mkdir(path.join(stage, packageRoot));
    for (const entry of entries) {
      const source = path.join(dist, entry);
      const target = path.join(stage, packageRoot, entry);
      await mkdir(path.dirname(target), { recursive: true });
      const info = await stat(source);
      await writeFile(target, await readFile(source), { mode: info.mode & 0o777 });
    }
    await archiveTar(
      [
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=gnu",
        "-cf",
        "-",
        "-C",
        stage,
        packageRoot,
      ],
      destination,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function runtimeVersion(command, args) {
  return run(command, args, { capture: true }).trim();
}

function checkPinnedRuntime() {
  const node = process.version;
  if (node !== "v24.18.0") throw new Error(`Expected Node v24.18.0, found ${node}.`);
  const rustc = runtimeVersion("rustc", ["+1.84.1", "--version"]);
  if (!rustc.startsWith("rustc 1.84.1 ")) throw new Error(`Expected Rust 1.84.1, found ${rustc}.`);
  const wasmBindgen = runtimeVersion("wasm-bindgen", ["--version"]);
  if (wasmBindgen !== "wasm-bindgen 0.2.103") throw new Error(`Expected wasm-bindgen 0.2.103, found ${wasmBindgen}.`);
  return {
    node,
    npm: runtimeVersion("npm", ["--version"]),
    rustc,
    cargo: runtimeVersion("cargo", ["+1.84.1", "--version"]),
    wasmBindgen,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

function resetBuildOutputs() {
  run("cargo", ["+1.84.1", "clean", "--manifest-path", path.join(root, protocolWasmManifest)]);
  return rm(path.join(root, "apps/web/dist"), { recursive: true, force: true });
}

async function buildWebArchive(version, epoch, destination) {
  await resetBuildOutputs();
  run("npm", ["run", "build"]);
  await archiveWeb(path.join(root, "apps/web/dist"), version, epoch, destination);
}

export async function validateOutputDirectory(directory) {
  const resolved = path.resolve(directory);
  const missingSegments = [];
  let existingAncestor = resolved;
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  const canonicalOutput = path.resolve(await realpath(existingAncestor), ...missingSegments);
  const canonicalRoot = await realpath(root);
  const relative = path.relative(canonicalRoot, canonicalOutput);
  const isInsideCheckout =
    relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  if (isInsideCheckout) {
    throw new Error("Artifact output directory must be outside the source checkout.");
  }
  return canonicalOutput;
}

async function buildCandidate() {
  const commit = process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Candidate source commit must be a full Git object ID.");
  requireCleanCheckout(commit);
  rejectUnsafeSourcePaths(commit);

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = validateVersion(process.env.NEARLINK_RELEASE_VERSION ?? packageJson.version);
  const output = await validateOutputDirectory(
    process.env.NEARLINK_ARTIFACT_DIR ?? path.join(os.tmpdir(), `nearlink-artifacts-${commit.slice(0, 12)}`),
  );
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error("Artifact output directory must be empty.");

  const runtimes = checkPinnedRuntime();
  const epochText = git(["show", "-s", "--format=%ct", commit]);
  if (!/^\d+$/.test(epochText)) throw new Error("Could not derive the source timestamp from the candidate commit.");
  const sourceDateEpoch = Number(epochText);
  const webName = `nearlink-${version}-web.tar.gz`;
  const sourceName = `nearlink-${version}-source.tar.gz`;
  const webPath = path.join(output, webName);
  const repeatWebPath = path.join(output, `.repeat-${webName}`);
  const sourcePath = path.join(output, sourceName);

  await buildWebArchive(version, sourceDateEpoch, webPath);
  const firstWebHash = await sha256(webPath);
  await buildWebArchive(version, sourceDateEpoch, repeatWebPath);
  const repeatWebHash = await sha256(repeatWebPath);
  if (firstWebHash !== repeatWebHash) throw new Error("Clean same-source web archive rebuild produced a different SHA-256.");
  await rm(repeatWebPath);

  const sourcePrefix = `nearlink-${version}/`;
  await archiveGitCommit(commit, sourcePrefix, sourcePath);
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Build changed the source checkout. Candidate artifacts were not finalized.");
  }

  const artifacts = [];
  for (const [name, file] of [[webName, webPath], [sourceName, sourcePath]]) {
    artifacts.push({ name, sizeBytes: (await stat(file)).size, sha256: await sha256(file) });
  }
  const manifest = {
    schemaVersion: 1,
    sourceCommit: commit,
    version,
    sourceDateEpoch,
    runtimes,
    artifacts,
    webArchiveRepeatBuild: {
      sameSourceCommit: commit,
      sha256: firstWebHash,
      matches: true,
      scope: "Two clean builds on this workflow runner. This is not cross-machine reproducibility evidence.",
    },
    publication: "Workflow artifact for review only. No GitHub Release is created or published.",
  };
  await writeFile(path.join(output, "SHA256SUMS.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Release candidate artifacts prepared in ${output}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  buildCandidate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
