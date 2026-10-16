import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "crates/protocol-wasm/Cargo.toml");
const wasmInput = path.join(
  root,
  "crates/protocol-wasm/target/wasm32-unknown-unknown/release/nearlink_protocol_wasm.wasm",
);
const temp = await mkdtemp(path.join(tmpdir(), "nearlink-protocol-wasm-"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

let server;
let browser;

try {
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
  run("wasm-bindgen", [
    wasmInput,
    "--target",
    "web",
    "--out-dir",
    temp,
    "--out-name",
    "nearlink_protocol_wasm",
  ]);

  await writeFile(
    path.join(temp, "index.html"),
    `<!doctype html>
<meta charset="utf-8">
<script type="module">
  import init, { validate_json, validate_sync_accepted_message_batch_json, classify_inbound_json, plan_missing_batch_json, WasmLocalInventory, WasmMessageIndex, WasmMissingIdSelector, WasmSyncCoverage, WasmSyncInventoryReceiver, WasmSyncRequestBook } from "./nearlink_protocol_wasm.js";

  const check = (condition, label) => {
    if (!condition) throw new Error(label);
  };
  const result = (value) => JSON.parse(value);
  const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;

  try {
    await init();
    const coverage = new WasmSyncCoverage();
    check(coverage.outcome() === "complete", "coverage initial state mismatch");
    coverage.begin_plan();
    coverage.begin_plan();
    check(coverage.outcome() === "syncing", "coverage did not wait for active peer plans");
    coverage.finish_plan();
    check(coverage.outcome() === "syncing", "coverage completed before all peer plans finished");
    coverage.abandon_plan();
    check(coverage.outcome() === "partial", "coverage did not preserve incomplete outcome");
    coverage.free();
    const incompleteInventory = new WasmLocalInventory(JSON.stringify({ version: 1, room: "room1", ids: [], scanComplete: false, acceptedIdOverflow: false }));
    check(result(incompleteInventory.status_json()).code === "incomplete_local_inventory", "unproven incomplete local inventory was accepted");
    incompleteInventory.free();
    const emptyInventory = new WasmLocalInventory(JSON.stringify({ version: 1, room: "room1", ids: [], scanComplete: true, acceptedIdOverflow: false }));
    const emptyPage = result(emptyInventory.page_json("device1", "session1", 0));
    check(result(emptyInventory.status_json()).ok && emptyPage.packet.messageIds.length === 0 && !emptyPage.packet.limitReached, "empty local inventory mismatch");
    emptyInventory.free();
    const localIds = Array.from({ length: 4096 }, (_, index) => "id-" + String(index).padStart(4, "0"));
    const localInventory = new WasmLocalInventory(JSON.stringify({ version: 1, room: "room1", ids: localIds, scanComplete: false, acceptedIdOverflow: true }));
    check(result(localInventory.status_json()).ok, "verified overflow snapshot rejected");
    check(localInventory.contains("id-0042") && !localInventory.contains("missing"), "frozen local membership mismatch");
    const missing = result(localInventory.missing_ids_json(JSON.stringify(["id-0042", "id-9999"])));
    check(JSON.stringify(missing.missingIds) === JSON.stringify(["id-9999"]), "local inventory missing-ID comparison mismatch");
    const boundedPage = result(localInventory.page_json("device1", "session1", 4000));
    check(boundedPage.packet.messageIds.length === 96 && boundedPage.packet.limitReached, "verified overflow final page mismatch");
    check(!result(localInventory.page_json("device1", "session1", 0)).packet.limitReached, "overflow flag appeared before final page");
    localInventory.free();
    const vectors = await fetch("/vectors.json").then((response) => response.json());
    const syncVectors = await fetch("/sync-state-vectors.json").then((response) => response.json());
    const acceptedBatchVectors = await fetch("/sync-accepted-message-batch-vectors.json").then((response) => response.json());
    const acceptanceVectors = await fetch("/inbound-acceptance-vectors.json").then((response) => response.json());
    for (const vector of vectors) {
      const actual = result(validate_json(vector.validator, JSON.stringify(vector.value)));
      check(actual.ok && actual.valid === vector.valid, "protocol vector mismatch");
    }
    for (const vector of acceptanceVectors) {
      const candidateJson = vector.candidateJson ?? JSON.stringify(vector.candidate);
      const existingJson = vector.existing === undefined ? undefined : JSON.stringify(vector.existing);
      const actual = result(classify_inbound_json(vector.expectedRoom, vector.roomDeleted, candidateJson, existingJson));
      const expected = vector.expected.outcome
        ? { ok: true, outcome: vector.expected.outcome }
        : { ok: false, code: vector.expected.code };
      check(JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)), "acceptance vector mismatch: " + vector.name);
      if (!actual.ok) check(Object.keys(actual).sort().join(",") === "code,ok", "acceptance error leaked packet data");
    }
    for (const vector of acceptedBatchVectors) {
      const batch = JSON.parse(JSON.stringify(vector.batch));
      const expectedIds = vector.largeRequestedIdCount === undefined
        ? vector.expectedIds
        : Array.from({ length: vector.largeRequestedIdCount }, (_, index) => "id" + String(index).padStart(3, "0"));
      if (vector.largeRequestedIdCount !== undefined) batch.requestedIds = expectedIds;
      if (vector.largeBodyChars !== undefined) batch.messages[0].body = "x".repeat(vector.largeBodyChars);
      const actual = result(validate_sync_accepted_message_batch_json(
        JSON.stringify(batch),
        vector.expectedRoom,
        JSON.stringify(expectedIds),
      ));
      check(actual.ok && actual.valid === vector.valid, "accepted-message batch vector mismatch: " + vector.name);
    }
    const acceptedBatch = { version: 1, room: "room1", requestedIds: [], roomState: "available", messages: [] };
    const oversizedRawBatch = JSON.stringify(acceptedBatch) + " ".repeat(2 * 1024 * 1024 + 1);
    check(result(validate_sync_accepted_message_batch_json(oversizedRawBatch, "room1", "[]")).code === "input_too_large", "accepted-message batch raw UTF-8 bound missing");

    const packet = (id, body) => JSON.stringify({
      version: 1,
      type: "message",
      id,
      room: "room1",
      sender: "device1",
      senderName: "Amina",
      createdAt: "2026-10-14T12:00:00Z",
      body,
    });
    const index = new WasmMessageIndex("room1");
    check(result(index.status_json()).ok, "valid room rejected");
    check(result(index.insert_json(packet("b", "second"))).outcome === "inserted", "insert failed");
    check(result(index.insert_json(packet("a", "first"))).outcome === "inserted", "insert failed");
    check(result(index.insert_json(packet("a", "first"))).outcome === "duplicate", "duplicate failed");
    check(result(index.insert_json(packet("a", "changed"))).code === "message_conflict", "conflict missing");
    const first = result(index.page_json("[]", undefined, 1));
    check(first.messages[0].id === "a" && first.nextCursor === "a" && first.hasMore, "first page mismatch");
    const second = result(index.page_json("[]", "a", 1));
    check(second.messages[0].id === "b" && !second.hasMore, "second page mismatch");
    check(result(index.insert_json(" ".repeat(18 * 1024 + 1))).code === "input_too_large", "input limit missing");

    for (const vector of syncVectors) {
      let inventory = new WasmSyncInventoryReceiver();
      let requests = new WasmSyncRequestBook();
      let selector = null;
      for (const operation of vector.operations) {
        const encoded = JSON.stringify(operation.value);
        let actual;
        if (operation.kind === "inventory_page") actual = result(inventory.accept_page_json(encoded));
        else if (operation.kind === "set_missing_ids") actual = result(inventory.set_missing_ids_json(JSON.stringify(operation.value.ids)));
        else if (operation.kind === "inventory_batch") actual = result(inventory.next_missing_batch_json());
        else if (operation.kind === "selector_start") {
          selector = new WasmMissingIdSelector(JSON.stringify(operation.value.peerIds));
          actual = result(selector.status_json());
        } else if (operation.kind === "selector_local") actual = result(selector.observe_local_ids_json(JSON.stringify(operation.value.localIds)));
        else if (operation.kind === "selector_finish") actual = result(selector.finish_json());
        else if (operation.kind === "plan_batch") actual = result(plan_missing_batch_json(JSON.stringify(operation.value.missingIds), operation.value.offset));
        else if (operation.kind === "request") actual = result(requests.register_request_json(encoded));
        else if (operation.kind === "completion") actual = result(requests.accept_completion_json(encoded));
        else if (operation.kind === "observe_message") actual = result(requests.observe_message_json(encoded));
        else if (operation.kind === "stage_completion") actual = result(requests.stage_completion_json(encoded));
        else if (operation.kind === "finish_completion") actual = result(requests.finish_completion_json(operation.value.requestId, operation.value.durable));
        else if (operation.kind === "outstanding") actual = { ok: true, outstanding: requests.has_outstanding_message_id(operation.value.id) };
        else if (operation.kind === "durable_check") actual = result(requests.verify_durable_messages_json(operation.value.requestId, JSON.stringify(operation.value.packets)));
        else if (operation.kind === "reset_state") {
          inventory.free();
          requests.free();
          inventory = new WasmSyncInventoryReceiver();
          requests = new WasmSyncRequestBook();
          actual = { ok: true };
        } else if (operation.kind === "fill_requests") {
          for (let index = 0; index < operation.value.count; index += 1) {
            const request = { version: 1, type: "sync_missing_request", room: "room1", syncId: "sync-1", requestId: "bounded-" + index, sender: "device-a", targetSender: "device-b", messageIds: ["alpha"] };
            requests.register_request_json(JSON.stringify(request));
          }
          actual = { ok: true, count: operation.value.count };
        } else throw new Error("unknown sync vector operation");
        check(
          JSON.stringify(stable(actual)) === JSON.stringify(stable(operation.expected)),
          "sync state vector mismatch: " + vector.name + " (" + operation.kind + ")",
        );
        if (!actual.ok) {
          check(Object.keys(actual).sort().join(",") === "code,ok", "sync error leaked packet data");
        }
      }
      inventory.free();
      requests.free();
      selector?.free();
    }
    const oversized = " ".repeat(600 * 1024 + 1);
    check(result(new WasmMissingIdSelector(oversized).status_json()).code === "input_too_large", "selector constructor byte limit missing");
    const boundedSelector = new WasmMissingIdSelector(JSON.stringify(["peer"]));
    check(result(boundedSelector.observe_local_ids_json(oversized)).code === "input_too_large", "selector scan byte limit missing");
    check(result(boundedSelector.observe_local_ids_json(JSON.stringify(Array(4097).fill("peer")))).code === "invalid_page_limit", "selector chunk count limit missing");
    check(result(plan_missing_batch_json(oversized, 0)).code === "input_too_large", "batch planner byte limit missing");
    check(result(new WasmMissingIdSelector(JSON.stringify(Array(4097).fill("peer"))).status_json()).code === "known_id_limit", "peer inventory count limit missing");
    boundedSelector.free();
    window.__protocolWasmResult = { ok: true, vectorCount: vectors.length, syncVectorCount: syncVectors.length, acceptedBatchVectorCount: acceptedBatchVectors.length };
  } catch (error) {
    window.__protocolWasmResult = { ok: false, error: String(error) };
  }
</script>`,
  );
  const vectors = await readFile(path.join(root, "packages/protocol/vectors/v1.json"));
  await writeFile(path.join(temp, "vectors.json"), vectors);
  const syncVectors = await readFile(path.join(root, "packages/protocol/vectors/sync-state-v1.json"));
  await writeFile(path.join(temp, "sync-state-vectors.json"), syncVectors);
  const acceptedBatchVectors = await readFile(path.join(root, "packages/protocol/vectors/sync-accepted-message-batch-v1.json"));
  await writeFile(path.join(temp, "sync-accepted-message-batch-vectors.json"), acceptedBatchVectors);
  const acceptanceVectors = await readFile(path.join(root, "packages/protocol/vectors/inbound-acceptance-v1.json"));
  await writeFile(path.join(temp, "inbound-acceptance-vectors.json"), acceptanceVectors);

  server = createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const filename = requested === "/vectors.json"
      ? "vectors.json"
      : requested === "/sync-state-vectors.json"
        ? "sync-state-vectors.json"
        : requested === "/sync-accepted-message-batch-vectors.json"
          ? "sync-accepted-message-batch-vectors.json"
        : requested === "/inbound-acceptance-vectors.json"
          ? "inbound-acceptance-vectors.json"
        : requested === "/"
          ? "index.html"
          : path.basename(requested);
    if (filename !== "index.html" && filename !== "vectors.json" && filename !== "sync-state-vectors.json" && filename !== "sync-accepted-message-batch-vectors.json" && filename !== "inbound-acceptance-vectors.json" && !/^[\w.-]+$/.test(filename)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = await readFile(path.join(temp, filename));
      response.writeHead(200, {
        "content-type": filename.endsWith(".json")
          ? "application/json"
          : filename.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : filename.endsWith(".wasm")
              ? "application/wasm"
              : "text/html; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const launchOptions = { headless: true };
  if (process.env.NEARLINK_CHROMIUM_EXECUTABLE) {
    launchOptions.executablePath = process.env.NEARLINK_CHROMIUM_EXECUTABLE;
  }
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.__protocolWasmResult !== undefined);
  const result = await page.evaluate(() => window.__protocolWasmResult);
  assert.equal(result.ok, true, result.error ?? "WebAssembly browser check failed");
    console.log(`NEARLINK_PROTOCOL_WASM_BROWSER_OK vectors=${result.vectorCount} syncStateVectors=${result.syncVectorCount} acceptedBatchVectors=${result.acceptedBatchVectorCount} localInventory=ok`);
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
