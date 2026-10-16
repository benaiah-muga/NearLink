import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HISTORY_PAGE_MESSAGES, type MessagePacket } from "@nearlink/protocol";
import { acceptInboundMessage, AcceptedMessageIdCollector, beginRoomDeletion, cancelRoomDeletion, deleteRoomMessages, isRoomMessagesDeleted, loadAcceptedMessageIds, loadIdentity, loadMessagePage, loadMessages, loadQueuedMessagePage, loadRequestedMessages, MAX_HUB_REPLAY_ORDER_IDS, MAX_SYNC_STORAGE_IDS, MAX_SYNC_STORAGE_ROWS_SCANNED, reconcileHubReplayOrder, resumeRoomMessages, saveHubHistoryPage, saveIdentity, saveMessage, updateDelivery, type StoredMessage } from "./storage";

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

async function seedLargeRoom(rowCount: number, includeLegacyRow = false): Promise<void> {
  await saveIdentity({ sender: "device-1", senderName: "Ada" });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = openRequest();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("messages", "readwrite");
    const store = transaction.objectStore("messages");
    for (let index = 0; index < rowCount; index += 1) {
      store.put({ ...message(`large-${String(index).padStart(4, "0")}`, "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: index });
    }
    if (includeLegacyRow) store.put(message("legacy-no-order", "2026-10-14T09:00:01.000Z"));
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function seedRawMessages(rows: StoredMessage[]): Promise<void> {
  await saveIdentity({ sender: "device-1", senderName: "Ada" });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = openRequest();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("messages", "readwrite");
    for (const row of rows) transaction.objectStore("messages").put(row);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

afterEach(async () => {
  classifierGate.failNext = false;
  vi.restoreAllMocks();
  await deleteDatabase();
});

describe("local IndexedDB storage", () => {
  it("caps snapshots at exactly 4,096 accepted IDs and reports the 4,097th as truncated", () => {
    const collector = new AcceptedMessageIdCollector();
    for (let index = 0; index < MAX_SYNC_STORAGE_IDS; index += 1) {
      expect(collector.record(message(`id-${String(index).padStart(4, "0")}`, "2026-10-14T09:00:00.000Z", "sent"), "alpha", () => true)).toBe(true);
    }
    expect(collector.ids).toHaveLength(4096);
    expect(collector.ids[0]).toBe("id-0000");
    expect(collector.ids.at(-1)).toBe("id-4095");
    expect(collector.truncated).toBe(false);
    expect(collector.record(message("id-4096", "2026-10-14T09:00:00.000Z", "sent"), "alpha", () => true)).toBe(false);
    expect(collector.ids).toHaveLength(4096);
    expect(collector.truncated).toBe(true);
  });

  it("bounds scanned rows and signals incomplete scans even when every row is rejected", () => {
    const collector = new AcceptedMessageIdCollector();
    const queued = message("queued", "2026-10-14T09:00:00.000Z");
    for (let index = 0; index < MAX_SYNC_STORAGE_ROWS_SCANNED; index += 1) {
      expect(collector.record(queued, "alpha", () => true)).toBe(true);
    }
    expect(collector.scanned).toBe(MAX_SYNC_STORAGE_ROWS_SCANNED);
    expect(collector.truncated).toBe(false);
    expect(collector.record(queued, "alpha", () => true)).toBe(false);
    expect(collector.scanned).toBe(MAX_SYNC_STORAGE_ROWS_SCANNED);
    expect(collector.truncated).toBe(true);
    expect(collector.ids).toEqual([]);
  });

  it("uses a primary-key cursor for deterministic accepted-only room IDs", async () => {
    await saveMessage(message("zulu", "2026-10-14T09:00:00.000Z", "sent"));
    await saveMessage(message("alpha", "2026-10-14T09:00:00.000Z", "sent"));
    await saveMessage(message("queued", "2026-10-14T09:00:00.000Z"));
    await saveMessage({ ...message("other-room", "2026-10-14T09:00:00.000Z", "sent"), packet: packet("other-room", "2026-10-14T09:00:00.000Z", "beta") });
    await expect(loadAcceptedMessageIds("alpha", () => true)).resolves.toEqual({ ids: ["alpha", "zulu"], truncated: false });
  });

  it("reads only up to 100 requested accepted valid rows in request order", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => message(`id-${String(index).padStart(3, "0")}`, "2026-10-14T09:00:00.000Z", "sent"));
    for (const row of rows) await saveMessage(row);
    await saveMessage(message("queued", "2026-10-14T09:00:00.000Z"));
    const acceptedIds = rows.slice(0, 99).map((row) => row.packet.id).reverse();
    const ids = acceptedIds.concat("queued");
    const found = await loadRequestedMessages("alpha", ids, (candidate) => candidate.id !== "id-000");
    expect(found.map((row) => row.packet.id)).toEqual(acceptedIds.filter((id) => id !== "id-000"));
    await expect(loadRequestedMessages("alpha", [...ids, "one-too-many"], () => true)).rejects.toThrow("at most 100");
  });

  it("fails the bounded snapshot if the injected validator throws", async () => {
    await saveMessage(message("validator-failure", "2026-10-14T09:00:00.000Z", "sent"));
    await expect(loadAcceptedMessageIds("alpha", () => { throw new Error("validator unavailable"); })).rejects.toThrow("validator unavailable");
  });

  it("keeps a snapshot consistent with concurrent inbound writes and room deletion", async () => {
    const incoming: StoredMessage = { packet: packet("snapshot-race", "2026-10-14T09:00:00.000Z"), direction: "incoming", delivery: "sent", transport: "direct" };
    const [writeSnapshot] = await Promise.all([
      loadAcceptedMessageIds("alpha", () => true),
      saveMessage(incoming),
    ]);
    expect([[], ["snapshot-race"]]).toContainEqual(writeSnapshot.ids);
    const [deleteSnapshot] = await Promise.all([
      loadAcceptedMessageIds("alpha", () => true),
      beginRoomDeletion("alpha").then(() => deleteRoomMessages("alpha")),
    ]);
    expect([[], ["snapshot-race"]]).toContainEqual(deleteSnapshot.ids);
    expect(await loadAcceptedMessageIds("alpha", () => true)).toEqual({ ids: [], truncated: false });
  });

  it("persists and reloads an identity and ordered messages", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    await saveMessage(message("later", "2026-10-14T10:00:00.000Z"));
    await saveMessage(message("earlier", "2026-10-14T09:00:00.000Z"));
    await saveMessage({ ...message("incoming", "2026-10-14T09:30:00.000Z", "sent"), direction: "incoming" });
    await saveMessage({ ...message("other-room", "2026-10-14T08:00:00.000Z"), packet: packet("other-room", "2026-10-14T08:00:00.000Z", "beta") });

    await expect(loadIdentity()).resolves.toEqual({ sender: "device-1", senderName: "Ada" });
    await expect(loadMessages("alpha")).resolves.toEqual([
      { ...message("later", "2026-10-14T10:00:00.000Z"), transport: "hub", displayOrder: 0 },
      { ...message("earlier", "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: 1 },
      { ...message("incoming", "2026-10-14T09:30:00.000Z", "sent"), direction: "incoming", displayOrder: 2 },
    ]);
    await expect(loadMessages("missing")).resolves.toEqual([]);
  });

  it("loads large local rooms in bounded reverse-index pages without gaps or duplicate rows", async () => {
    const rowCount = 137;
    await seedLargeRoom(rowCount);
    let materializedRoomRows = 0;
    const cursorDirections: IDBCursorDirection[] = [];
    const originalGetAll = IDBIndex.prototype.getAll;
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomCreatedAt") materializedRoomRows += 1;
      return originalGetAll.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomDisplayOrder") cursorDirections.push(args[1] ?? "next");
      return originalOpenCursor.apply(this, args);
    });

    const pages: string[][] = [];
    let page = await loadMessagePage("alpha", null, 25);
    while (true) {
      expect(page.messages.length).toBeLessThanOrEqual(25);
      pages.push(page.messages.map((row) => row.packet.id));
      if (!page.hasMore) break;
      expect(page.cursor).not.toBeNull();
      page = await loadMessagePage("alpha", page.cursor, 25);
    }

    expect(materializedRoomRows).toBe(0);
    expect(cursorDirections).toHaveLength(6);
    expect(cursorDirections.every((direction) => direction === "prev")).toBe(true);
    const collected = pages.reverse().flat();
    expect(collected).toHaveLength(rowCount);
    expect(new Set(collected).size).toBe(rowCount);
    expect(collected).toEqual(Array.from({ length: rowCount }, (_, index) => `large-${String(index).padStart(4, "0")}`));
    vi.restoreAllMocks();
  });

  it("continues through display-order ties using the established timestamp and ID ordering", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    const tiedRows = [
      message("tie-z", "2026-10-14T09:00:02.000Z"),
      message("tie-a", "2026-10-14T09:00:02.000Z"),
      message("tie-m", "2026-10-14T09:00:03.000Z"),
    ].map((row) => ({ ...row, displayOrder: 7 }));
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      for (const row of tiedRows) transaction.objectStore("messages").put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const first = await loadMessagePage("alpha", null, 2);
    expect(first.messages.map((row) => row.packet.id)).toEqual(["tie-z", "tie-m"]);
    expect(first.hasMore).toBe(true);
    const second = await loadMessagePage("alpha", first.cursor, 2);
    expect(second.messages.map((row) => row.packet.id)).toEqual(["tie-a"]);
    expect(second.hasMore).toBe(false);
  });

  it("reads queued transport pages in stable bounded order across identical keys", async () => {
    const rowCount = 137;
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      for (let index = 0; index < rowCount; index += 1) {
        const id = index === 0 ? "a_" : index === 1 ? "a-" : `queue-${String(index).padStart(3, "0")}`;
        store.put({ ...message(id, "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: 4 });
      }
      store.put({ ...message("queue-max-order", "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: Number.MAX_VALUE });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    let cursorReads = 0;
    let materializedRows = 0;
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    const originalGetAll = IDBIndex.prototype.getAll;
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomQueuedTransportOrder") cursorReads += 1;
      return originalOpenCursor.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomQueuedTransportOrder") materializedRows += 1;
      return originalGetAll.apply(this, args);
    });
    const collected: string[] = [];
    let page = await loadQueuedMessagePage("alpha", "hub", null, 17);
    while (true) {
      expect(page.messages.length).toBeLessThanOrEqual(17);
      collected.push(...page.messages.map((row) => row.packet.id));
      if (!page.hasMore) break;
      expect(page.cursor).not.toBeNull();
      page = await loadQueuedMessagePage("alpha", "hub", page.cursor, 17);
    }
    expect(cursorReads).toBe(9);
    expect(materializedRows).toBe(0);
    expect(collected).toHaveLength(rowCount + 1);
    expect(new Set(collected).size).toBe(rowCount + 1);
    expect(collected.slice(0, 2)).toEqual(["a-", "a_"]);
    expect(collected.at(-1)).toBe("queue-max-order");
    expect((await loadQueuedMessagePage("alpha", "direct", null, 17)).messages).toEqual([]);
    vi.restoreAllMocks();
  });

  it("normalizes missing transport to hub when upgrading the v6 queue index", async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        const messages = db.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
        messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
        messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
        messages.createIndex("roomDisplayOrder", ["packet.room", "displayOrder", "packet.createdAt", "packet.id"]);
        db.createObjectStore("identity", { keyPath: "key" });
        db.createObjectStore("roomDeletions", { keyPath: "room" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({ ...message("legacy-hub", "2026-10-14T09:00:00.000Z"), displayOrder: 2 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const page = await loadQueuedMessagePage("alpha", "hub");
    expect(page.messages.map((row) => [row.packet.id, row.transport])).toEqual([["legacy-hub", "hub"]]);
  });

  it("stops queued page reads after a room deletion marker is written", async () => {
    await saveMessage({ ...message("delete-queued", "2026-10-14T09:00:00.000Z"), transport: "direct" });
    await beginRoomDeletion("alpha");
    const page = await loadQueuedMessagePage("alpha", "direct");
    expect(page).toEqual({ messages: [], cursor: null, hasMore: false, deleted: true });
  });

  it("includes Number.MAX_VALUE display orders in newest reads and max lookup", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({
        ...message("maximum-order-existing", "2026-10-14T09:00:00.000Z"),
        displayOrder: Number.MAX_VALUE,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const newest = await loadMessagePage("alpha", null, 10);
    expect(newest.messages.map((row) => row.packet.id)).toEqual(["maximum-order-existing"]);
    await saveMessage(message("maximum-order-next", "2026-10-14T10:00:00.000Z"));
    const rows = await loadMessages("alpha");
    expect(rows.map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["maximum-order-existing", Number.MAX_VALUE],
      ["maximum-order-next", Number.MAX_VALUE],
    ]);
  });

  it("upgrades legacy rows without display order before bounded page reads", async () => {
    await deleteDatabase();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        const messages = db.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
        messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
        messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
        messages.createIndex("roomDisplayOrder", ["packet.room", "displayOrder"]);
        db.createObjectStore("identity", { keyPath: "key" });
        db.createObjectStore("roomDeletions", { keyPath: "room" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({ ...message("existing-order", "2026-10-14T09:00:00.000Z"), displayOrder: 4 });
      transaction.objectStore("messages").put(message("legacy-order-later", "2026-10-14T10:00:00.000Z"));
      transaction.objectStore("messages").put(message("legacy-order-earlier", "2026-10-14T08:00:00.000Z"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const page = await loadMessagePage("alpha", null, 10);
    expect(page.messages.map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["existing-order", 4],
      ["legacy-order-earlier", 5],
      ["legacy-order-later", 6],
    ]);
    expect(page.hasMore).toBe(false);
    expect(await loadMessages("alpha")).toMatchObject([
      { packet: { id: "existing-order" }, displayOrder: 4 },
      { packet: { id: "legacy-order-earlier" }, displayOrder: 5 },
      { packet: { id: "legacy-order-later" }, displayOrder: 6 },
    ]);
  });

  it("uses one reverse max cursor for large-room saves and inbound acceptance", async () => {
    const existingRows = 512;
    await seedLargeRoom(existingRows, true);

    let materializedRoomRows = 0;
    const cursorDirections: IDBCursorDirection[] = [];
    let cursorContinues = 0;
    const originalGetAll = IDBIndex.prototype.getAll;
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    const originalContinue = IDBCursor.prototype.continue;
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomCreatedAt") materializedRoomRows += 1;
      return originalGetAll.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomDisplayOrder") cursorDirections.push(args[1] ?? "next");
      return originalOpenCursor.apply(this, args);
    });
    vi.spyOn(IDBCursor.prototype, "continue").mockImplementation(function (this: IDBCursor, ...args: Parameters<IDBCursor["continue"]>) {
      if ((this.source as IDBIndex).name === "roomDisplayOrder") cursorContinues += 1;
      return originalContinue.apply(this, args);
    });

    await expect(saveMessage(message("large-room-save", "2026-10-14T09:01:00.000Z"))).resolves.toBe(true);
    const incoming: StoredMessage = {
      packet: packet("large-room-inbound", "2026-10-14T09:02:00.000Z"),
      direction: "incoming",
      delivery: "sent",
      transport: "direct",
    };
    await expect(acceptInboundMessage(incoming)).resolves.toBe("saved");

    expect(materializedRoomRows).toBe(0);
    expect(cursorDirections).toEqual(["prev", "prev"]);
    expect(cursorContinues).toBe(0);
    vi.restoreAllMocks();

    const rows = await loadMessages("alpha");
    expect(rows.find((row) => row.packet.id === "large-room-save")?.displayOrder).toBe(existingRows);
    expect(rows.find((row) => row.packet.id === "large-room-inbound")?.displayOrder).toBe(existingRows + 1);
    expect(rows.find((row) => row.packet.id === "legacy-no-order")?.displayOrder).toBe(existingRows + 2);
  });

  it("loads identity, room messages, and deletion status concurrently", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    await saveMessage(message("parallel-read", "2026-10-14T09:00:00.000Z"));
    await expect(Promise.all([loadIdentity(), loadMessages("alpha"), isRoomMessagesDeleted("alpha")])).resolves.toEqual([
      { sender: "device-1", senderName: "Ada" },
      [{ ...message("parallel-read", "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: 0 }],
      false,
    ]);
  });

  it("deduplicates repeated room and message identifiers by replacing the existing record", async () => {
    await saveMessage(message("same-id", "2026-10-14T09:00:00.000Z"));
    const duplicate = message("same-id", "2026-10-14T10:00:00.000Z", "sent");
    duplicate.packet.body = "updated duplicate";
    await saveMessage(duplicate);

    await expect(loadMessages("alpha")).resolves.toEqual([{ ...duplicate, transport: "hub", displayOrder: 0 }]);
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
    expect(saved.find((item) => item.packet.id === "legacy-row")?.transport).toBe("hub");
  });

  it("persists delivery transitions and treats an unknown message as a no-op", async () => {
    await saveMessage(message("delivery", "2026-10-14T09:00:00.000Z"));
    await updateDelivery("alpha", "delivery", "sent");
    await updateDelivery("alpha", "delivery", "failed");
    await updateDelivery("alpha", "does-not-exist", "sent");

    await expect(loadMessages("alpha")).resolves.toEqual([{ ...message("delivery", "2026-10-14T09:00:00.000Z", "failed"), transport: "hub", displayOrder: 0 }]);
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

  it("reads only page IDs and the cursor for an older history page", async () => {
    await seedRawMessages([
      { ...message("boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub", displayOrder: 4 },
      { ...message("page-newest", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub", displayOrder: -2 },
      { ...message("unrelated", "2026-10-14T11:00:00.000Z", "sent"), transport: "direct", displayOrder: 9 },
      { ...message("other-room", "2026-10-14T12:00:00.000Z", "sent"), packet: packet("other-room", "2026-10-14T12:00:00.000Z", "beta"), transport: "hub", displayOrder: 0 },
    ]);
    const page = [
      { ...message("page-newest", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("page-oldest", "2026-10-14T23:00:00.000Z", "sent"), transport: "hub" as const },
    ];
    const messageKeyReads: IDBValidKey[] = [];
    const broadReads: string[] = [];
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBIndex.prototype.getAll;
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
      if (this.name === "messages") messageKeyReads.push(args[0] as IDBValidKey);
      return originalGet.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomCreatedAt") broadReads.push("roomCreatedAt.getAll");
      return originalGetAll.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomDisplayOrder" || this.name === "roomCreatedAt") broadReads.push(`${this.name}.openCursor`);
      return originalOpenCursor.apply(this, args);
    });

    await expect(saveHubHistoryPage(page, "boundary", 4)).resolves.toBe(true);
    expect(messageKeyReads).toEqual([["alpha", "page-newest"], ["alpha", "page-oldest"], ["alpha", "boundary"]]);
    expect(broadReads).toEqual([]);
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["page-newest", -2],
      ["page-oldest", 2],
      ["boundary", 4],
      ["unrelated", 9],
    ]);
    expect((await loadMessages("beta")).map((row) => row.packet.id)).toEqual(["other-room"]);
  });

  it.each([
    { name: "positive oldest order", oldestOrder: 5, expected: [-1, -2] },
    { name: "negative oldest order", oldestOrder: -8, expected: [-9, -10] },
  ])("uses the zero-clamped oldest order when a history cursor is missing with $name", async ({ oldestOrder, expected }) => {
    await seedRawMessages([
      { ...message("oldest", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub", displayOrder: oldestOrder },
      { ...message("newer", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub", displayOrder: oldestOrder + 4 },
    ]);
    const oldestRanges: IDBKeyRange[] = [];
    const broadReads: string[] = [];
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    const originalGetAll = IDBIndex.prototype.getAll;
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomDisplayOrder") oldestRanges.push(args[0] as IDBKeyRange);
      if (this.name === "roomCreatedAt") broadReads.push("roomCreatedAt.openCursor");
      return originalOpenCursor.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomCreatedAt") broadReads.push("roomCreatedAt.getAll");
      return originalGetAll.apply(this, args);
    });
    const page = [
      { ...message("fallback-newest", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("fallback-oldest", "2026-10-14T06:00:00.000Z", "sent"), transport: "hub" as const },
    ];

    await expect(saveHubHistoryPage(page, "expired-cursor", 20)).resolves.toBe(true);
    expect(oldestRanges).toHaveLength(1);
    expect(oldestRanges[0]).toMatchObject({ lower: ["alpha"], upper: ["alpha", []], lowerOpen: false, upperOpen: false });
    expect(broadReads).toEqual([]);
    vi.restoreAllMocks();
    const saved = await loadMessages("alpha");
    expect(["fallback-newest", "fallback-oldest"].map((id) => saved.find((row) => row.packet.id === id)?.displayOrder)).toEqual(expected);
  });

  it("checks existing history candidates for content conflicts before writing", async () => {
    const existing = { ...message("conflicting-page", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const, displayOrder: 2 };
    const boundary = { ...message("conflict-boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" as const, displayOrder: 4 };
    await seedRawMessages([existing, boundary]);
    const conflicting = { ...existing, packet: { ...existing.packet, body: "changed history content" } };
    const newPageMessage = { ...message("conflict-page-new", "2026-10-14T06:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([newPageMessage, conflicting], "conflict-boundary", 4)).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("conflicts with saved message content"),
    });
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["conflicting-page", 2],
      ["conflict-boundary", 4],
    ]);
  });

  it("rejects conflicting duplicate IDs inside an older history page", async () => {
    await saveMessage({ ...message("duplicate-boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" });
    const first = { ...message("duplicate-page", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const };
    const conflict = { ...first, packet: { ...first.packet, body: "different duplicate content" } };

    await expect(saveHubHistoryPage([first, conflict], "duplicate-boundary", 0)).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("conflicts with saved message content"),
    });
    await expect(loadMessages("alpha")).resolves.toHaveLength(1);
  });

  it("honors the room tombstone for a non-null history cursor", async () => {
    await beginRoomDeletion("alpha");
    const page = { ...message("tombstoned-page", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([page], "missing-boundary", 0)).resolves.toBe(false);
    await expect(loadMessages("alpha")).resolves.toEqual([]);
  });

  it("aborts an older history page when an exact lookup fails", async () => {
    const boundary = { ...message("lookup-boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" as const, displayOrder: 4 };
    await seedRawMessages([boundary]);
    const originalGet = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
      if (this.name === "messages" && JSON.stringify(args[0]) === JSON.stringify(["alpha", "lookup-page"])) {
        throw new DOMException("Injected history lookup failure.", "UnknownError");
      }
      return originalGet.apply(this, args);
    });
    const page = { ...message("lookup-page", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const };

    await expect(saveHubHistoryPage([page], "lookup-boundary", 4)).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Injected history lookup failure"),
    });
    vi.restoreAllMocks();
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([["lookup-boundary", 4]]);
  });

  it("aborts an older history page when a message write fails", async () => {
    await saveMessage({ ...message("write-boundary", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" });
    const originalPut = IDBObjectStore.prototype.put;
    let messageWrites = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "messages" && ++messageWrites === 2) throw new DOMException("Injected history write failure.", "QuotaExceededError");
      return originalPut.apply(this, args);
    });
    const page = [
      { ...message("write-page-one", "2026-10-14T07:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("write-page-two", "2026-10-14T06:00:00.000Z", "sent"), transport: "hub" as const },
    ];

    await expect(saveHubHistoryPage(page, "write-boundary", 0)).rejects.toMatchObject({
      name: "LocalStorageError",
      message: expect.stringContaining("Injected history write failure"),
    });
    expect(messageWrites).toBe(2);
    vi.restoreAllMocks();
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([["write-boundary", 0]]);
  });

  it("caps older history page exact reads at the protocol page size", async () => {
    const page = Array.from({ length: MAX_HISTORY_PAGE_MESSAGES + 1 }, (_, index) => ({
      ...message(`oversized-history-${index}`, "2026-10-14T07:00:00.000Z", "sent"),
      transport: "hub" as const,
    }));
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get");

    await expect(saveHubHistoryPage(page, "boundary", 0)).rejects.toThrow(
      `A history page cannot contain more than ${MAX_HISTORY_PAGE_MESSAGES} messages.`,
    );
    expect(getSpy).not.toHaveBeenCalled();
    await expect(loadMessages("alpha")).resolves.toEqual([]);
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
      { ...message("legacy-earlier", "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: 0 },
      { ...message("legacy-later", "2026-10-14T10:00:00.000Z"), transport: "hub", displayOrder: 1 },
    ]);
    await expect(loadMessages("beta")).resolves.toEqual([{
      ...message("legacy-other-room", "2026-10-14T08:00:00.000Z"),
      packet: packet("legacy-other-room", "2026-10-14T08:00:00.000Z", "beta"),
      transport: "hub",
      displayOrder: 0,
    }]);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(upgraded.version).toBe(7);
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
        transport: "hub",
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
    await expect(loadMessages("beta")).resolves.toEqual([{ ...rows[2], transport: "hub" }]);
    await expect(loadIdentity()).resolves.toEqual({ sender: identity.sender, senderName: identity.senderName });
    await expect(isRoomMessagesDeleted("alpha")).resolves.toBe(true);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    expect(upgraded.version).toBe(7);
    const transaction = upgraded.transaction(["messages", "identity", "roomDeletions"], "readonly");
    const messages = transaction.objectStore("messages");
    expect([...messages.indexNames].sort()).toEqual(["roomCreatedAt", "roomDeliveryCreatedAt", "roomDisplayOrder", "roomQueuedTransportOrder"]);
    expect(messages.index("roomDisplayOrder").keyPath).toEqual(["packet.room", "displayOrder", "packet.createdAt", "packet.id"]);
    expect(messages.index("roomQueuedTransportOrder").keyPath).toEqual(["packet.room", "direction", "delivery", "transport", "displayOrder", "packet.createdAt", "packet.id"]);
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

  it("reads only the bounded replay IDs and preserves stable slots around missing and filtered rows", async () => {
    const replayRows = [
      { ...message("hub-later", "2026-10-14T08:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("direct-between", "2026-10-14T09:00:00.000Z", "sent"), transport: "direct" as const },
      { ...message("hub-first", "2026-10-14T22:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("hub-queued", "2026-10-14T23:00:00.000Z"), transport: "hub" as const },
      { ...message("hub-failed", "2026-10-15T00:00:00.000Z", "failed"), transport: "hub" as const },
      { ...message("other-room", "2026-10-15T01:00:00.000Z", "sent"), transport: "hub" as const, packet: packet("other-room", "2026-10-15T01:00:00.000Z", "beta") },
    ];
    for (const row of replayRows) await saveMessage(row);
    const orderedIds = ["hub-first", "missing-row", "hub-later", "direct-between", "hub-queued", "hub-failed"];
    const messageKeyReads: IDBValidKey[] = [];
    const roomIndexReads: string[] = [];
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBIndex.prototype.getAll;
    const originalOpenCursor = IDBIndex.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
      if (this.name === "messages") messageKeyReads.push(args[0] as IDBValidKey);
      return originalGet.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      if (this.name === "roomCreatedAt") roomIndexReads.push("getAll");
      return originalGetAll.apply(this, args);
    });
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      if (this.name === "roomCreatedAt") roomIndexReads.push("openCursor");
      return originalOpenCursor.apply(this, args);
    });

    await expect(reconcileHubReplayOrder("alpha", orderedIds)).resolves.toBe(true);
    vi.restoreAllMocks();
    expect(messageKeyReads).toEqual(orderedIds.map((id) => ["alpha", id]));
    expect(roomIndexReads).toEqual([]);
    const reconciled = await loadMessages("alpha");
    expect(reconciled.map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["hub-first", 0],
      ["direct-between", 1],
      ["hub-later", 2],
      ["hub-queued", 3],
      ["hub-failed", 4],
    ]);
    expect((await loadMessages("beta")).map((row) => [row.packet.id, row.displayOrder])).toEqual([["other-room", 0]]);
  });

  it("uses createdAt and code-unit ID ordering to break replay slot ties", async () => {
    await saveIdentity({ sender: "device-1", senderName: "Ada" });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openRequest();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      store.put({ ...message("a_", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub", displayOrder: undefined });
      store.put({ ...message("a-", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub", displayOrder: Number.MAX_SAFE_INTEGER });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(reconcileHubReplayOrder("alpha", ["a_", "a-"])).resolves.toBe(true);
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["a-", 1],
      ["a_", Number.MAX_SAFE_INTEGER],
    ]);
  });

  it("rejects replay order lists above the local hub replay bound before reading rows", async () => {
    const rows = [
      { ...message("bounded-first", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" as const },
      { ...message("bounded-second", "2026-10-14T10:00:00.000Z", "sent"), transport: "hub" as const },
    ];
    for (const row of rows) await saveMessage(row);
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get");

    await expect(reconcileHubReplayOrder("alpha", Array(MAX_HUB_REPLAY_ORDER_IDS + 1).fill("bounded-first")))
      .rejects.toThrow(`Hub replay order cannot contain more than ${MAX_HUB_REPLAY_ORDER_IDS} message IDs.`);
    expect(getSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["bounded-first", 0],
      ["bounded-second", 1],
    ]);
  });

  it("does not reorder on a deletion tombstone and ignores missing replay IDs", async () => {
    await saveMessage({ ...message("tombstone-first", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" });
    await saveMessage({ ...message("tombstone-second", "2026-10-14T10:00:00.000Z", "sent"), transport: "hub" });
    await beginRoomDeletion("alpha");
    await expect(reconcileHubReplayOrder("alpha", ["tombstone-second", "missing", "tombstone-first"])).resolves.toBe(false);
    await cancelRoomDeletion("alpha");
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["tombstone-first", 0],
      ["tombstone-second", 1],
    ]);
  });

  it("aborts replay-order reconciliation when an exact key read fails", async () => {
    await saveMessage({ ...message("read-fail-first", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" });
    await saveMessage({ ...message("read-fail-second", "2026-10-14T10:00:00.000Z", "sent"), transport: "hub" });
    const originalGet = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
      if (this.name === "messages" && JSON.stringify(args[0]) === JSON.stringify(["alpha", "read-fail-second"])) {
        throw new DOMException("Injected replay lookup failure.", "UnknownError");
      }
      return originalGet.apply(this, args);
    });

    await expect(reconcileHubReplayOrder("alpha", ["read-fail-second", "read-fail-first"]))
      .rejects.toMatchObject({ name: "LocalStorageError", message: expect.stringContaining("Injected replay lookup failure") });
    vi.restoreAllMocks();
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["read-fail-first", 0],
      ["read-fail-second", 1],
    ]);
  });

  it("aborts replay-order reconciliation when a slot write fails", async () => {
    await saveMessage({ ...message("write-fail-first", "2026-10-14T09:00:00.000Z", "sent"), transport: "hub" });
    await saveMessage({ ...message("write-fail-second", "2026-10-14T10:00:00.000Z", "sent"), transport: "hub" });
    const originalPut = IDBObjectStore.prototype.put;
    let messageWrites = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "messages" && ++messageWrites === 2) throw new DOMException("Injected replay order write failure.", "QuotaExceededError");
      return originalPut.apply(this, args);
    });

    await expect(reconcileHubReplayOrder("alpha", ["write-fail-second", "write-fail-first"]))
      .rejects.toMatchObject({ name: "LocalStorageError", message: expect.stringContaining("Injected replay order write failure") });
    expect(messageWrites).toBe(2);
    vi.restoreAllMocks();
    expect((await loadMessages("alpha")).map((row) => [row.packet.id, row.displayOrder])).toEqual([
      ["write-fail-first", 0],
      ["write-fail-second", 1],
    ]);
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
    await expect(loadMessages("alpha")).resolves.toEqual([{ ...message("preserved", "2026-10-14T09:00:00.000Z"), transport: "hub", displayOrder: 0 }]);
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
