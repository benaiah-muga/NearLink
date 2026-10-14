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
    expect(validateJson).not.toHaveBeenCalled();
  });
});
