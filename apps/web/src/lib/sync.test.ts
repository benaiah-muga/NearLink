import { describe, expect, it, vi } from "vitest";
import type { MessagePacket, SyncPacket } from "@nearlink/protocol";
import { SyncCoordinator, type SyncState } from "./sync";
import type { StoredMessage } from "./storage";

const room = "sync-room";

function packet(id: string, sender: string, body = id): MessagePacket {
  return { version: 1, type: "message", id, room, sender, senderName: sender, createdAt: "2026-10-14T09:00:00.000Z", body };
}

function stored(id: string, sender: string, delivery: "sent" | "queued" | "failed" = "sent"): StoredMessage {
  return { packet: packet(id, sender), direction: sender === "local-a" ? "outgoing" : "incoming", delivery, transport: "hub" };
}

describe("SyncCoordinator", () => {
  it("exchanges only accepted messages and verifies transferred packets after durable storage", async () => {
    const aRows = [stored("only-a", "local-a"), stored("queued-a", "local-a", "queued")];
    const bRows = [stored("only-b", "local-b")];
    const queue: Array<{ target: "a" | "b"; packet: SyncPacket | MessagePacket }> = [];
    let a!: SyncCoordinator;
    let b!: SyncCoordinator;
    const states: SyncState[] = [];
    a = new SyncCoordinator({ room, sender: "local-a", makeId: (() => { let id = 0; return () => `a-${++id}`; })(), send: (value) => queue.push({ target: "b", packet: value }), loadAccepted: async () => aRows, validateMessage: () => true, onState: (state) => states.push(state) });
    b = new SyncCoordinator({ room, sender: "local-b", makeId: (() => { let id = 0; return () => `b-${++id}`; })(), send: (value) => queue.push({ target: "a", packet: value }), loadAccepted: async () => bRows, validateMessage: () => true });

    await Promise.all([a.start(), b.start()]);
    while (queue.length) {
      const next = queue.shift()!;
      const target = next.target === "a" ? a : b;
      const rows = next.target === "a" ? aRows : bRows;
      if (next.packet.type === "message") {
        rows.push({ packet: next.packet, direction: "incoming", delivery: "sent", transport: "hub" });
        target.observeAcceptedMessage(next.packet);
      } else {
        await target.receive(next.packet);
      }
    }

    expect(aRows.map((item) => item.packet.id).sort()).toEqual(["only-a", "only-b", "queued-a"]);
    expect(bRows.map((item) => item.packet.id).sort()).toEqual(["only-a", "only-b"]);
    expect(states).toContain("complete");
    a.stop();
    b.stop();
  });

  it("caps a frozen inventory at 4,096 IDs and marks its final page partial", async () => {
    const rows = Array.from({ length: 4097 }, (_, index) => stored(`id-${String(index).padStart(4, "0")}`, "local-a"));
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "session", send: (value) => sent.push(value), loadAccepted: async () => rows, validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    const pages = sent.filter((value) => value.type === "sync_inventory_page");
    expect(pages).toHaveLength(41);
    expect(pages.reduce((total, value) => total + (value.type === "sync_inventory_page" ? value.messageIds.length : 0), 0)).toBe(4096);
    expect(pages.at(-1)).toMatchObject({ hasMore: false, limitReached: true });
    expect(state).toBe("partial");
    coordinator.stop();
  });

  it("stops when a sender changes a previously received inventory page", async () => {
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local", send: () => undefined, loadAccepted: async () => [], validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    const first: SyncPacket = { version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: ["alpha"], nextCursor: "alpha", hasMore: false, limitReached: false };
    await coordinator.receive(first);
    await coordinator.receive({ ...first, messageIds: ["bravo"], nextCursor: "bravo" });
    expect(state).toBe("error");
    coordinator.stop();
  });

  it("marks omitted completion IDs partial instead of claiming full synchronization", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "request", send: (value) => sent.push(value), loadAccepted: async () => [], validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: ["alpha", "bravo"], nextCursor: "bravo", hasMore: false, limitReached: false });
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true));
    const request = sent.find((value) => value.type === "sync_missing_request");
    expect(request).toBeTruthy();
    await coordinator.receive({ version: 1, type: "sync_page_complete", room, syncId: "remote", requestId: request!.requestId, sender: "local-b", targetSender: "local-a", messageIds: [] });
    expect(state).toBe("partial");
    coordinator.stop();
  });

  it("waits for the local accepted-message snapshot before requesting or serving messages", async () => {
    const rows = [stored("local-saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let release!: (value: StoredMessage[]) => void;
    const snapshot = new Promise<StoredMessage[]>((resolve) => { release = resolve; });
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), loadAccepted: () => snapshot, validateMessage: () => true });
    const starting = coordinator.start();
    const serving = coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "early-request", sender: "local-b", targetSender: "local-a", messageIds: ["local-saved"] });
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote-session", sender: "local-c", cursor: null, messageIds: ["remote-saved"], nextCursor: "remote-saved", hasMore: false, limitReached: false });
    expect(sent.filter((value) => value.type === "message" || value.type === "sync_missing_request")).toEqual([]);
    release(rows);
    await Promise.all([starting, serving]);
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request" && value.targetSender === "local-c")).toBe(true));
    expect(sent.some((value) => value.type === "message" && value.id === "local-saved")).toBe(true);
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "early-request")).toBe(true);
    coordinator.stop();
  });

  it("does not retransmit an already handled duplicate request ID", async () => {
    const rows = [stored("local-saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), loadAccepted: async () => rows, validateMessage: () => true });
    await coordinator.start();
    const request: SyncPacket = { version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "duplicate-request", sender: "local-b", targetSender: "local-a", messageIds: ["local-saved"] };
    await coordinator.receive(request);
    await coordinator.receive(request);
    expect(sent.filter((value) => value.type === "message" && value.id === "local-saved")).toHaveLength(1);
    expect(sent.filter((value) => value.type === "sync_page_complete" && value.requestId === "duplicate-request")).toHaveLength(1);
    coordinator.stop();
  });

  it("ignores broadcast requests addressed to other room members before retaining controls", async () => {
    const rows = [stored("local-saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), loadAccepted: async () => rows, validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    for (let index = 0; index < 300; index += 1) {
      await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "other-session", requestId: `broadcast-${index}`, sender: "local-b", targetSender: "local-c", messageIds: ["local-saved"] });
    }
    expect(state).not.toBe("partial");
    await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "for-local-a", sender: "local-b", targetSender: "local-a", messageIds: ["local-saved"] });
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "for-local-a")).toBe(true);
    expect(state).not.toBe("error");
    coordinator.stop();
  });

  it("clears pending sync requests and reports partial after a control rate limit", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    let detail = "";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "request", send: (value) => sent.push(value), loadAccepted: async () => [], validateMessage: () => true, onState: (next, message) => { state = next; detail = message; } });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: ["older-message"], nextCursor: "older-message", hasMore: false, limitReached: false });
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true));
    coordinator.noteControlRateLimited("The hub rate-limited a synchronization control. Reconnect to restart from saved messages.");
    await coordinator.receive({ version: 1, type: "sync_page_complete", room, syncId: "remote", requestId: "request", sender: "local-b", targetSender: "local-a", messageIds: [] });
    expect(state).toBe("partial");
    expect(detail).toContain("Reconnect");
    expect(sent.filter((value) => value.type === "sync_missing_request")).toHaveLength(1);
    coordinator.stop();
  });

  it("cancels a paced hub response timer when the coordinator stops", async () => {
    const rows = [stored("alpha", "local-a"), stored("bravo", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), loadAccepted: async () => rows, validateMessage: () => true, messageIntervalMs: 1000 });
    await coordinator.start();
    const response = coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "stop-request", sender: "local-b", targetSender: "local-a", messageIds: ["alpha", "bravo"] });
    await vi.waitFor(() => expect(sent.some((value) => value.type === "message" && value.id === "alpha")).toBe(true));
    coordinator.stop();
    await response;
    expect(sent.filter((value) => value.type === "message")).toHaveLength(1);
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "stop-request")).toBe(false);
  });

  it("stops a hub response page after a rate limit and completes only its sent subset", async () => {
    const rows = [stored("alpha", "local-a"), stored("bravo", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let coordinator!: SyncCoordinator;
    coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => {
      sent.push(value);
      if (value.type === "message") coordinator.noteMessageRateLimited("The hub rate-limited a sync message. This exchange is partial.");
    }, loadAccepted: async () => rows, validateMessage: () => true, messageIntervalMs: 700 });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "remote-request", sender: "local-b", targetSender: "local-a", messageIds: ["alpha", "bravo"] });
    expect(sent.filter((value) => value.type === "message")).toHaveLength(1);
    expect(sent.find((value) => value.type === "sync_page_complete")).toMatchObject({ messageIds: ["alpha"] });
    coordinator.stop();
  });

  it("re-advertises after the existing hub peer advert is lost before newcomer readiness without an echo loop", async () => {
    const aRows = [stored("only-a", "local-a")];
    const bRows: StoredMessage[] = [];
    const toA: Array<SyncPacket | MessagePacket> = [];
    const toB: Array<SyncPacket | MessagePacket> = [];
    const a = new SyncCoordinator({ room, sender: "local-a", makeId: () => "a-session", send: (value) => toB.push(value), loadAccepted: async () => aRows, validateMessage: () => true, rebroadcastOnPeerInventory: true });
    await a.start();
    toB.length = 0; // The peer had not confirmed its direct session and ignored the first advertisement.
    const b = new SyncCoordinator({ room, sender: "local-b", makeId: () => "b-session", send: (value) => toA.push(value), loadAccepted: async () => bRows, validateMessage: () => true });
    await b.start();
    const bInventory = toA.find((value) => value.type === "sync_inventory_page");
    expect(bInventory).toBeTruthy();
    await a.receive(bInventory as SyncPacket);
    const aRebroadcast = toB.find((value) => value.type === "sync_inventory_page");
    expect(aRebroadcast).toMatchObject({ syncId: "a-session", messageIds: ["only-a"] });
    await b.receive(aRebroadcast as SyncPacket);
    await vi.waitFor(() => expect(toA.some((value) => value.type === "sync_missing_request")).toBe(true));
    const request = toA.find((value) => value.type === "sync_missing_request");
    expect(request).toMatchObject({ targetSender: "local-a", messageIds: ["only-a"] });
    await a.receive(request as SyncPacket);
    const duplicateAdvertisements = toB.filter((value) => value.type === "sync_inventory_page");
    expect(duplicateAdvertisements).toHaveLength(1);
    a.stop();
    b.stop();
  });

  it("limits aggregate peer controls and lets an unaffected peer continue", async () => {
    const state = { value: "idle" as SyncState };
    const sent: Array<SyncPacket | MessagePacket> = [];
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => `request-${sent.length}`, send: (packet) => sent.push(packet), loadAccepted: async () => [], validateMessage: () => true, onState: (next) => { state.value = next; } });
    await coordinator.start();
    let budgetReached = false;
    for (let peer = 0; peer < 32 && !budgetReached; peer += 1) {
      const sender = `peer-${String(peer).padStart(2, "0")}`;
      const syncId = `sync-${String(peer).padStart(2, "0")}`;
      let cursor: string | null = null;
      for (let page = 0; page < 6 && !budgetReached; page += 1) {
        const ids = Array.from({ length: 100 }, (_, index) => {
          const serial = String(page * 100 + index).padStart(3, "0");
          return `${sender}-${serial}${"x".repeat(117)}`;
        });
        const final = page === 5;
        await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId, sender, cursor, messageIds: ids, nextCursor: ids.at(-1)!, hasMore: !final, limitReached: false });
        cursor = ids.at(-1)!;
        budgetReached = state.value === "partial";
      }
    }
    expect(state.value).toBe("partial");
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "small-session", sender: "small-peer", cursor: null, messageIds: ["small-id"], nextCursor: "small-id", hasMore: false, limitReached: false });
    const completed = new Set<string>();
    for (let attempt = 0; attempt < 2000 && !sent.some((packet) => packet.type === "sync_missing_request" && packet.targetSender === "small-peer"); attempt += 1) {
      const request = sent.find((packet): packet is Extract<SyncPacket, { type: "sync_missing_request" }> => packet.type === "sync_missing_request" && !completed.has(packet.requestId));
      if (request) {
        completed.add(request.requestId);
        await coordinator.receive({ version: 1, type: "sync_page_complete", room, syncId: request.syncId, requestId: request.requestId, sender: request.targetSender, targetSender: "local-a", messageIds: [] });
      }
      await Promise.resolve();
    }
    expect(sent.some((packet) => packet.type === "sync_missing_request" && packet.targetSender === "small-peer")).toBe(true);
    coordinator.stop();
  });
});
