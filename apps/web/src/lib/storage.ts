import type { MessagePacket } from "@nearlink/protocol";

export type DeliveryState = "queued" | "sent" | "failed";

export interface StoredMessage {
  packet: MessagePacket;
  direction: "outgoing" | "incoming";
  delivery: DeliveryState;
  transport?: "hub" | "direct";
  failure?: "message_conflict";
}

export interface LocalIdentity {
  sender: string;
  senderName: string;
}

const DATABASE_NAME = "nearlink-local";
const DATABASE_VERSION = 2;
const MESSAGE_STORE = "messages";
const IDENTITY_STORE = "identity";
const ROOM_CREATED_INDEX = "roomCreatedAt";
const ROOM_DELIVERY_CREATED_INDEX = "roomDeliveryCreatedAt";
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

function migrate(database: IDBDatabase, transaction: IDBTransaction): void {
  const messages = ensureStore(database, transaction, MESSAGE_STORE, MESSAGE_KEY_PATH);
  ensureIndex(messages, ROOM_CREATED_INDEX, ROOM_CREATED_KEY_PATH);
  ensureIndex(messages, ROOM_DELIVERY_CREATED_INDEX, ROOM_DELIVERY_CREATED_KEY_PATH);
  ensureStore(database, transaction, IDENTITY_STORE, IDENTITY_KEY_PATH);
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

    request.onupgradeneeded = () => {
      try {
        migrate(request.result, request.transaction!);
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
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, complete: (value: T) => void, setFailure: (cause: unknown) => void) => void,
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
      action(transaction.objectStore(storeName), complete, setFailure);
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
    "readonly",
    (store, complete, setFailure) => {
      const range = IDBKeyRange.bound([room, ""], [room, "\uffff"]);
      const request = store.index(ROOM_CREATED_INDEX).getAll(range) as IDBRequest<StoredMessage[]>;
      observe(request, (messages) => complete(messages.sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt))), setFailure);
    },
  );
}

export async function saveMessage(message: StoredMessage): Promise<void> {
  await withTransaction<IDBValidKey>(
    "Could not save the local message",
    MESSAGE_STORE,
    "readwrite",
    (store, complete, setFailure) => observe(store.put(message), complete, setFailure),
  );
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
