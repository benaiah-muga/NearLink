import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "crates/protocol-wasm/Cargo.toml");
const wasmInput = path.join(
  root,
  "crates/protocol-wasm/target/wasm32-unknown-unknown/release/nearlink_protocol_wasm.wasm",
);
const output = path.join(root, "apps/web/src/generated");
const expectedToolVersion = "wasm-bindgen 0.2.103";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

const actualToolVersion = run("wasm-bindgen", ["--version"], { capture: true }).trim();
if (actualToolVersion !== expectedToolVersion) {
  console.error(`Expected ${expectedToolVersion}, found ${actualToolVersion || "no version"}.`);
  process.exit(1);
}

run("cargo", [
  "+1.84.1",
  "build",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
  "--manifest-path",
  manifest,
  "--locked",
]);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
run("wasm-bindgen", [
  wasmInput,
  "--target",
  "web",
  "--out-dir",
  output,
  "--out-name",
  "nearlink_protocol_wasm",
]);
console.log("NEARLINK_PROTOCOL_WASM_BUILD_OK");
