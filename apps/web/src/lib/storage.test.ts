import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePacket } from "@nearlink/protocol";
import { loadIdentity, loadMessages, saveIdentity, saveMessage, updateDelivery, type StoredMessage } from "./storage";

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
      { ...message("earlier", "2026-10-14T09:00:00.000Z"), delivery: "queued" },
      { ...message("incoming", "2026-10-14T09:30:00.000Z", "sent"), direction: "incoming" },
      message("later", "2026-10-14T10:00:00.000Z"),
    ]);
    await expect(loadMessages("missing")).resolves.toEqual([]);
  });

  it("deduplicates repeated room and message identifiers by replacing the existing record", async () => {
    await saveMessage(message("same-id", "2026-10-14T09:00:00.000Z"));
    const duplicate = message("same-id", "2026-10-14T10:00:00.000Z", "sent");
    duplicate.packet.body = "updated duplicate";
    await saveMessage(duplicate);

    await expect(loadMessages("alpha")).resolves.toEqual([duplicate]);
  });

  it("persists delivery transitions and treats an unknown message as a no-op", async () => {
    await saveMessage(message("delivery", "2026-10-14T09:00:00.000Z"));
    await updateDelivery("alpha", "delivery", "sent");
    await updateDelivery("alpha", "delivery", "failed");
    await updateDelivery("alpha", "does-not-exist", "sent");

    await expect(loadMessages("alpha")).resolves.toEqual([message("delivery", "2026-10-14T09:00:00.000Z", "failed")]);
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
      transaction.objectStore("messages").put(message("legacy", "2026-10-14T09:00:00.000Z"));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(loadIdentity()).resolves.toEqual({ sender: "legacy-device", senderName: "Legacy" });
    await expect(loadMessages("alpha")).resolves.toEqual([message("legacy", "2026-10-14T09:00:00.000Z")]);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(upgraded.version).toBe(2);
    expect(upgraded.transaction("messages").objectStore("messages").indexNames.contains("roomDeliveryCreatedAt")).toBe(true);
    upgraded.close();
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
    await expect(loadMessages("alpha")).resolves.toEqual([message("preserved", "2026-10-14T09:00:00.000Z")]);
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
