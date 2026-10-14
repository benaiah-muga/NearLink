import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../generated/nearlink_protocol_wasm.js");
  vi.resetModules();
});

describe("WASM protocol validator bridge", () => {
  it("initializes explicitly and accepts valid Rust validator results", async () => {
    const validateJson = vi.fn(() => JSON.stringify({ ok: true, valid: true }));
    const initialize = vi.fn(async () => undefined);
    vi.doMock("../generated/nearlink_protocol_wasm.js", () => ({ default: initialize, validate_json: validateJson }));
    const bridge = await import("./wasmProtocol");

    expect(bridge.isWasmProtocolReady()).toBe(false);
    expect(await bridge.initializeWasmProtocol()).toBe(true);
    expect(bridge.isWasmProtocolReady()).toBe(true);
    expect(bridge.validateWithWasm("message", { type: "message" })).toBe(true);
    expect(validateJson).toHaveBeenCalledWith("message", JSON.stringify({ type: "message" }));
    const raw = '{"version":1,"type":"server"}';
    expect(bridge.validateJsonWithWasm("server", raw)).toBe(true);
    expect(validateJson).toHaveBeenCalledWith("server", raw);
    expect(bridge.validateJsonWithWasm("server", "x".repeat(18 * 1024 + 1))).toBe(false);
    expect(bridge.validateJsonWithWasm("server", "é".repeat(9 * 1024 + 1))).toBe(false);
  });

  it("rejects invalid packet results from the ready Rust validator", async () => {
    const validateJson = vi.fn(() => JSON.stringify({ ok: true, valid: false }));
    const initialize = vi.fn(async () => undefined);
    vi.doMock("../generated/nearlink_protocol_wasm.js", () => ({ default: initialize, validate_json: validateJson }));
    const bridge = await import("./wasmProtocol");

    expect(await bridge.initializeWasmProtocol()).toBe(true);
    expect(bridge.validateWithWasm("server", { version: 1, type: "unknown" })).toBe(false);
    expect(validateJson).toHaveBeenCalledOnce();
  });

  it("remains fail closed after WASM initialization fails", async () => {
    const validateJson = vi.fn(() => JSON.stringify({ ok: true, valid: false }));
    const initialize = vi.fn(async () => { throw new Error("WASM unavailable"); });
    vi.doMock("../generated/nearlink_protocol_wasm.js", () => ({ default: initialize, validate_json: validateJson }));
    const bridge = await import("./wasmProtocol");

    expect(await bridge.initializeWasmProtocol()).toBe(false);
    expect(bridge.isWasmProtocolReady()).toBe(false);
    expect(bridge.validateWithWasm("server", { type: "message" })).toBe(false);
    expect(bridge.isWasmSyncStateReady()).toBe(false);
    expect(() => bridge.createWasmSyncRequestBook()).toThrow("WASM synchronization state is unavailable.");
    expect(validateJson).not.toHaveBeenCalled();
  });

  it("wraps the WASM inventory and request state APIs with typed, fail-closed results", async () => {
    const initialize = vi.fn(async () => undefined);
    const inventoryFree = vi.fn();
    const requestFree = vi.fn();
    const acceptPage = vi.fn()
      .mockReturnValueOnce(JSON.stringify({ ok: true, outcome: "accepted", ids: ["a"], complete: true, limitReached: false }))
      .mockReturnValueOnce(JSON.stringify({ ok: false, code: "inventory_conflict" }));
    class WasmSyncInventoryReceiver {
      accept_page_json = acceptPage;
      free = inventoryFree;
    }
    class WasmSyncRequestBook {
      register_request_json = vi.fn(() => JSON.stringify({ ok: true, outcome: "accepted" }));
      accept_completion_json = vi.fn(() => JSON.stringify({ ok: true, outcome: "duplicate" }));
      free = requestFree;
    }
    vi.doMock("../generated/nearlink_protocol_wasm.js", () => ({
      default: initialize,
      validate_json: () => JSON.stringify({ ok: true, valid: true }),
      WasmSyncInventoryReceiver,
      WasmSyncRequestBook,
    }));
    const bridge = await import("./wasmProtocol");

    expect(await bridge.initializeWasmProtocol()).toBe(true);
    expect(bridge.isWasmSyncStateReady()).toBe(true);
    const inventory = bridge.createWasmSyncInventoryReceiver();
    expect(inventory.acceptPage({ type: "sync_inventory_page" } as never)).toEqual({ outcome: "accepted", ids: ["a"], complete: true, limitReached: false });
    expect(() => inventory.acceptPage({ type: "sync_inventory_page" } as never)).toThrow("WASM rejected synchronization inventory state.");
    inventory.free();
    const requests = bridge.createWasmSyncRequestBook();
    expect(requests.registerRequest({ type: "sync_missing_request" } as never)).toBe("accepted");
    expect(requests.acceptCompletion({ type: "sync_page_complete" } as never)).toBe("duplicate");
    requests.free();
    expect(inventoryFree).toHaveBeenCalledOnce();
    expect(requestFree).toHaveBeenCalledOnce();
  });
});
