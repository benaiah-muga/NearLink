import type { MessagePacket } from "@nearlink/protocol";
import { isProtocolIdentifier, MAX_HISTORY_PAGE_MESSAGES } from "@nearlink/protocol";
import type { AcceptedMessageIdSnapshot, ConversationStore, SyncAcceptedMessageBatch } from "./conversationStore";
import { classifyInboundAcceptance, initializeWasmProtocol, validateWasmSyncAcceptedMessageBatch } from "./wasmProtocol";

export type DeliveryState = "queued" | "sent" | "failed";

export interface StoredMessage {
  packet: MessagePacket;
  direction: "outgoing" | "incoming";
  delivery: DeliveryState;
  transport?: "hub" | "direct";
  failure?: "message_conflict" | "transport_backpressure";
  displayOrder?: number;
}

export interface LocalIdentity {
  sender: string;
  senderName: string;
}

export type StoragePersistenceResult = "granted" | "denied" | "unavailable";

export type InboundAcceptanceResult = "saved" | "duplicate" | "conflict" | "room_deleted";

/** Ask the browser to protect this site's storage from automatic eviction. */
export async function requestStoragePersistence(): Promise<StoragePersistenceResult> {
  if (typeof navigator === "undefined" || !navigator.storage) return "unavailable";

  const storageManager = navigator.storage;
  if (typeof storageManager.persisted === "function") {
    try {
      if (await storageManager.persisted()) return "granted";
    } catch {
      // A failed status check should not prevent the persistence request.
    }
  }

  if (typeof storageManager.persist !== "function") return "unavailable";

  try {
    return await storageManager.persist() ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

const DATABASE_NAME = "nearlink-local";
const DATABASE_VERSION = 7;
const MESSAGE_STORE = "messages";
const IDENTITY_STORE = "identity";
const ROOM_DELETION_STORE = "roomDeletions";
const ROOM_CREATED_INDEX = "roomCreatedAt";
const ROOM_DELIVERY_CREATED_INDEX = "roomDeliveryCreatedAt";
const ROOM_DISPLAY_ORDER_INDEX = "roomDisplayOrder";
const ROOM_QUEUED_TRANSPORT_ORDER_INDEX = "roomQueuedTransportOrder";
const LOCAL_MESSAGE_PAGE_SIZE = 50;
export const MAX_SYNC_STORAGE_IDS = 4096;
export const MAX_SYNC_STORAGE_ROWS_SCANNED = 16384;
export const MAX_SYNC_REQUESTED_STORAGE_IDS = 100;
export const MAX_HUB_REPLAY_ORDER_IDS = 100;

/** Stateful cap logic shared by the IndexedDB cursor and deterministic boundary tests. */
export class AcceptedMessageIdCollector {
  readonly ids: string[] = [];
  scanned = 0;
  scanComplete = false;
  acceptedIdOverflow = false;
  scanCapReached = false;

  record(row: StoredMessage, room: string, validate: (packet: MessagePacket) => boolean): boolean {
    if (this.scanned >= MAX_SYNC_STORAGE_ROWS_SCANNED) {
      this.scanCapReached = true;
      return false;
    }
    this.scanned += 1;
    if (row?.packet?.room !== room || row.delivery !== "sent" || row.failure !== undefined
      || !isProtocolIdentifier(row.packet.id) || !validate(row.packet)) return true;
    if (this.ids.length >= MAX_SYNC_STORAGE_IDS) {
      this.acceptedIdOverflow = true;
      return false;
    }
    this.ids.push(row.packet.id);
    return true;
  }
}
const IDENTITY_KEY_PATH = "key";
const MESSAGE_KEY_PATH = ["packet.room", "packet.id"];
const ROOM_CREATED_KEY_PATH = ["packet.room", "packet.createdAt"];
const ROOM_DELIVERY_CREATED_KEY_PATH = ["packet.room", "delivery", "packet.createdAt"];

class LocalStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? "unknown storage error");
    super(`${operation}: ${detail}`, { cause });
    this.name = "LocalStorageError";
  }
}

function fail(operation: string, cause: unknown): LocalStorageError {
  return new LocalStorageError(operation, cause);
}

function equalKeyPath(actual: string | string[], expected: string | string[]): boolean {
  if (typeof actual === "string" || typeof expected === "string") return actual === expected;
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function compareDisplayOrder(left: StoredMessage, right: StoredMessage): number {
  const leftOrder = Number.isFinite(left.displayOrder) ? left.displayOrder! : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.displayOrder) ? right.displayOrder! : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder;
}

function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReplaySlotOrder(left: StoredMessage, right: StoredMessage): number {
  return compareDisplayOrder(left, right)
    || compareCodeUnitStrings(left.packet.createdAt, right.packet.createdAt)
    || compareCodeUnitStrings(left.packet.id, right.packet.id);
}

function ensureStore(
  database: IDBDatabase,
  transaction: IDBTransaction,
  storeName: string,
  keyPath: string | string[],
): IDBObjectStore {
  const store = database.objectStoreNames.contains(storeName)
    ? transaction.objectStore(storeName)
    : database.createObjectStore(storeName, { keyPath });

  if (!equalKeyPath(store.keyPath as string | string[], keyPath)) {
    throw new Error(`The ${storeName} store has an incompatible key path.`);
  }
  return store;
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[]): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath);
    return;
  }
  if (!equalKeyPath(store.index(name).keyPath as string | string[], keyPath)) {
    throw new Error(`The ${name} index has an incompatible key path.`);
  }
}

function migrate(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  const messages = ensureStore(database, transaction, MESSAGE_STORE, MESSAGE_KEY_PATH);
  ensureIndex(messages, ROOM_CREATED_INDEX, ROOM_CREATED_KEY_PATH);
  ensureIndex(messages, ROOM_DELIVERY_CREATED_INDEX, ROOM_DELIVERY_CREATED_KEY_PATH);
  const displayOrderKeyPath = ["packet.room", "displayOrder", "packet.createdAt", "packet.id"];
  if (messages.indexNames.contains(ROOM_DISPLAY_ORDER_INDEX)
    && !equalKeyPath(messages.index(ROOM_DISPLAY_ORDER_INDEX).keyPath as string[], displayOrderKeyPath)) {
    messages.deleteIndex(ROOM_DISPLAY_ORDER_INDEX);
  }
  ensureIndex(messages, ROOM_DISPLAY_ORDER_INDEX, displayOrderKeyPath);
  const queuedTransportOrderKeyPath = ["packet.room", "direction", "delivery", "transport", "displayOrder", "packet.createdAt", "packet.id"];
  if (messages.indexNames.contains(ROOM_QUEUED_TRANSPORT_ORDER_INDEX)
    && !equalKeyPath(messages.index(ROOM_QUEUED_TRANSPORT_ORDER_INDEX).keyPath as string[], queuedTransportOrderKeyPath)) {
    messages.deleteIndex(ROOM_QUEUED_TRANSPORT_ORDER_INDEX);
  }
  ensureIndex(messages, ROOM_QUEUED_TRANSPORT_ORDER_INDEX, queuedTransportOrderKeyPath);
  ensureStore(database, transaction, IDENTITY_STORE, IDENTITY_KEY_PATH);
  ensureStore(database, transaction, ROOM_DELETION_STORE, "room");

  // Version 4 introduced displayOrder. Backfill only databases that predate it.
  // Version 4 and later contain user-visible ordering that must survive upgrades.
  if (oldVersion >= 6) {
    const normalize = messages.openCursor();
    normalize.onsuccess = () => {
      const cursor = normalize.result;
      if (!cursor) return;
      const row = cursor.value as StoredMessage;
      if (row.transport === undefined) {
        row.transport = "hub";
        const update = cursor.update(row);
        update.onerror = () => {
          try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
        };
      }
      cursor.continue();
    };
    normalize.onerror = () => {
      try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
    };
    return;
  }

  if (oldVersion >= 4) {
    // Upgrade once, before bounded reads rely on the display-order index.
    // This preserves the prior fallback order for old rows with no order.
    const migration = messages.index(ROOM_CREATED_INDEX).openCursor();
    const nextOrderByRoom = new Map<string, number>();
    migration.onsuccess = () => {
      const cursor = migration.result;
      if (!cursor) {
        const backfill = messages.index(ROOM_CREATED_INDEX).openCursor();
        backfill.onsuccess = () => {
          const rowCursor = backfill.result;
          if (!rowCursor) return;
          const row = rowCursor.value as StoredMessage;
          let changed = false;
          if (!Number.isFinite(row.displayOrder)) {
            const nextOrder = nextOrderByRoom.get(row.packet.room) ?? 0;
            row.displayOrder = nextOrder;
            nextOrderByRoom.set(row.packet.room, nextOrder + 1);
            changed = true;
          }
          if (row.transport === undefined) {
            row.transport = "hub";
            changed = true;
          }
          if (changed) {
            const update = rowCursor.update(row);
            update.onerror = () => {
              try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
            };
          }
          rowCursor.continue();
        };
        backfill.onerror = () => {
          try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
        };
        return;
      }
      const message = cursor.value as StoredMessage;
      const nextOrder = nextOrderByRoom.get(message.packet.room) ?? 0;
      if (Number.isFinite(message.displayOrder)) {
        nextOrderByRoom.set(message.packet.room, Math.max(nextOrder, message.displayOrder! + 1));
      }
      cursor.continue();
    };
    migration.onerror = () => {
      try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
    };
    return;
  }

  const migration = messages.index(ROOM_CREATED_INDEX).openCursor();
  let activeRoom: string | undefined;
  let nextOrder = 0;
  migration.onsuccess = () => {
    const cursor = migration.result;
    if (!cursor) return;
    const message = cursor.value as StoredMessage;
    if (message.packet.room !== activeRoom) {
      activeRoom = message.packet.room;
      nextOrder = 0;
    }
    message.displayOrder = nextOrder;
    if (message.transport === undefined) message.transport = "hub";
    nextOrder += 1;
    const update = cursor.update(message);
    update.onerror = () => {
      try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
    };
    cursor.continue();
  };
  migration.onerror = () => {
    try { transaction.abort(); } catch { /* The version change transaction may already be aborting. */ }
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let migrationFailure: unknown;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const settleFailure = (cause: unknown) => {
      if (settled) return;
      settled = true;
      reject(fail("Could not open local message storage", cause));
    };

    request.onupgradeneeded = (event) => {
      try {
        migrate(request.result, request.transaction!, event.oldVersion);
      } catch (error) {
        migrationFailure = error;
        try {
          request.transaction?.abort();
        } catch {
          // The version change transaction may already be aborting.
        }
      }
    };
    request.onerror = () => settleFailure(migrationFailure ?? request.error);
    request.onblocked = () => settleFailure(new Error("The local database upgrade is blocked by another open tab."));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      settled = true;
      resolve(database);
    };
  });
}

function withTransaction<T>(
  operation: string,
  storeName: string | string[],
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, complete: (value: T) => void, setFailure: (cause: unknown) => void, transaction: IDBTransaction) => void,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let hasResult = false;
    let failure: unknown;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      if (error !== undefined) reject(fail(operation, error));
      else if (hasResult) resolve(result as T);
      else reject(fail(operation, new Error("Transaction completed without a result.")));
    };
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, mode);
    } catch (error) {
      finish(error);
      return;
    }

    transaction.onerror = () => { failure ??= transaction.error; };
    transaction.onabort = () => finish(failure ?? transaction.error ?? new Error("Transaction was aborted."));
    transaction.oncomplete = () => finish();

    const complete = (value: T) => {
      result = value;
      hasResult = true;
    };
    const setFailure = (cause: unknown) => { failure ??= cause; };
    try {
      const primaryStore = Array.isArray(storeName) ? storeName[0] : storeName;
      action(transaction.objectStore(primaryStore), complete, setFailure, transaction);
    } catch (error) {
      failure = error;
      try {
        transaction.abort();
      } catch {
        finish(error);
      }
    }
  }));
}

function observe<T>(request: IDBRequest<T>, complete: (result: T) => void, setFailure: (cause: unknown) => void): void {
  request.onsuccess = () => complete(request.result);
  request.onerror = () => setFailure(request.error ?? new Error("IndexedDB request failed."));
}

function requestNextDisplayOrder(
  index: IDBIndex,
  room: string,
  complete: (nextOrder: number) => void,
  setFailure: (cause: unknown) => void,
): void {
  const range = IDBKeyRange.bound([room, -Number.MAX_VALUE], [room, []]);
  const request = index.openCursor(range, "prev");
  request.onsuccess = () => {
    const last = request.result?.value as StoredMessage | undefined;
    const maximum = Number.isFinite(last?.displayOrder) ? last!.displayOrder! : -1;
    complete(maximum + 1);
  };
  request.onerror = () => setFailure(request.error ?? new Error("Could not read local message order."));
}

export async function loadIdentity(): Promise<LocalIdentity | null> {
  return withTransaction<{ key: string; sender: string; senderName: string } | undefined>(
    "Could not load the local identity",
    IDENTITY_STORE,
    "readonly",
    (store, complete, setFailure) => observe(store.get("profile"), complete, setFailure),
  ).then((value) => value ? { sender: value.sender, senderName: value.senderName } : null);
}

export async function saveIdentity(identity: LocalIdentity): Promise<void> {
  await withTransaction<IDBValidKey>(
    "Could not save the local identity",
    IDENTITY_STORE,
    "readwrite",
    (store, complete, setFailure) => observe(store.put({ key: "profile", ...identity }), complete, setFailure),
  );
}

export async function loadMessages(room: string): Promise<StoredMessage[]> {
  return withTransaction<StoredMessage[]>(
    "Could not load the local conversation",
    MESSAGE_STORE,
    "readwrite",
    (store, complete, setFailure) => {
      const range = IDBKeyRange.bound([room, ""], [room, "\uffff"]);
      const request = store.index(ROOM_CREATED_INDEX).getAll(range) as IDBRequest<StoredMessage[]>;
      observe(request, (messages) => {
        let nextOrder = messages.reduce((maximum, item) => Math.max(maximum, Number.isFinite(item.displayOrder) ? item.displayOrder! : -1), -1) + 1;
        for (const item of messages) {
          if (Number.isFinite(item.displayOrder)) continue;
          item.displayOrder = nextOrder;
          nextOrder += 1;
          try {
            const put = store.put(item);
            put.onerror = () => setFailure(put.error ?? new Error("Could not persist local message order."));
          }
          catch (error) {
            setFailure(error);
            request.transaction?.abort();
            return;
          }
        }
        complete(messages.sort(compareDisplayOrder));
      }, setFailure);
    },
  );
}

/** Read one room row without loading its conversation. */
export async function loadMessage(room: string, id: string): Promise<StoredMessage | null> {
  return withTransaction<StoredMessage | null>(
    "Could not load the local message",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readonly",
    (_store, complete, setFailure, transaction) => {
      const deletionRequest = transaction.objectStore(ROOM_DELETION_STORE).get(room);
      const messageRequest = transaction.objectStore(MESSAGE_STORE).get([room, id]) as IDBRequest<StoredMessage | undefined>;
      let deletionDone = false;
      let deleted = false;
      let messageDone = false;
      let message: StoredMessage | undefined;
      const finishIfReady = () => {
        if (deletionDone && messageDone) complete(deleted ? null : message ?? null);
      };
      deletionRequest.onsuccess = () => { deleted = Boolean(deletionRequest.result); deletionDone = true; finishIfReady(); };
      deletionRequest.onerror = () => setFailure(deletionRequest.error ?? new Error("Could not read the room deletion state."));
      messageRequest.onsuccess = () => { message = messageRequest.result; messageDone = true; finishIfReady(); };
      messageRequest.onerror = () => setFailure(messageRequest.error ?? new Error("Could not read the local message."));
    },
  );
}

export interface LocalMessagePageCursor {
  displayOrder: number;
  createdAt: string;
  id: string;
}

export interface LocalMessagePage {
  messages: StoredMessage[];
  cursor: LocalMessagePageCursor | null;
  hasMore: boolean;
  deleted: boolean;
}

export interface QueuedMessagePageCursor extends LocalMessagePageCursor {}

export interface QueuedMessagePage {
  messages: StoredMessage[];
  cursor: QueuedMessagePageCursor | null;
  hasMore: boolean;
  deleted: boolean;
}

/** Read a bounded newest page or continue toward older local rows. */
export async function loadMessagePage(
  room: string,
  before: LocalMessagePageCursor | null = null,
  limit = LOCAL_MESSAGE_PAGE_SIZE,
): Promise<LocalMessagePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > LOCAL_MESSAGE_PAGE_SIZE) {
    throw new Error(`A local message page must contain between 1 and ${LOCAL_MESSAGE_PAGE_SIZE} rows.`);
  }
  return withTransaction<LocalMessagePage>(
    "Could not load a local message page",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readonly",
    (_store, complete, setFailure, transaction) => {
      const messages: StoredMessage[] = [];
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      const deletionStore = transaction.objectStore(ROOM_DELETION_STORE);
      const index = messageStore.index(ROOM_DISPLAY_ORDER_INDEX);
      const lower = [room, -Number.MAX_VALUE];
      const upper = before
        ? [room, before.displayOrder, before.createdAt, before.id]
        : [room, []];
      const range = before ? IDBKeyRange.bound(lower, upper, false, true) : IDBKeyRange.bound(lower, upper);
      const deletionRequest = deletionStore.get(room);
      let deleted: { room: string } | undefined;
      let deletionDone = false;
      let cursorDone = false;
      let hasMore = false;
      const finishIfReady = () => {
        if (!deletionDone || !cursorDone) return;
        if (deleted) {
          complete({ messages: [], cursor: null, hasMore: false, deleted: true });
          return;
        }
        const ordered = messages.reverse();
        const oldest = ordered[0];
        complete({
          messages: ordered,
          cursor: oldest && Number.isFinite(oldest.displayOrder)
            ? { displayOrder: oldest.displayOrder!, createdAt: oldest.packet.createdAt, id: oldest.packet.id }
            : null,
          hasMore,
          deleted: false,
        });
      };
      deletionRequest.onsuccess = () => {
        deleted = deletionRequest.result as { room: string } | undefined;
        deletionDone = true;
        finishIfReady();
      };
      deletionRequest.onerror = () => setFailure(deletionRequest.error ?? new Error("Could not read the room deletion state."));
      const request = index.openCursor(range, "prev");
      request.onerror = () => setFailure(request.error ?? new Error("Could not read a local message page."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleted) {
          cursorDone = true;
          finishIfReady();
          return;
        }
        if (messages.length === limit) {
          hasMore = true;
          cursorDone = true;
          finishIfReady();
          return;
        }
        messages.push(cursor.value as StoredMessage);
        cursor.continue();
      };
    },
  );
}

/** Read queued outgoing messages for one transport in stable, bounded display order. */
export async function loadQueuedMessagePage(
  room: string,
  transport: "hub" | "direct",
  after: QueuedMessagePageCursor | null = null,
  limit = 64,
): Promise<QueuedMessagePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
    throw new Error("A queued message page must contain between 1 and 256 rows.");
  }
  return withTransaction<QueuedMessagePage>(
    "Could not load a queued message page",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readonly",
    (_store, complete, setFailure, transaction) => {
      const messages: StoredMessage[] = [];
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      const index = messageStore.index(ROOM_QUEUED_TRANSPORT_ORDER_INDEX);
      const prefix = [room, "outgoing", "queued", transport];
      const lower = after
        ? [...prefix, after.displayOrder, after.createdAt, after.id]
        : [...prefix, -Number.MAX_VALUE];
      const upper = [...prefix, []];
      const range = after
        ? IDBKeyRange.bound(lower, upper, true, false)
        : IDBKeyRange.bound(lower, upper);
      const deletionRequest = transaction.objectStore(ROOM_DELETION_STORE).get(room);
      let deleted: { room: string } | undefined;
      let deletionDone = false;
      let cursorDone = false;
      let hasMore = false;
      const finishIfReady = () => {
        if (!deletionDone || !cursorDone) return;
        if (deleted) {
          complete({ messages: [], cursor: null, hasMore: false, deleted: true });
          return;
        }
        const last = messages[messages.length - 1];
        complete({
          messages,
          cursor: last && Number.isFinite(last.displayOrder)
            ? { displayOrder: last.displayOrder!, createdAt: last.packet.createdAt, id: last.packet.id }
            : null,
          hasMore,
          deleted: false,
        });
      };
      deletionRequest.onsuccess = () => {
        deleted = deletionRequest.result as { room: string } | undefined;
        deletionDone = true;
        finishIfReady();
      };
      deletionRequest.onerror = () => setFailure(deletionRequest.error ?? new Error("Could not read the room deletion state."));
      const request = index.openCursor(range, "next");
      request.onerror = () => setFailure(request.error ?? new Error("Could not read a queued message page."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleted) {
          cursorDone = true;
          finishIfReady();
          return;
        }
        const key = cursor.key as IDBValidKey[];
        if (!Array.isArray(key) || key.length !== 7 || prefix.some((part, indexPart) => key[indexPart] !== part)) {
          cursorDone = true;
          finishIfReady();
          return;
        }
        if (messages.length === limit) {
          hasMore = true;
          cursorDone = true;
          finishIfReady();
          return;
        }
        messages.push(cursor.value as StoredMessage);
        cursor.continue();
      };
    },
  );
}

/** Read a deterministic, bounded accepted-ID snapshot without materializing message rows. */
export async function loadAcceptedMessageIds(
  room: string,
  validate: (packet: MessagePacket) => boolean,
): Promise<AcceptedMessageIdSnapshot> {
  return withTransaction<AcceptedMessageIdSnapshot>(
    "Could not read the bounded synchronization inventory",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readonly",
    (_store, complete, setFailure, transaction) => {
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      const deletionStore = transaction.objectStore(ROOM_DELETION_STORE);
      const collector = new AcceptedMessageIdCollector();
      let cursorDone = false;
      let deletionDone = false;
      const finishIfReady = () => {
        if (cursorDone && deletionDone) complete({
          version: 1,
          room,
          ids: collector.ids,
          scanComplete: collector.scanComplete,
          acceptedIdOverflow: collector.acceptedIdOverflow,
        });
      };
      const deletionRequest = deletionStore.get(room);
      deletionRequest.onsuccess = () => {
        deletionDone = true;
        if (deletionRequest.result) {
          collector.ids.length = 0;
          collector.scanComplete = true;
          cursorDone = true;
          finishIfReady();
          return;
        }
        finishIfReady();
      };
      deletionRequest.onerror = () => setFailure(deletionRequest.error ?? new Error("Could not read the room deletion state."));
      const range = IDBKeyRange.bound([room, ""], [room, "\uffff"]);
      const request = messageStore.openCursor(range, "next");
      request.onerror = () => setFailure(request.error ?? new Error("Could not scan accepted message IDs."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          collector.scanComplete = true;
          cursorDone = true;
          finishIfReady();
          return;
        }
        if (deletionDone && deletionRequest.result) return;
        const row = cursor.value as StoredMessage;
        try {
          if (!collector.record(row, room, validate)) {
            cursorDone = true;
            finishIfReady();
            return;
          }
        } catch (error) {
          setFailure(error);
          try { transaction.abort(); } catch { /* the transaction may already be inactive */ }
          return;
        }
        cursor.continue();
      };
    },
  );
}

/** Read only the requested accepted rows, in request order, within one readonly transaction. */
export async function loadRequestedMessages(
  room: string,
  ids: string[],
  validate: (packet: MessagePacket) => boolean,
): Promise<StoredMessage[]> {
  return (await readAcceptedMessageRows(room, ids, validate)).messages;
}

/** Read a versioned packet-only result for one bounded sync request. */
export async function loadSyncAcceptedMessageBatch(
  room: string,
  ids: string[],
  validate: (packet: MessagePacket) => boolean,
): Promise<SyncAcceptedMessageBatch> {
  if (ids.length > MAX_SYNC_REQUESTED_STORAGE_IDS) throw new Error("A synchronization read may request at most 100 message IDs.");
  if (ids.some((id) => !isProtocolIdentifier(id)) || new Set(ids).size !== ids.length) {
    throw new Error("A synchronization result request must contain unique valid message IDs.");
  }
  const result = await readAcceptedMessageRows(room, ids, validate);
  const batch: SyncAcceptedMessageBatch = {
    version: 1,
    room,
    requestedIds: [...ids],
    roomState: result.roomState,
    messages: result.messages.map((item) => item.packet),
  };
  if (!validateWasmSyncAcceptedMessageBatch(batch, room, ids)) {
    throw new Error("WASM rejected the synchronization accepted-message result.");
  }
  return batch;
}

interface AcceptedMessageReadResult {
  roomState: "available" | "unavailable";
  messages: StoredMessage[];
}

/** Shared readonly tombstone check and bounded keyed message reads for sync adapters. */
async function readAcceptedMessageRows(
  room: string,
  ids: string[],
  validate: (packet: MessagePacket) => boolean,
): Promise<AcceptedMessageReadResult> {
  if (ids.length > MAX_SYNC_REQUESTED_STORAGE_IDS) throw new Error("A synchronization read may request at most 100 message IDs.");
  if (ids.some((id) => !isProtocolIdentifier(id))) throw new Error("A synchronization read contains an invalid message ID.");
  const uniqueIds = [...new Set(ids)];
  return withTransaction<AcceptedMessageReadResult>(
    "Could not read requested synchronization messages",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readonly",
    (_store, complete, setFailure, transaction) => {
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      const deletionStore = transaction.objectStore(ROOM_DELETION_STORE);
      const results = new Map<string, StoredMessage>();
      let remaining = uniqueIds.length + 1;
      const finishOne = () => {
        remaining -= 1;
        if (remaining === 0) complete({
          roomState: "available",
          messages: ids.flatMap((id) => results.has(id) ? [results.get(id)!] : []),
        });
      };
      const deletionRequest = deletionStore.get(room);
      deletionRequest.onsuccess = () => {
        if (deletionRequest.result) {
          complete({ roomState: "unavailable", messages: [] });
          return;
        }
        for (const id of uniqueIds) {
          const request = messageStore.get([room, id]);
          request.onsuccess = () => {
            const row = request.result as StoredMessage | undefined;
            try {
              if (row?.packet?.room === room && row.packet.id === id && row.delivery === "sent"
                && row.failure === undefined && validate(row.packet)) results.set(id, row);
            } catch (error) {
              setFailure(error);
              try { transaction.abort(); } catch { /* the transaction may already be inactive */ }
              return;
            }
            finishOne();
          };
          request.onerror = () => setFailure(request.error ?? new Error("Could not read a requested synchronization message."));
        }
        finishOne();
      };
      deletionRequest.onerror = () => setFailure(deletionRequest.error ?? new Error("Could not read the room deletion state."));
    },
  );
}

/** Persist a deletion-in-progress marker before stopping live transports. */
export async function beginRoomDeletion(room: string): Promise<void> {
  await withTransaction<IDBValidKey>(
    "Could not begin deleting the local conversation",
    ROOM_DELETION_STORE,
    "readwrite",
    (store, complete, setFailure) => observe(store.put({ room, state: "deleting" }), complete, setFailure),
  );
}

/** Cancel only an unfinished deletion, leaving completed deletion markers intact. */
export async function cancelRoomDeletion(room: string): Promise<void> {
  await withTransaction<void>(
    "Could not cancel deleting the local conversation",
    ROOM_DELETION_STORE,
    "readwrite",
    (store, complete, setFailure) => {
      const request = store.get(room);
      request.onsuccess = () => {
        if (request.result?.state !== "deleting") {
          complete(undefined);
          return;
        }
        observe(store.delete(room), () => complete(undefined), setFailure);
      };
      request.onerror = () => setFailure(request.error ?? new Error("Could not check the local deletion state."));
    },
  );
}

/** Remove selected room rows and atomically mark deletion complete. */
export async function deleteRoomMessages(room: string): Promise<number> {
  return withTransaction<number>(
    "Could not delete the local conversation",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readwrite",
    (store, complete, setFailure, transaction) => {
      transaction.objectStore(ROOM_DELETION_STORE).put({ room, state: "deleted" });
      const range = IDBKeyRange.bound([room, ""], [room, "\uffff"]);
      const request = store.index(ROOM_CREATED_INDEX).openCursor(range);
      let deleted = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          complete(deleted);
          return;
        }
        let deletion: IDBRequest<undefined>;
        try {
          deletion = cursor.delete();
        } catch (error) {
          setFailure(error);
          request.transaction?.abort();
          return;
        }
        deletion.onerror = () => setFailure(deletion.error ?? new Error("Could not delete a local message."));
        deleted += 1;
        cursor.continue();
      };
      request.onerror = () => setFailure(request.error ?? new Error("Could not read the local conversation for deletion."));
    },
  );
}

export async function saveMessage(message: StoredMessage): Promise<boolean> {
  return withTransaction<boolean>(
    "Could not save the local message",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readwrite",
    (store, complete, setFailure, transaction) => {
      const tombstones = transaction.objectStore(ROOM_DELETION_STORE);
      const tombstoneRequest = tombstones.get(message.packet.room);
      const existingRequest = store.get([message.packet.room, message.packet.id]) as IDBRequest<StoredMessage | undefined>;
      let tombstoneReady = false;
      let deleted = false;
      let existingReady = false;
      let existing: StoredMessage | undefined;
      let nextOrderReady = false;
      let nextOrder = 0;
      const maybeSave = () => {
        if (!tombstoneReady || !existingReady || !nextOrderReady) return;
        if (deleted) {
          complete(false);
          return;
        }
        const displayOrder = Number.isFinite(message.displayOrder)
          ? message.displayOrder
          : existing?.displayOrder ?? nextOrder;
        const savedMessage = {
          ...message,
          ...(message.direction === "outgoing" && message.transport === undefined ? { transport: "hub" as const } : {}),
          displayOrder,
        };
        try {
          observe(store.put(savedMessage), () => complete(true), setFailure);
        } catch (error) {
          setFailure(error);
          transaction.abort();
        }
      };
      tombstoneRequest.onsuccess = () => { tombstoneReady = true; deleted = Boolean(tombstoneRequest.result); maybeSave(); };
      existingRequest.onsuccess = () => { existingReady = true; existing = existingRequest.result; maybeSave(); };
      requestNextDisplayOrder(store.index(ROOM_DISPLAY_ORDER_INDEX), message.packet.room, (order) => { nextOrderReady = true; nextOrder = order; maybeSave(); }, setFailure);
      tombstoneRequest.onerror = () => setFailure(tombstoneRequest.error ?? new Error("Could not check whether the local conversation was cleared."));
      existingRequest.onerror = () => setFailure(existingRequest.error ?? new Error("Could not read the existing local message."));
    },
  );
}

/** Accept a received packet atomically with the room tombstone and message row checks. */
export async function acceptInboundMessage(message: StoredMessage): Promise<InboundAcceptanceResult> {
  if (!await initializeWasmProtocol()) throw new Error("Could not initialize protocol acceptance.");
  return withTransaction<InboundAcceptanceResult>(
    "Could not accept the local message",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readwrite",
    (store, complete, setFailure, transaction) => {
      const tombstoneRequest = transaction.objectStore(ROOM_DELETION_STORE).get(message.packet.room);
      const existingRequest = store.get([message.packet.room, message.packet.id]) as IDBRequest<StoredMessage | undefined>;
      let tombstoneReady = false;
      let deleted = false;
      let existingReady = false;
      let existing: StoredMessage | undefined;
      let nextOrderReady = false;
      let nextOrder = 0;
      const maybeAccept = () => {
        if (!tombstoneReady || !existingReady || !nextOrderReady) return;
        let decision: ReturnType<typeof classifyInboundAcceptance>;
        try {
          decision = classifyInboundAcceptance(message.packet.room, deleted, message.packet, existing?.packet);
        } catch (error) {
          setFailure(error);
          transaction.abort();
          return;
        }
        if (decision === "room_deleted") { complete("room_deleted"); return; }
        if (decision === "conflict") { complete("conflict"); return; }
        if (existing) {
          const accepted: StoredMessage = message.transport === "hub"
            ? { ...existing, transport: "hub", delivery: "sent" }
            : existing;
          if (accepted === existing || (existing.transport === "hub" && existing.delivery === "sent")) {
            complete("duplicate");
            return;
          }
          try {
            observe(store.put(accepted), () => complete("duplicate"), setFailure);
          } catch (error) {
            setFailure(error);
            transaction.abort();
          }
          return;
        }
        const accepted: StoredMessage = { ...message, delivery: "sent", displayOrder: nextOrder };
        try {
          observe(store.add(accepted), () => complete("saved"), setFailure);
        } catch (error) {
          setFailure(error);
          transaction.abort();
        }
      };
      tombstoneRequest.onsuccess = () => { tombstoneReady = true; deleted = Boolean(tombstoneRequest.result); maybeAccept(); };
      existingRequest.onsuccess = () => { existingReady = true; existing = existingRequest.result; maybeAccept(); };
      requestNextDisplayOrder(store.index(ROOM_DISPLAY_ORDER_INDEX), message.packet.room, (order) => { nextOrderReady = true; nextOrder = order; maybeAccept(); }, setFailure);
      tombstoneRequest.onerror = () => setFailure(tombstoneRequest.error ?? new Error("Could not check whether the local conversation was cleared."));
      existingRequest.onerror = () => setFailure(existingRequest.error ?? new Error("Could not read the existing local message."));
    },
  );
}

/** Reorder replayed hub rows into the order their packets arrived, keeping other rows in their current slots. */
export async function reconcileHubReplayOrder(room: string, orderedIds: string[]): Promise<boolean> {
  if (orderedIds.length > MAX_HUB_REPLAY_ORDER_IDS) {
    throw new RangeError(`Hub replay order cannot contain more than ${MAX_HUB_REPLAY_ORDER_IDS} message IDs.`);
  }
  if (orderedIds.length < 2) return true;
  return withTransaction<boolean>(
    "Could not reconcile replayed hub message order",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readwrite",
    (store, complete, setFailure, transaction) => {
      const tombstoneRequest = transaction.objectStore(ROOM_DELETION_STORE).get(room);
      let tombstoneReady = false;
      let deleted = false;
      let remainingReads = orderedIds.length;
      const replayRowsById = new Map<string, StoredMessage>();
      const maybeReconcile = () => {
        if (!tombstoneReady || remainingReads > 0) return;
        if (deleted) {
          complete(false);
          return;
        }
        const orderedSet = new Set(orderedIds);
        const replayedRows = [...replayRowsById.values()]
          .filter((item) => orderedSet.has(item.packet.id) && item.transport === "hub" && item.delivery === "sent")
          .sort(compareReplaySlotOrder);
        if (replayedRows.length < 2) {
          complete(true);
          return;
        }
        const rowsById = new Map(replayedRows.map((item) => [item.packet.id, item]));
        const acceptedOrder = orderedIds
          .map((id) => rowsById.get(id))
          .filter((item): item is StoredMessage => Boolean(item));
        const slots = replayedRows.map((item, index) => Number.isFinite(item.displayOrder) ? item.displayOrder! : index);
        acceptedOrder.forEach((item, index) => {
          if (item.displayOrder === slots[index]) return;
          try {
            const put = store.put({ ...item, displayOrder: slots[index] });
            put.onerror = () => setFailure(put.error ?? new Error("Could not persist replayed hub message order."));
          } catch (error) {
            setFailure(error);
            transaction.abort();
          }
        });
        complete(true);
      };
      tombstoneRequest.onsuccess = () => { tombstoneReady = true; deleted = Boolean(tombstoneRequest.result); maybeReconcile(); };
      tombstoneRequest.onerror = () => setFailure(tombstoneRequest.error ?? new Error("Could not check whether the local conversation was cleared."));
      for (const id of orderedIds) {
        let request: IDBRequest<StoredMessage | undefined>;
        try {
          request = store.get([room, id]) as IDBRequest<StoredMessage | undefined>;
        } catch (error) {
          setFailure(error);
          transaction.abort();
          return;
        }
        request.onsuccess = () => {
          const row = request.result;
          if (row) replayRowsById.set(id, row);
          remainingReads -= 1;
          maybeReconcile();
        };
        request.onerror = () => setFailure(request.error ?? new Error("Could not read replayed hub message order."));
      }
    },
  );
}

/** Atomically save one verified newest-to-oldest history page before the current oldest row. */
export async function saveHubHistoryPage(messages: StoredMessage[], cursor: string | null, requestStartOrder: number): Promise<boolean> {
  if (messages.length === 0) return true;
  if (messages.length > MAX_HISTORY_PAGE_MESSAGES) {
    throw new RangeError(`A history page cannot contain more than ${MAX_HISTORY_PAGE_MESSAGES} messages.`);
  }
  if (!await initializeWasmProtocol()) throw new Error("Could not initialize protocol acceptance.");
  const room = messages[0].packet.room;
  if (messages.some((message) => message.packet.room !== room)) {
    throw new Error("A history page must contain messages from one room.");
  }

  if (cursor !== null) {
    return withTransaction<boolean>(
      "Could not save the local history page",
      [MESSAGE_STORE, ROOM_DELETION_STORE],
      "readwrite",
      (store, complete, setFailure, transaction) => {
        const tombstoneRequest = transaction.objectStore(ROOM_DELETION_STORE).get(room);
        const pageIds = new Set(messages.map((item) => item.packet.id));
        const lookupIds = [...new Set([...pageIds, cursor])];
        const rowsById = new Map<string, StoredMessage>();
        let remainingReads = lookupIds.length;
        let tombstoneReady = false;
        let deleted = false;
        let fallbackReady = false;
        let fallbackOrder = 0;

        const maybeSave = () => {
          if (!tombstoneReady || remainingReads > 0 || !fallbackReady) return;
          if (deleted) {
            complete(false);
            return;
          }

          const pagePackets = new Map<string, MessagePacket>();
          for (const candidate of messages) {
            const existing = rowsById.get(candidate.packet.id)?.packet ?? pagePackets.get(candidate.packet.id);
            let decision: ReturnType<typeof classifyInboundAcceptance>;
            try {
              decision = classifyInboundAcceptance(room, deleted, candidate.packet, existing);
            } catch (error) {
              setFailure(error);
              transaction.abort();
              return;
            }
            if (decision === "room_deleted") { complete(false); return; }
            if (decision === "conflict") {
              setFailure(new Error("A history page ID conflicts with saved message content."));
              transaction.abort();
              return;
            }
            pagePackets.set(candidate.packet.id, candidate.packet);
          }

          const cursorRow = rowsById.get(cursor);
          const anchorOrder = Number.isFinite(cursorRow?.displayOrder) ? cursorRow!.displayOrder! : fallbackOrder;
          for (let index = 0; index < messages.length; index += 1) {
            const candidate = messages[index];
            const existing = rowsById.get(candidate.packet.id);
            const alreadyOlderThanCursor = existing
              && Number.isFinite(existing.displayOrder)
              && existing.displayOrder! < anchorOrder;
            const displayOrder = alreadyOlderThanCursor ? existing.displayOrder : anchorOrder - (index + 1);
            const savedMessage: StoredMessage = existing
              ? { ...existing, transport: "hub", delivery: "sent", displayOrder }
              : { ...candidate, transport: "hub", delivery: "sent", displayOrder };
            try {
              const put = store.put(savedMessage);
              put.onerror = () => setFailure(put.error ?? new Error("Could not persist the history page order."));
            } catch (error) {
              setFailure(error);
              transaction.abort();
              return;
            }
          }
          complete(true);
        };

        const maybeReadFallback = () => {
          if (remainingReads > 0) return;
          const cursorRow = rowsById.get(cursor);
          if (Number.isFinite(cursorRow?.displayOrder)) {
            fallbackReady = true;
            maybeSave();
            return;
          }

          let oldestRequest: IDBRequest<IDBCursorWithValue | null>;
          try {
            oldestRequest = store.index(ROOM_DISPLAY_ORDER_INDEX).openCursor(
              IDBKeyRange.bound([room], [room, []]),
              "next",
            );
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return;
          }
          oldestRequest.onsuccess = () => {
            const oldestOrder = oldestRequest.result?.value?.displayOrder;
            fallbackOrder = Math.min(0, Number.isFinite(oldestOrder) ? oldestOrder : 0);
            fallbackReady = true;
            maybeSave();
          };
          oldestRequest.onerror = () => setFailure(oldestRequest.error ?? new Error("Could not read the oldest local message order."));
        };

        tombstoneRequest.onsuccess = () => {
          tombstoneReady = true;
          deleted = Boolean(tombstoneRequest.result);
          maybeSave();
        };
        tombstoneRequest.onerror = () => setFailure(tombstoneRequest.error ?? new Error("Could not check whether the local conversation was cleared."));

        for (const id of lookupIds) {
          let request: IDBRequest<StoredMessage | undefined>;
          try {
            request = store.get([room, id]) as IDBRequest<StoredMessage | undefined>;
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return;
          }
          request.onsuccess = () => {
            if (request.result) rowsById.set(id, request.result);
            remainingReads -= 1;
            maybeReadFallback();
          };
          request.onerror = () => setFailure(request.error ?? new Error("Could not read history page messages."));
        }
      },
    );
  }

  return withTransaction<boolean>(
    "Could not save the local history page",
    [MESSAGE_STORE, ROOM_DELETION_STORE],
    "readwrite",
    (store, complete, setFailure, transaction) => {
      const tombstones = transaction.objectStore(ROOM_DELETION_STORE);
      const tombstoneRequest = tombstones.get(room);
      const pageIds = new Set(messages.map((item) => item.packet.id));
      const rowsById = new Map<string, StoredMessage>();
      let remainingReads = pageIds.size;
      let tombstoneReady = false;
      let deleted = false;
      let cursorStarted = false;
      const startCursor = () => {
        if (!tombstoneReady || remainingReads > 0 || cursorStarted) return;
        cursorStarted = true;
        if (deleted) {
          complete(false);
          return;
        }

        const pagePackets = new Map<string, MessagePacket>();
        for (const candidate of messages) {
          const existing = rowsById.get(candidate.packet.id)?.packet ?? pagePackets.get(candidate.packet.id);
          let decision: ReturnType<typeof classifyInboundAcceptance>;
          try {
            decision = classifyInboundAcceptance(room, deleted, candidate.packet, existing);
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return;
          }
          if (decision === "room_deleted") { complete(false); return; }
          if (decision === "conflict") {
            setFailure(new Error("A history page ID conflicts with saved message content."));
            transaction.abort();
            return;
          }
          pagePackets.set(candidate.packet.id, candidate.packet);
        }

        const pageOldestFirst = [...messages].reverse();
        const anchors = new Set(pageOldestFirst
          .filter((item) => {
            const existing = rowsById.get(item.packet.id);
            return existing && Number.isFinite(existing.displayOrder) && existing.displayOrder! <= requestStartOrder;
          })
          .map((item) => item.packet.id));
        const beforeAnchor = new Map<string, StoredMessage[]>();
        const afterAnchor = new Map<string, StoredMessage[]>();
        const beforePostRequest: StoredMessage[] = [];
        const beforePostRequestIds = new Set<string>();
        let previousAnchor: string | null = null;
        for (let index = 0; index < pageOldestFirst.length; index += 1) {
          const candidate = pageOldestFirst[index];
          if (anchors.has(candidate.packet.id)) {
            previousAnchor = candidate.packet.id;
            continue;
          }
          let nextAnchor: string | undefined;
          for (let next = index + 1; next < pageOldestFirst.length; next += 1) {
            if (anchors.has(pageOldestFirst[next].packet.id)) {
              nextAnchor = pageOldestFirst[next].packet.id;
              break;
            }
          }
          const existing = rowsById.get(candidate.packet.id);
          const savedMessage: StoredMessage = existing
            ? { ...existing, transport: "hub", delivery: "sent" }
            : { ...candidate, transport: "hub", delivery: "sent" };
          if (nextAnchor) {
            const bucket = beforeAnchor.get(nextAnchor) ?? [];
            bucket.push(savedMessage);
            beforeAnchor.set(nextAnchor, bucket);
          } else if (previousAnchor) {
            const bucket = afterAnchor.get(previousAnchor) ?? [];
            bucket.push(savedMessage);
            afterAnchor.set(previousAnchor, bucket);
          } else {
            beforePostRequest.push(savedMessage);
            beforePostRequestIds.add(savedMessage.packet.id);
          }
        }

        let nextDisplayOrder = 0;
        let insertedBeforePostRequest = false;
        let cursorRequest: IDBRequest<IDBCursorWithValue | null>;
        const stage = (item: StoredMessage, pageCandidate: boolean) => {
          const savedMessage = pageCandidate
            ? { ...item, transport: "hub" as const, delivery: "sent" as const, pendingDisplayOrder: nextDisplayOrder++ }
            : { ...item, pendingDisplayOrder: nextDisplayOrder++ };
          try {
            const put = store.put(savedMessage);
            put.onerror = () => setFailure(put.error ?? new Error("Could not persist the history page order."));
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return false;
          }
          return true;
        };
        const stageAtCursor = (cursor: IDBCursorWithValue, item: StoredMessage, pageCandidate: boolean) => {
          const savedMessage = pageCandidate
            ? { ...item, transport: "hub" as const, delivery: "sent" as const, pendingDisplayOrder: nextDisplayOrder++ }
            : { ...item, pendingDisplayOrder: nextDisplayOrder++ };
          try {
            const update = cursor.update(savedMessage);
            update.onerror = () => setFailure(update.error ?? new Error("Could not persist the history page order."));
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return false;
          }
          return true;
        };
        const emitBucket = (bucket: StoredMessage[] | undefined) => {
          if (!bucket) return true;
          for (const item of bucket) if (!stage(item, true)) return false;
          return true;
        };
        // Keep each cursor's index key stable while streaming. The staged rank is
        // removed in the same transaction during the createdAt-index pass.
        const finalizeStagedOrders = () => {
          let finalizeRequest: IDBRequest<IDBCursorWithValue | null>;
          try {
            finalizeRequest = store.index(ROOM_CREATED_INDEX).openCursor(
              IDBKeyRange.bound([room, ""], [room, "\uffff"]),
              "next",
            );
          } catch (error) {
            setFailure(error);
            transaction.abort();
            return;
          }
          finalizeRequest.onsuccess = () => {
            const cursor = finalizeRequest.result;
            if (!cursor) {
              if (!insertedBeforePostRequest) {
                for (const item of beforePostRequest) {
                  try {
                    const put = store.put({
                      ...item,
                      transport: "hub" as const,
                      delivery: "sent" as const,
                      displayOrder: nextDisplayOrder++,
                    });
                    put.onerror = () => setFailure(put.error ?? new Error("Could not persist the history page order."));
                  } catch (error) {
                    setFailure(error);
                    transaction.abort();
                    return;
                  }
                }
              }
              complete(true);
              return;
            }
            const row = cursor.value as StoredMessage & { pendingDisplayOrder?: number };
            const { pendingDisplayOrder, ...withoutPendingOrder } = row;
            const finalized = Number.isFinite(pendingDisplayOrder)
              ? { ...withoutPendingOrder, displayOrder: pendingDisplayOrder }
              : Number.isFinite(row.displayOrder)
                ? row
                : !insertedBeforePostRequest && beforePostRequestIds.has(row.packet.id)
                  ? row
                  : { ...row, displayOrder: nextDisplayOrder++ };
            if (finalized !== row) {
              try {
                const update = cursor.update(finalized);
                update.onerror = () => setFailure(update.error ?? new Error("Could not finalize the history page order."));
              } catch (error) {
                setFailure(error);
                transaction.abort();
                return;
              }
            }
            cursor.continue();
          };
          finalizeRequest.onerror = () => setFailure(finalizeRequest.error ?? new Error("Could not finalize local message order."));
        };
        try {
          cursorRequest = store.index(ROOM_DISPLAY_ORDER_INDEX).openCursor(
            IDBKeyRange.bound([room], [room, []]),
            "next",
          );
        } catch (error) {
          setFailure(error);
          transaction.abort();
          return;
        }
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            finalizeStagedOrders();
            return;
          }
          const row = cursor.value as StoredMessage;
          const order = row.displayOrder;
          if (!Number.isFinite(order)) {
            cursor.continue();
            return;
          }
          if (!insertedBeforePostRequest && !pageIds.has(row.packet.id)
            && order! > requestStartOrder) {
            insertedBeforePostRequest = true;
            if (!emitBucket(beforePostRequest)) return;
          }
          if (pageIds.has(row.packet.id)) {
            if (anchors.has(row.packet.id)) {
              if (!emitBucket(beforeAnchor.get(row.packet.id))) return;
              const anchor = rowsById.get(row.packet.id);
              if (anchor && !stageAtCursor(cursor, anchor, true)) return;
              if (!emitBucket(afterAnchor.get(row.packet.id))) return;
            }
          } else if (!stageAtCursor(cursor, row, false)) {
            return;
          }
          cursor.continue();
        };
        cursorRequest.onerror = () => setFailure(cursorRequest.error ?? new Error("Could not stream local message order."));
      };
      tombstoneRequest.onsuccess = () => { tombstoneReady = true; deleted = Boolean(tombstoneRequest.result); startCursor(); };
      tombstoneRequest.onerror = () => setFailure(tombstoneRequest.error ?? new Error("Could not check whether the local conversation was cleared."));
      for (const id of pageIds) {
        let request: IDBRequest<StoredMessage | undefined>;
        try {
          request = store.get([room, id]) as IDBRequest<StoredMessage | undefined>;
        } catch (error) {
          setFailure(error);
          transaction.abort();
          return;
        }
        request.onsuccess = () => {
          if (request.result) rowsById.set(id, request.result);
          remainingReads -= 1;
          startCursor();
        };
        request.onerror = () => setFailure(request.error ?? new Error("Could not read history page messages."));
      }
    },
  );
}

/** Allow this browser to save or receive messages in a room after deliberate user action. */
export async function resumeRoomMessages(room: string): Promise<void> {
  await withTransaction<void>(
    "Could not resume the local conversation",
    ROOM_DELETION_STORE,
    "readwrite",
    (store, complete, setFailure) => {
      const request = store.get(room);
      request.onsuccess = () => {
        if (request.result?.state === "deleting") {
          setFailure(new Error("The local conversation is still being deleted."));
          try { request.transaction?.abort(); } catch { /* The transaction may already be aborting. */ }
          return;
        }
        observe(store.delete(room), () => complete(undefined), setFailure);
      };
      request.onerror = () => setFailure(request.error ?? new Error("Could not check the local deletion state."));
    },
  );
}

export async function isRoomMessagesDeleted(room: string): Promise<boolean> {
  return withTransaction<{ room: string } | undefined>(
    "Could not check the local conversation status",
    ROOM_DELETION_STORE,
    "readonly",
    (store, complete, setFailure) => observe(store.get(room), complete, setFailure),
  ).then(Boolean);
}

export async function updateDelivery(room: string, id: string, delivery: DeliveryState, failure?: StoredMessage["failure"] | null): Promise<void> {
  await withTransaction<void>(
    "Could not update message status",
    MESSAGE_STORE,
    "readwrite",
    (store, complete, setFailure) => {
      const request = store.get([room, id]) as IDBRequest<StoredMessage | undefined>;
      request.onsuccess = () => {
        const found = request.result;
        if (!found) {
          complete(undefined);
          return;
        }
        const updated = { ...found, delivery };
        if (failure === null) delete updated.failure;
        else if (failure !== undefined) updated.failure = failure;
        observe(store.put(updated), () => complete(undefined), setFailure);
      };
      request.onerror = () => setFailure(request.error ?? new Error("Could not read the message status."));
    },
  );
}

/** IndexedDB-backed implementation of the application storage port. */
export const browserConversationStore: ConversationStore = {
  loadIdentity,
  saveIdentity,
  loadMessages,
  loadMessage,
  loadMessagePage,
  loadQueuedMessagePage,
  loadAcceptedMessageIds,
  loadSyncAcceptedMessageBatch,
  loadRequestedMessages,
  saveMessage,
  acceptInboundMessage,
  updateDelivery,
  beginRoomDeletion,
  cancelRoomDeletion,
  deleteRoomMessages,
  isRoomMessagesDeleted,
  resumeRoomMessages,
  reconcileHubReplayOrder,
  saveHubHistoryPage,
  requestStoragePersistence,
};
