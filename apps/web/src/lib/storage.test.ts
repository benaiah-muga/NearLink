import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePacket } from "@nearlink/protocol";
import { acceptInboundMessage, beginRoomDeletion, cancelRoomDeletion, deleteRoomMessages, isRoomMessagesDeleted, loadIdentity, loadMessages, reconcileHubReplayOrder, resumeRoomMessages, saveHubHistoryPage, saveIdentity, saveMessage, updateDelivery, type StoredMessage } from "./storage";

const classifierGate = vi.hoisted(() => ({ failNext: false }));

vi.mock("./wasmProtocol", () => ({
  initializeWasmProtocol: async () => true,
  classifyInboundAcceptance: (expectedRoom: string, roomDeleted: boolean, candidate: MessagePacket, existing?: MessagePacket) => {
    if (classifierGate.failNext) {
      classifierGate.failNext = false;
      throw new Error("WASM inbound acceptance is unavailable.");
    }
    if (candidate.room !== expectedRoom) throw new Error("WASM rejected inbound acceptance (room_mismatch).");
    if (roomDeleted) return "room_deleted";
    if (!existing) return "saved";
    return JSON.stringify(candidate) === JSON.stringify(existing) ? "duplicate" : "conflict";
  },
}));

const DATABASE_NAME = "nearlink-local";

function openRequest(version?: number): IDBOpenDBRequest {
  return version === undefined ? indexedDB.open(DATABASE_NAME) : indexedDB.open(DATABASE_NAME, version);
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database deletion was blocked."));
  });
}

function packet(id: string, createdAt: string, room = "alpha"): MessagePacket {
  return {
    version: 1,
    type: "message",
    id,
    room,
    sender: "device-1",
    senderName: "Ada",
    createdAt,
    body: `body ${id}`,
  };
}

function message(id: string, createdAt: string, delivery: StoredMessage["delivery"] = "queued"): StoredMessage {
  return { packet: packet(id, createdAt), direction: "outgoing", delivery };
}

afterEach(async () => {
  classifierGate.failNext = false;
  vi.restoreAllMocks();
  await deleteDatabase();
});

describe("local IndexedDB storage", () => {
  it("persists and reloads an identity and ordered messages", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    await saveMessage(message("later", "2026-10-14T10:00:00.000Z"));
    await saveMessage(message("earlier", "2026-10-14T09:00:00.000Z"));
    await saveMessage({ ...message("incoming", "2026-10-14T09:30:00.000Z", "sent"), direction: "incoming" });
    await saveMessage({ ...message("other-room", "2026-10-14T08:00:00.000Z"), packet: packet("other-room", "2026-10-14T08:00:00.000Z", "beta") });

    await expect(loadIdentity()).resolves.toEqual({ sender: "device-1", senderName: "Ada" });
    await expect(loadMessages("alpha")).resolves.toEqual([
      { ...message("later", "2026-10-14T10:00:00.000Z"), displayOrder: 0 },
      { ...message("earlier", "2026-10-14T09:00:00.000Z"), displayOrder: 1 },
      { ...message("incoming", "2026-10-14T09:30:00.000Z", "sent"), direction: "incoming", displayOrder: 2 },
    ]);
    await expect(loadMessages("missing")).resolves.toEqual([]);
  });

  it("loads identity, room messages, and deletion status concurrently", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    await saveMessage(message("parallel-read", "2026-10-14T09:00:00.000Z"));
    await expect(Promise.all([loadIdentity(), loadMessages("alpha"), isRoomMessagesDeleted("alpha")])).resolves.toEqual([
      { sender: "device-1", senderName: "Ada" },
      [{ ...message("parallel-read", "2026-10-14T09:00:00.000Z"), displayOrder: 0 }],
      false,
    ]);
  });

  it("deduplicates repeated room and message identifiers by replacing the existing record", async () => {
    await saveMessage(message("same-id", "2026-10-14T09:00:00.000Z"));
    const duplicate = message("same-id", "2026-10-14T10:00:00.000Z", "sent");
    duplicate.packet.body = "updated duplicate";
    await saveMessage(duplicate);

    await expect(loadMessages("alpha")).resolves.toEqual([{ ...duplicate, displayOrder: 0 }]);
  });

  it("atomically accepts a new inbound packet and recognizes an exact duplicate", async () => {
    const incoming: StoredMessage = { packet: packet("accepted-once", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    await expect(acceptInboundMessage(incoming)).resolves.toBe("saved");
    await expect(acceptInboundMessage(incoming)).resolves.toBe("duplicate");
    await expect(loadMessages("alpha")).resolves.toMatchObject([{ packet: incoming.packet, direction: "incoming", delivery: "sent", transport: "direct", displayOrder: 0 }]);
    await expect(acceptInboundMessage({ ...incoming, transport: "hub" })).resolves.toBe("duplicate");
    await expect(loadMessages("alpha")).resolves.toMatchObject([{ packet: incoming.packet, direction: "incoming", delivery: "sent", transport: "hub", displayOrder: 0 }]);
  });

  it("rejects a conflicting packet without replacing the previously accepted contents", async () => {
    const original: StoredMessage = { packet: packet("accepted-conflict", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    await expect(acceptInboundMessage(original)).resolves.toBe("saved");
    await expect(acceptInboundMessage({ ...original, packet: { ...original.packet, body: "conflicting body" }, transport: "hub" })).resolves.toBe("conflict");
    await expect(loadMessages("alpha")).resolves.toMatchObject([{ packet: original.packet, transport: "direct" }]);
  });

  it("does not accept inbound packets after the room deletion tombstone is set", async () => {
    await beginRoomDeletion("alpha");
    await deleteRoomMessages("alpha");
    await expect(acceptInboundMessage({ packet: packet("after-delete", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" })).resolves.toBe("room_deleted");
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("serializes competing inbound acceptance so only one insert wins", async () => {
    const incoming: StoredMessage = { packet: packet("competing-accept", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    await expect(Promise.all([acceptInboundMessage(incoming), acceptInboundMessage(incoming)])).resolves.toEqual(["saved", "duplicate"]);
    await expect(loadMessages("alpha")).resolves.toHaveLength(1);
  });

  it("keeps a racing inbound acceptance out of a room being deleted", async () => {
    const incoming: StoredMessage = { packet: packet("accept-delete-race", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    const [acceptance] = await Promise.all([
      acceptInboundMessage(incoming),
      beginRoomDeletion("alpha").then(() => deleteRoomMessages("alpha")),
    ]);

    expect(["saved", "room_deleted"]).toContain(acceptance);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);
  });

  it("removes an inbound message accepted before room deletion", async () => {
    const incoming: StoredMessage = { packet: packet("accepted-before-delete", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    await expect(acceptInboundMessage(incoming)).resolves.toBe("saved");
    await beginRoomDeletion("alpha");
    await deleteRoomMessages("alpha");

    await expect(loadMessages("alpha")).resolves.toEqual([]);
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);
  });

  it("surfaces inbound write failures and leaves no partial row", async () => {
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
      if (this.name === "messages") throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
      return originalAdd.apply(this, args);
    });
    await expect(acceptInboundMessage({ packet: packet("accept-write-failure", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" })).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Storage quota exceeded"),
    });
    vi.restoreAllMocks();
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("aborts inbound acceptance when the portable decision fails", async () => {
    const incoming: StoredMessage = { packet: packet("classifier-failure", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent" };
    classifierGate.failNext = true;
    await expect(acceptInboundMessage(incoming)).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("WASM inbound acceptance is unavailable."),
    });
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("persists the optional transport hint and keeps legacy rows hub-compatible", async () => {
    const direct = { ...message("direct-row", "2026-10-14T09:00:00.000Z", "sent"), transport: "direct" as const };
    await saveMessage(direct);
    await saveMessage(message("legacy-row", "2026-10-14T10:00:00.000Z", "sent"));

    const saved = await loadMessages("alpha");
    expect(saved.find((item) => item.packet.id === "direct-row")?.transport).toBe("direct");
    expect(saved.find((item) => item.packet.id === "legacy-row")?.transport).toBeUndefined();
  });

  it("persists delivery transitions and treats an unknown message as a no-op", async () => {
    await saveMessage(message("delivery", "2026-10-14T09:00:00.000Z"));
    await updateDelivery("alpha", "delivery", "sent");
    await updateDelivery("alpha", "delivery", "failed");
    await updateDelivery("alpha", "does-not-exist", "sent");

    await expect(loadMessages("alpha")).resolves.toEqual([{ ...message("delivery", "2026-10-14T09:00:00.000Z", "failed"), displayOrder: 0 }]);
  });

  it("places newest-to-oldest history IDs before the boundary in hub acceptance order", async () => {
    const boundary = { ...message("boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" as const };
    await saveMessage(boundary);
    const pageNewest = { ...message("page-newest", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const };
    const pageOldest = { ...message("page-oldest", "2026-10-14T23:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([pageNewest, pageOldest], "boundary", 0)).resolves.toBe(true);
    const saved = await loadMessages("alpha");
    expect(saved.map((item) => item.packet.id)).toEqual(["page-oldest", "page-newest", "boundary"]);
    expect(saved.map((item) => item.displayOrder)).toEqual([-2, -1, 0]);
  });

  it("merges a null-cursor retry around known rows without moving them by timestamp", async () => {
    const first = { ...message("first", "2026-10-14T10:00:00.000Z", "sent"), transport: "hub" as const };
    const second = { ...message("second", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" as const };
    await saveMessage(first);
    await saveMessage(second);
    const older = { ...message("older", "2026-10-14T23:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([first, older], null, 1)).resolves.toBe(true);
    const saved = await loadMessages("alpha");
    expect(saved.map((item) => item.packet.id)).toEqual(["older", "first", "second"]);
  });

  it("honors a room deletion tombstone when committing a history page", async () => {
    await beginRoomDeletion("alpha");
    const page = { ...message("deleted-page", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([page], null, -1)).resolves.toBe(false);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("deletes all saved and queued messages from one room while preserving identity and other rooms", async () => {
    const identity = { sender: "device-1", senderName: "Ada" };
    await saveIdentity(identity);
    await saveMessage(message("queued", "2026-10-14T09:00:00.000Z"));
    await saveMessage({ ...message("accepted", "2026-10-14T10:00:00.000Z", "sent"), direction: "incoming" });
    await saveMessage({ ...message("other-room", "2026-10-14T08:00:00.000Z"), packet: packet("other-room", "2026-10-14T08:00:00.000Z", "beta") });

    await expect(deleteRoomMessages("alpha")).resolves.toBe(2);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
    await expect(loadMessages("beta")).resolves.toHaveLength(1);
    await expect(loadIdentity()).resolves.toEqual(identity);
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);
  });

  it("blocks a stale cross-tab replay after deletion until the user resumes the room", async () => {
    await saveMessage(message("before-delete", "2026-10-14T09:00:00.000Z"));
    await deleteRoomMessages("alpha");

    await expect(saveMessage(message("stale-replay", "2026-10-14T10:00:00.000Z"))).resolves.toBe(false);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);

    await resumeRoomMessages("alpha");
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(false);
    await expect(saveMessage(message("user-resumed", "2026-10-14T11:00:00.000Z"))).resolves.toBe(true);
    await expect(loadMessages("alpha")).resolves.toHaveLength(1);
  });

  it("serializes deletion start against pending and later room resumes", async () => {
    await saveMessage(message("before-delete", "2026-10-14T09:00:00.000Z"));
    await deleteRoomMessages("alpha");

    const resumeAlreadyStarted = resumeRoomMessages("alpha");
    await beginRoomDeletion("alpha");
    await resumeAlreadyStarted.catch(() => undefined);
    await expect(resumeRoomMessages("alpha")).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("still being deleted"),
    });
    await expect(saveMessage(message("replay-during-delete", "2026-10-14T10:00:00.000Z"))).resolves.toBe(false);

    await deleteRoomMessages("alpha");
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
    await expect(saveMessage(message("replay-after-delete", "2026-10-14T11:00:00.000Z"))).resolves.toBe(false);

    await resumeRoomMessages("alpha");
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(false);
    await expect(saveMessage(message("user-resumed", "2026-10-14T12:00:00.000Z"))).resolves.toBe(true);
    await expect(loadMessages("alpha")).resolves.toHaveLength(1);
  });

  it("removes only an unfinished marker when a room deletion is cancelled", async () => {
    await beginRoomDeletion("alpha");
    await cancelRoomDeletion("alpha");
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(false);

    await deleteRoomMessages("alpha");
    await cancelRoomDeletion("alpha");
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);
  });

  it("aborts a room deletion transaction without partially deleting the conversation", async () => {
    await saveMessage(message("one", "2026-10-14T09:00:00.000Z"));
    await saveMessage(message("two", "2026-10-14T10:00:00.000Z"));
    vi.spyOn(IDBCursor.prototype, "delete").mockImplementation(function (this: IDBCursor) {
      throw new Error("Injected cursor deletion failure.");
    });

    await expect(deleteRoomMessages("alpha")).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Could not delete the local conversation"),
    });
    vi.restoreAllMocks();
    await expect(loadMessages("alpha")).resolves.toHaveLength(2);
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(false);
  });

  it("persists a hub conflict failure and clears it when a message is manually retried", async () => {
    await saveMessage(message("conflict", "2026-10-14T09:00:00.000Z"));
    await updateDelivery("alpha", "conflict", "failed", "message_conflict");
    expect((await loadMessages("alpha"))[0]).toMatchObject({ delivery: "failed", failure: "message_conflict" });

    await updateDelivery("alpha", "conflict", "queued", null);
    const retried = (await loadMessages("alpha"))[0];
    expect(retried.delivery).toBe("queued");
    expect(retried.failure).toBeUndefined();
  });

  it("upgrades a version 1 database without losing identity or conversation data", async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest(1);
      request.onupgradeneeded = () => {
        const messages = request.result.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
        messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
        request.result.createObjectStore("identity", { keyPath: "key" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["identity", "messages"], "readwrite");
      transaction.objectStore("identity").put({ key: "profile", sender: "legacy-device", senderName: "Legacy" });
      transaction.objectStore("messages").put(message("legacy-later", "2026-10-14T10:00:00.000Z"));
      transaction.objectStore("messages").put(message("legacy-earlier", "2026-10-14T09:00:00.000Z"));
      transaction.objectStore("messages").put({
        ...message("legacy-other-room", "2026-10-14T08:00:00.000Z"),
        packet: packet("legacy-other-room", "2026-10-14T08:00:00.000Z", "beta"),
      });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(loadIdentity()).resolves.toEqual({ sender: "legacy-device", senderName: "Legacy" });
    await expect(loadMessages("alpha")).resolves.toEqual([
      { ...message("legacy-earlier", "2026-10-14T09:00:00.000Z"), displayOrder: 0 },
      { ...message("legacy-later", "2026-10-14T10:00:00.000Z"), displayOrder: 1 },
    ]);
    await expect(loadMessages("beta")).resolves.toEqual([{
      ...message("legacy-other-room", "2026-10-14T08:00:00.000Z"),
      packet: packet("legacy-other-room", "2026-10-14T08:00:00.000Z", "beta"),
      displayOrder: 0,
    }]);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(upgraded.version).toBe(5);
    expect(upgraded.transaction("messages").objectStore("messages").indexNames.contains("roomDeliveryCreatedAt")).toBe(true);
    expect(upgraded.transaction("messages").objectStore("messages").indexNames.contains("roomDisplayOrder")).toBe(true);
    expect(upgraded.objectStoreNames.contains("roomDeletions")).toBe(true);
    upgraded.close();
  });

  it("preserves version 4 message order, rows, identity, tombstones, indexes, and room isolation", async () => {
    const rows: StoredMessage[] = [
      { ...message("alpha-second", "2026-10-14T09:00:00.000Z", "sent"), transport: "direct", displayOrder: -3 },
      { ...message("alpha-first", "2026-10-14T10:00:00.000Z", "failed"), transport: "hub", failure: "message_conflict", displayOrder: 8 },
      {
        ...message("beta-only", "2026-10-14T08:00:00.000Z", "sent"),
        packet: packet("beta-only", "2026-10-14T08:00:00.000Z", "beta"),
        direction: "incoming",
        displayOrder: 17,
      },
    ];
    const identity = { key: "profile", sender: "v4-device", senderName: "Version Four" };
    const tombstone = { room: "alpha", state: "deleted" };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest(4);
      request.onupgradeneeded = () => {
        const messages = request.result.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
        messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
        messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
        messages.createIndex("roomDisplayOrder", ["packet.room", "displayOrder"]);
        request.result.createObjectStore("identity", { keyPath: "key" });
        request.result.createObjectStore("roomDeletions", { keyPath: "room" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["messages", "identity", "roomDeletions"], "readwrite");
      for (const row of rows) transaction.objectStore("messages").put(row);
      transaction.objectStore("identity").put(identity);
      transaction.objectStore("roomDeletions").put(tombstone);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(loadMessages("alpha")).resolves.toEqual([rows[0], rows[1]]);
    await expect(loadMessages("beta")).resolves.toEqual([rows[2]]);
    await expect(loadIdentity()).resolves.toEqual({ sender: identity.sender, senderName: identity.senderName });
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(upgraded.version).toBe(5);
    const transaction = upgraded.transaction(["messages", "identity", "roomDeletions"], "readonly");
    const messages = transaction.objectStore("messages");
    expect([...messages.indexNames].sort()).toEqual(["roomCreatedAt", "roomDeliveryCreatedAt", "roomDisplayOrder"]);
    expect(messages.index("roomDisplayOrder").keyPath).toEqual(["packet.room", "displayOrder"]);
    const persistedRows = await new Promise<StoredMessage[]>((resolve, reject) => {
      const request = messages.getAll() as IDBRequest<StoredMessage[]>;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(persistedRows).toEqual(expect.arrayContaining(rows));
    expect(persistedRows).toHaveLength(rows.length);
    upgraded.close();
  });

  it("repairs timestamp-ordered legacy hub rows from accepted replay order without moving direct rows", async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest(1);
      request.onupgradeneeded = () => {
        const messages = request.result.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
        messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
        request.result.createObjectStore("identity", { keyPath: "key" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({ ...message("hub-accepted-later", "2026-10-14T08:00:00.000Z"), transport: "hub", delivery: "sent" });
      transaction.objectStore("messages").put({ ...message("direct-between", "2026-10-14T09:00:00.000Z"), transport: "direct", delivery: "sent" });
      transaction.objectStore("messages").put({ ...message("hub-accepted-first", "2026-10-14T22:00:00.000Z"), transport: "hub", delivery: "sent" });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    expect((await loadMessages("alpha")).map((item) => item.packet.id)).toEqual([
      "hub-accepted-later", "direct-between", "hub-accepted-first",
    ]);
    await expect(reconcileHubReplayOrder("alpha", ["hub-accepted-first", "hub-accepted-later"])).resolves.toBe(true);
    const reconciled = await loadMessages("alpha");
    expect(reconciled.map((item) => item.packet.id)).toEqual([
      "hub-accepted-first", "direct-between", "hub-accepted-later",
    ]);
    expect(reconciled.find((item) => item.packet.id === "direct-between")).toMatchObject({ transport: "direct", displayOrder: 1 });
  });

  it("reports a quota-style write failure and leaves existing messages intact", async () => {
    await saveMessage(message("preserved", "2026-10-14T09:00:00.000Z"));
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "messages") throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
      return originalPut.apply(this, args);
    });

    await expect(saveMessage(message("rejected", "2026-10-14T10:00:00.000Z"))).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Storage quota exceeded"),
      cause: expect.objectContaining({ name: "QuotaExceededError" }),
    });
    vi.restoreAllMocks();
    await expect(loadMessages("alpha")).resolves.toEqual([{ ...message("preserved", "2026-10-14T09:00:00.000Z"), displayOrder: 0 }]);
  });

  it("reports a transaction abort even after the write request succeeds", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const request = originalPut.apply(this, args);
      request.addEventListener("success", () => request.transaction?.abort());
      return request;
    });

    await expect(saveMessage(message("aborted", "2026-10-14T10:00:00.000Z"))).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Could not save the local message"),
    });
    vi.restoreAllMocks();
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("rejects an incompatible legacy schema without deleting the old store", async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest(1);
      request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: "id" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    database.close();

    await expect(loadMessages("alpha")).rejects.toMatchObject({ name: "LocalStorageError", message: expect.stringContaining("incompatible key path") });
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest(1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(legacy.objectStoreNames.contains("messages")).toBe(true);
    expect(legacy.version).toBe(1);
    legacy.close();
  });
});
