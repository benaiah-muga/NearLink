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

export interface SyncMissingBatch {
  ids: string[];
  nextOffset: number;
  hasMore: boolean;
}

export interface SyncMissingIdSelector {
  observeLocalIds(ids: string[]): void;
  finish(): string[];
  free(): void;
}

interface WasmSyncModule {
  plan_missing_batch_json(missingIdsJson: string, offset: number): string;
  WasmMissingIdSelector: new (peerIdsJson: string) => {
    status_json(): string;
    observe_local_ids_json(localIdsJson: string): string;
    finish_json(): string;
    free(): void;
  };
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
  classify_inbound_json?: (expectedRoom: string, roomDeleted: boolean, candidateJson: string, existingJson?: string) => string;
};

export const MAX_PROTOCOL_ENVELOPE_BYTES = 18 * 1024;
export const MAX_SYNC_SELECTION_CHUNK_IDS = 4_096;

let wasmValidator: WasmValidator | null = null;
let wasmSyncModule: WasmSyncModule | null = null;
let wasmAcceptanceClassifier: WasmModule["classify_inbound_json"] | null = null;
let initialization: Promise<boolean> | null = null;

export function initializeWasmProtocol(): Promise<boolean> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const wasm = await import("../generated/nearlink_protocol_wasm.js") as WasmModule;
      await wasm.default();
      const validator = typeof wasm.validate_json === "function" ? wasm.validate_json : null;
      const acceptanceClassifier = "classify_inbound_json" in wasm && typeof wasm.classify_inbound_json === "function"
        ? wasm.classify_inbound_json
        : null;
      if (!validator || !acceptanceClassifier) throw new Error("Required WASM protocol exports are unavailable.");
      wasmValidator = validator;
      wasmAcceptanceClassifier = acceptanceClassifier;
      wasmSyncModule = "WasmSyncInventoryReceiver" in wasm && "WasmSyncRequestBook" in wasm
        && "WasmMissingIdSelector" in wasm && "plan_missing_batch_json" in wasm
        && typeof wasm.WasmSyncInventoryReceiver === "function"
        && typeof wasm.WasmSyncRequestBook === "function"
        && typeof wasm.WasmMissingIdSelector === "function"
        && typeof wasm.plan_missing_batch_json === "function" ? wasm : null;
      return true;
    } catch {
      wasmValidator = null;
      wasmSyncModule = null;
      wasmAcceptanceClassifier = null;
      initialization = null;
      return false;
    }
  })();
  return initialization;
}

export function isWasmProtocolReady(): boolean {
  return wasmValidator !== null && wasmAcceptanceClassifier !== null;
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

export function createWasmMissingIdSelector(peerIds: string[]): SyncMissingIdSelector {
  if (!wasmSyncModule) throw new Error("WASM synchronization planner is unavailable.");
  const selector = new wasmSyncModule.WasmMissingIdSelector(JSON.stringify(peerIds));
  if (parseSyncResult(selector.status_json()).ok !== true) {
    selector.free();
    throw new Error("WASM rejected the peer synchronization inventory.");
  }
  return {
    observeLocalIds(ids) {
      const result = parseSyncResult(selector.observe_local_ids_json(JSON.stringify(ids)));
      if (result.ok !== true) throw new Error("WASM rejected local synchronization IDs.");
    },
    finish() {
      const result = parseSyncResult(selector.finish_json());
      if (result.ok !== true || !Array.isArray(result.missingIds) || !result.missingIds.every((id) => typeof id === "string")) {
        throw new Error("WASM rejected synchronization missing-ID selection.");
      }
      return result.missingIds;
    },
    free: () => selector.free(),
  };
}

export function planWasmMissingBatch(missingIds: string[], offset: number): SyncMissingBatch {
  if (!wasmSyncModule) throw new Error("WASM synchronization planner is unavailable.");
  const result = parseSyncResult(wasmSyncModule.plan_missing_batch_json(JSON.stringify(missingIds), offset));
  if (result.ok !== true || !Array.isArray(result.ids) || !result.ids.every((id) => typeof id === "string")
    || !Number.isSafeInteger(result.nextOffset) || typeof result.hasMore !== "boolean") {
    throw new Error("WASM rejected synchronization request planning.");
  }
  return { ids: result.ids, nextOffset: result.nextOffset as number, hasMore: result.hasMore };
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

export type InboundAcceptanceDecision = "saved" | "duplicate" | "conflict" | "room_deleted";

/** Run the portable acceptance classifier synchronously while IndexedDB is active. */
export function classifyInboundAcceptance(
  expectedRoom: string,
  roomDeleted: boolean,
  candidate: MessagePacket,
  existing?: MessagePacket,
): InboundAcceptanceDecision {
  if (!wasmAcceptanceClassifier) throw new Error("WASM inbound acceptance is unavailable.");
  const raw = wasmAcceptanceClassifier(expectedRoom, roomDeleted, JSON.stringify(candidate), existing ? JSON.stringify(existing) : undefined);
  const result = parseSyncResult(raw);
  if (result.ok === true && (result.outcome === "saved" || result.outcome === "duplicate"
    || result.outcome === "conflict" || result.outcome === "room_deleted")) {
    return result.outcome;
  }
  const code = typeof result.code === "string" ? result.code : "invalid_result";
  throw new Error(`WASM rejected inbound acceptance (${code}).`);
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
