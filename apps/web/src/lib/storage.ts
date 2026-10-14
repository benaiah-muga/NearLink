import type { MessagePacket } from "@nearlink/protocol";

export type DeliveryState = "queued" | "sent" | "failed";

export interface StoredMessage {
  packet: MessagePacket;
  direction: "outgoing" | "incoming";
  delivery: DeliveryState;
}

export interface LocalIdentity {
  sender: string;
  senderName: string;
}

const DATABASE_NAME = "nearlink-local";
const DATABASE_VERSION = 1;
const MESSAGE_STORE = "messages";
const IDENTITY_STORE = "identity";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const messages = database.createObjectStore(MESSAGE_STORE, { keyPath: ["packet.room", "packet.id"] });
      messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
      database.createObjectStore(IDENTITY_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local message storage."));
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result: T | undefined;
    let requestSucceeded = false;
    request.onsuccess = () => { result = request.result; requestSucceeded = true; };
    request.onerror = () => reject(request.error ?? new Error("Local storage request failed."));
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Local storage transaction failed.")); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Local storage transaction failed.")); };
    transaction.oncomplete = () => {
      database.close();
      if (requestSucceeded) resolve(result as T);
      else reject(new Error("Local storage transaction completed without a result."));
    };
  });
}

export async function loadIdentity(): Promise<LocalIdentity | null> {
  const value = await withStore<{ key: string; sender: string; senderName: string } | undefined>(IDENTITY_STORE, "readonly", (store) => store.get("profile"));
  return value ? { sender: value.sender, senderName: value.senderName } : null;
}

export async function saveIdentity(identity: LocalIdentity): Promise<void> {
  await withStore(IDENTITY_STORE, "readwrite", (store) => store.put({ key: "profile", ...identity }));
}

export async function loadMessages(room: string): Promise<StoredMessage[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MESSAGE_STORE, "readonly");
    const request = transaction.objectStore(MESSAGE_STORE).index("roomCreatedAt").getAll(IDBKeyRange.bound([room, ""], [room, "\uffff"]));
    let result: StoredMessage[] = [];
    request.onsuccess = () => { result = (request.result as StoredMessage[]).sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)); };
    request.onerror = () => reject(request.error ?? new Error("Could not load the local conversation."));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Could not load the local conversation.")); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Could not load the local conversation.")); };
  });
}

export async function saveMessage(message: StoredMessage): Promise<void> {
  await withStore(MESSAGE_STORE, "readwrite", (store) => store.put(message));
}

export async function updateDelivery(room: string, id: string, delivery: DeliveryState): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MESSAGE_STORE, "readwrite");
    const store = transaction.objectStore(MESSAGE_STORE);
    const request = store.get([room, id]);
    request.onsuccess = () => {
      const found = request.result as StoredMessage | undefined;
      if (found) store.put({ ...found, delivery });
    };
    request.onerror = () => reject(request.error ?? new Error("Could not update message status."));
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Could not update message status.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Could not update message status.")); };
  });
}
