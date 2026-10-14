import type {
  ClientPacket,
  MessagePacket,
  ServerPacket,
  SyncInventoryPagePacket,
  SyncMissingRequestPacket,
  SyncPageCompletePacket,
} from "@nearlink/protocol";

type Validator = "client" | "message" | "server" | "identifier" | "room";

type WasmValidator = (validator: string, valueJson: string) => string;

export interface SyncInventoryState {
  acceptPage(packet: SyncInventoryPagePacket): { outcome: "accepted" | "duplicate"; ids: string[]; complete: boolean; limitReached: boolean };
  free(): void;
}

export interface SyncRequestState {
  registerRequest(packet: SyncMissingRequestPacket): "accepted" | "duplicate";
  acceptCompletion(packet: SyncPageCompletePacket): "accepted" | "duplicate";
  free(): void;
}

interface WasmSyncModule {
  WasmSyncInventoryReceiver: new () => {
    accept_page_json(pageJson: string): string;
    free(): void;
  };
  WasmSyncRequestBook: new () => {
    register_request_json(requestJson: string): string;
    accept_completion_json(completionJson: string): string;
    free(): void;
  };
}

type WasmModule = WasmSyncModule & {
  default: () => Promise<unknown>;
  validate_json: WasmValidator;
};

export const MAX_PROTOCOL_ENVELOPE_BYTES = 18 * 1024;

let wasmValidator: WasmValidator | null = null;
let wasmSyncModule: WasmSyncModule | null = null;
let initialization: Promise<boolean> | null = null;

export function initializeWasmProtocol(): Promise<boolean> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const wasm = await import("../generated/nearlink_protocol_wasm.js") as WasmModule;
      await wasm.default();
      wasmValidator = wasm.validate_json;
      wasmSyncModule = "WasmSyncInventoryReceiver" in wasm && "WasmSyncRequestBook" in wasm
        && typeof wasm.WasmSyncInventoryReceiver === "function"
        && typeof wasm.WasmSyncRequestBook === "function" ? wasm : null;
      return true;
    } catch {
      wasmValidator = null;
      wasmSyncModule = null;
      return false;
    }
  })();
  return initialization;
}

export function isWasmProtocolReady(): boolean {
  return wasmValidator !== null;
}

export function isWasmSyncStateReady(): boolean {
  return wasmSyncModule !== null;
}

export function createWasmSyncInventoryReceiver(): SyncInventoryState {
  if (!wasmSyncModule) throw new Error("WASM synchronization state is unavailable.");
  const receiver = new wasmSyncModule.WasmSyncInventoryReceiver();
  return {
    acceptPage(packet) {
      const result = parseSyncResult(receiver.accept_page_json(JSON.stringify(packet)));
      if (result.ok !== true || (result.outcome !== "accepted" && result.outcome !== "duplicate")
        || !Array.isArray(result.ids) || !result.ids.every((id) => typeof id === "string")
        || typeof result.complete !== "boolean" || typeof result.limitReached !== "boolean") {
        throw new Error("WASM rejected synchronization inventory state.");
      }
      return { outcome: result.outcome, ids: result.ids, complete: result.complete, limitReached: result.limitReached };
    },
    free: () => receiver.free(),
  };
}

export function createWasmSyncRequestBook(): SyncRequestState {
  if (!wasmSyncModule) throw new Error("WASM synchronization state is unavailable.");
  const book = new wasmSyncModule.WasmSyncRequestBook();
  const outcome = (json: string): "accepted" | "duplicate" => {
    const result = parseSyncResult(json);
    if (result.ok !== true || (result.outcome !== "accepted" && result.outcome !== "duplicate")) {
      throw new Error("WASM rejected synchronization request state.");
    }
    return result.outcome;
  };
  return {
    registerRequest: (packet) => outcome(book.register_request_json(JSON.stringify(packet))),
    acceptCompletion: (packet) => outcome(book.accept_completion_json(JSON.stringify(packet))),
    free: () => book.free(),
  };
}

function parseSyncResult(json: string): Record<string, unknown> {
  const result: unknown = JSON.parse(json);
  if (typeof result !== "object" || result === null) throw new Error("WASM returned malformed synchronization state.");
  return result as Record<string, unknown>;
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
