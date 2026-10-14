import type { ClientPacket, MessagePacket, ServerPacket } from "@nearlink/protocol";

type Validator = "client" | "message" | "server" | "identifier" | "room";

type WasmValidator = (validator: string, valueJson: string) => string;
export const MAX_PROTOCOL_ENVELOPE_BYTES = 18 * 1024;

let wasmValidator: WasmValidator | null = null;
let initialization: Promise<boolean> | null = null;

export function initializeWasmProtocol(): Promise<boolean> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const wasm = await import("../generated/nearlink_protocol_wasm.js");
      await wasm.default();
      wasmValidator = wasm.validate_json;
      return true;
    } catch {
      wasmValidator = null;
      return false;
    }
  })();
  return initialization;
}

export function isWasmProtocolReady(): boolean {
  return wasmValidator !== null;
}

export function validateWithWasm(validator: "client", value: unknown): value is ClientPacket;
export function validateWithWasm(validator: "message", value: unknown): value is MessagePacket;
export function validateWithWasm(validator: "server", value: unknown): value is ServerPacket;
export function validateWithWasm(validator: "identifier" | "room", value: unknown): value is string;
export function validateWithWasm(validator: Validator, value: unknown): boolean;
export function validateWithWasm(validator: Validator, value: unknown): boolean {
  if (!wasmValidator) return false;
  try {
    return isValidResult(wasmValidator(validator, JSON.stringify(value)));
  } catch {
    return false;
  }
}

export function validateJsonWithWasm(validator: "client" | "message" | "server", json: string): boolean {
  if (!wasmValidator || !isBoundedProtocolJson(json)) return false;
  try {
    return isValidResult(wasmValidator(validator, json));
  } catch {
    return false;
  }
}

function isBoundedProtocolJson(json: string): boolean {
  if (json.length > MAX_PROTOCOL_ENVELOPE_BYTES) return false;
  return new TextEncoder().encode(json).byteLength <= MAX_PROTOCOL_ENVELOPE_BYTES;
}

function isValidResult(json: string): boolean {
  const result: unknown = JSON.parse(json);
  return typeof result === "object" && result !== null
    && "ok" in result && result.ok === true
    && "valid" in result && result.valid === true;
}
