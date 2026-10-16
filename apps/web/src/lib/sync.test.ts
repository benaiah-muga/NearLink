import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePacket, SyncPacket } from "@nearlink/protocol";
import { SyncCoordinator, type SyncState } from "./sync";
import { initializeWasmProtocol } from "./wasmProtocol";
import type { StoredMessage } from "./storage";

const wasmState = vi.hoisted(() => ({ ready: true, frees: 0, acceptAfterFree: 0, registeredRequests: [] as string[] }));

vi.mock("./wasmProtocol", async () => {
  const protocol = await import("@nearlink/protocol");
  return {
    initializeWasmProtocol: async () => true,
    isWasmSyncStateReady: () => wasmState.ready,
    createWasmSyncCoverage: () => {
      let incomplete = false;
      let activePlans = 0;
      return {
        markIncomplete: () => { incomplete = true; },
        beginPlan: () => { activePlans += 1; },
        finishPlan: () => { activePlans = Math.max(0, activePlans - 1); },
        abandonPlan: () => { incomplete = true; activePlans = Math.max(0, activePlans - 1); },
        outcome: () => incomplete ? "partial" as const : activePlans > 0 ? "syncing" as const : "complete" as const,
        free: () => undefined,
      };
    },
    createWasmLocalInventory: (snapshot: import("./wasmProtocol").SyncLocalInventorySnapshot) => {
      if (snapshot.version !== 1 || (snapshot.room !== room)
        || (!snapshot.scanComplete && !snapshot.acceptedIdOverflow)
        || snapshot.ids.length > 4096
        || snapshot.ids.some((id, index) => index > 0 && snapshot.ids[index - 1] >= id)) throw new Error("invalid local snapshot");
      const ids = [...snapshot.ids];
      return {
        contains: (id: string) => ids.includes(id),
        missingIds: (peerIds: string[]) => peerIds.filter((id) => !ids.includes(id)),
        page(sender: string, syncId: string, offset: number) {
          const messageIds = ids.slice(offset, offset + 100);
          const hasMore = offset + messageIds.length < ids.length;
          return { version: 1, type: "sync_inventory_page", room, syncId, sender, cursor: offset === 0 ? null : ids[offset - 1], messageIds, nextCursor: messageIds.at(-1) ?? null, hasMore, limitReached: snapshot.acceptedIdOverflow && !hasMore };
        },
        free: () => undefined,
      };
    },
    MAX_SYNC_SELECTION_CHUNK_IDS: 4096,
    createWasmMissingIdSelector: (peerIds: string[]) => {
      const local = new Set<string>();
      return {
        observeLocalIds: (ids: string[]) => ids.forEach((id) => local.add(id)),
        finish: () => peerIds.filter((id) => !local.has(id)),
        free: () => undefined,
      };
    },
    planWasmMissingBatch: (missingIds: string[], offset: number) => {
      const ids = missingIds.slice(offset, offset + 100);
      const nextOffset = offset + ids.length;
      return { ids, nextOffset, hasMore: nextOffset < missingIds.length };
    },
    createWasmSyncInventoryReceiver: () => {
      const pages = new Map<string, string>();
      const ids: string[] = [];
      let expectedCursor: string | null = null;
      let identity = "";
      let complete = false;
      let limitReached = false;
      let freed = false;
      let missingIds: string[] | null = null;
      let nextMissingOffset = 0;
      return {
        acceptPage(packet: import("@nearlink/protocol").SyncInventoryPagePacket) {
          if (freed) wasmState.acceptAfterFree += 1;
          const pageKey = packet.cursor ?? "";
          const encoded = JSON.stringify(packet);
          const prior = pages.get(pageKey);
          if (prior !== undefined) {
            if (prior !== encoded) throw new Error("conflicting page");
            return { outcome: "duplicate" as const, ids: [...ids], complete, limitReached };
          }
          if (!protocol.isSyncInventoryPagePacket(packet) || complete || packet.cursor !== expectedCursor
            || (identity !== "" && identity !== `${packet.room}\u0000${packet.syncId}\u0000${packet.sender}`)
            || ids.length + packet.messageIds.length > 4096
            || packet.messageIds.some((id, index) => (index > 0 && packet.messageIds[index - 1] >= id) || (ids.length > 0 && index === 0 && ids.at(-1)! >= id))) {
            throw new Error("invalid page");
          }
          identity = `${packet.room}\u0000${packet.syncId}\u0000${packet.sender}`;
          pages.set(pageKey, encoded);
          ids.push(...packet.messageIds);
          complete = !packet.hasMore;
          expectedCursor = packet.hasMore ? packet.nextCursor : null;
          limitReached = complete && packet.limitReached;
          return { outcome: "accepted" as const, ids: [...ids], complete, limitReached };
        },
        setMissingIds(nextIds: string[]) { missingIds = [...nextIds]; nextMissingOffset = 0; },
        nextMissingBatch() {
          if (missingIds === null) throw new Error("missing plan unavailable");
          const batch = missingIds.slice(nextMissingOffset, nextMissingOffset + 100);
          nextMissingOffset += batch.length;
          return { ids: batch, hasMore: nextMissingOffset < missingIds.length };
        },
        hasMissingPlan: () => missingIds !== null,
        hasMissingIdsRemaining: () => missingIds !== null && nextMissingOffset < missingIds.length,
        free: () => { freed = true; wasmState.frees += 1; },
      };
    },
    createWasmSyncRequestBook: () => {
      const requests = new Map<string, { packet: import("@nearlink/protocol").SyncMissingRequestPacket; completion?: import("@nearlink/protocol").SyncPageCompletePacket; staged?: import("@nearlink/protocol").SyncPageCompletePacket; received: Map<string, MessagePacket> }>();
      let identity = "";
      return {
        registerRequest(packet: import("@nearlink/protocol").SyncMissingRequestPacket) {
          wasmState.registeredRequests.push(packet.requestId);
          if (!protocol.isSyncMissingRequestPacket(packet)) throw new Error("invalid request");
          const nextIdentity = `${packet.room}\u0000${packet.syncId}\u0000${packet.sender}\u0000${packet.targetSender}`;
          if (identity !== "" && identity !== nextIdentity) throw new Error("request identity changed");
          const existing = requests.get(packet.requestId);
          if (existing) {
            if (JSON.stringify(existing.packet) !== JSON.stringify(packet)) throw new Error("request conflict");
            return "duplicate" as const;
          }
          identity = nextIdentity;
          requests.set(packet.requestId, { packet, received: new Map() });
          return "accepted" as const;
        },
        acceptCompletion(packet: import("@nearlink/protocol").SyncPageCompletePacket) {
          if (!protocol.isSyncPageCompletePacket(packet)) throw new Error("invalid completion");
          const entry = requests.get(packet.requestId);
          if (!entry) throw new Error("unknown request");
          if (entry.completion) {
            if (JSON.stringify(entry.completion) !== JSON.stringify(packet)) throw new Error("completion conflict");
            return "duplicate" as const;
          }
          if (packet.room !== entry.packet.room || packet.syncId !== entry.packet.syncId || packet.sender !== entry.packet.targetSender || packet.targetSender !== entry.packet.sender
            || packet.messageIds.some((id) => !entry.packet.messageIds.includes(id))) throw new Error("completion mismatch");
          entry.completion = packet;
          return "accepted" as const;
        },
        observeMessage(packet: MessagePacket) {
          let matched = false;
          for (const entry of requests.values()) {
            if (entry.completion || packet.room !== entry.packet.room || packet.sender !== entry.packet.targetSender || !entry.packet.messageIds.includes(packet.id)) continue;
            if (entry.staged && !entry.staged.messageIds.includes(packet.id)) throw new Error("message arrived outside staged completion");
            const prior = entry.received.get(packet.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(packet)) throw new Error("message conflict");
            matched = true;
            entry.received.set(packet.id, packet);
          }
          return matched ? "matched" as const : "unmatched" as const;
        },
        hasOutstandingMessageId(id: string) {
          return [...requests.values()].some((entry) => !entry.completion && entry.packet.messageIds.includes(id));
        },
        stageCompletion(packet: import("@nearlink/protocol").SyncPageCompletePacket) {
          const entry = requests.get(packet.requestId);
          if (!entry) return { outcome: "unknown" as const, requestedIds: [], observedIds: [], completedIds: [], isCompleted: false };
          const stagedPrior = entry.staged;
          const committedPrior = entry.completion;
          const outcome = stagedPrior || committedPrior ? "duplicate" as const : "accepted" as const;
          if ((stagedPrior && JSON.stringify(stagedPrior) !== JSON.stringify(packet)) || (committedPrior && JSON.stringify(committedPrior) !== JSON.stringify(packet))) throw new Error("completion conflict");
          if (!stagedPrior && !committedPrior) {
            if (packet.room !== entry.packet.room || packet.syncId !== entry.packet.syncId || packet.sender !== entry.packet.targetSender || packet.targetSender !== entry.packet.sender
              || packet.messageIds.some((id) => !entry.packet.messageIds.includes(id))
              || [...entry.received.keys()].some((id) => !packet.messageIds.includes(id))) throw new Error("completion mismatch");
            entry.staged = packet;
          }
          return { outcome, requestedIds: [...entry.packet.messageIds], observedIds: [...entry.received.keys()].sort(), completedIds: [...packet.messageIds], isCompleted: Boolean(committedPrior) };
        },
        finishCompletion(requestId: string, durable: boolean) {
          const entry = requests.get(requestId);
          if (!entry?.staged) throw new Error("missing staged completion");
          if (durable) {
            entry.completion = entry.staged;
            entry.received.clear();
          }
          entry.staged = undefined;
        },
        verifyDurableMessages(requestId: string, packets: MessagePacket[]) {
          const entry = requests.get(requestId);
          if (!entry || entry.received.size !== packets.length) return false;
          const byId = new Map(packets.map((packet) => [packet.id, packet]));
          return [...entry.received].every(([id, packet]) => JSON.stringify(byId.get(id)) === JSON.stringify(packet));
        },
        free: () => { wasmState.frees += 1; },
      };
    },
  };
});

const room = "sync-room";

function packet(id: string, sender: string, body = id): MessagePacket {
  return { version: 1, type: "message", id, room, sender, senderName: sender, createdAt: "2026-10-14T09:00:00.000Z", body };
}

function stored(id: string, sender: string, delivery: "sent" | "queued" | "failed" = "sent"): StoredMessage {
  return { packet: packet(id, sender), direction: sender === "local-a" ? "outgoing" : "incoming", delivery, transport: "hub" };
}

function boundedStorage(load: () => Promise<StoredMessage[]>) {
  return {
    loadAcceptedMessageIds: async () => {
      const rows = await load();
      const allIds = [...new Set(rows.filter((row) => row.packet.room === room && row.delivery === "sent" && row.failure === undefined).map((row) => row.packet.id))].sort();
      return { version: 1 as const, room, ids: allIds.slice(0, 4096), scanComplete: true, acceptedIdOverflow: allIds.length > 4096 };
    },
    loadRequestedMessages: async (ids: string[]) => (await load()).filter((row) => ids.includes(row.packet.id)
      && row.packet.room === room && row.delivery === "sent" && row.failure === undefined),
  };
}

function uncompletedInventoryPages(sender: string, sessionCount = 5, pagesPerSession = 39): SyncPacket[] {
  const packets: SyncPacket[] = [];
  for (let session = 0; session < sessionCount; session += 1) {
    const syncId = `peer-${session}`;
    for (let index = 0; index < pagesPerSession; index += 1) {
      const id = `${syncId}-${String(index).padStart(3, "0")}`;
      packets.push({
        version: 1,
        type: "sync_inventory_page",
        room,
        syncId,
        sender,
        cursor: index === 0 ? null : `${syncId}-${String(index - 1).padStart(3, "0")}`,
        messageIds: [id],
        nextCursor: id,
        hasMore: true,
        limitReached: false,
      });
    }
  }
  return packets;
}

describe("SyncCoordinator", () => {
  beforeEach(async () => {
    expect(await initializeWasmProtocol()).toBe(true);
    wasmState.ready = true;
    wasmState.frees = 0;
    wasmState.acceptAfterFree = 0;
    wasmState.registeredRequests = [];
  });

  it("fails closed when the WASM synchronization state is unavailable", async () => {
    wasmState.ready = false;
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local", send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    expect(state).toBe("error");
    expect(sent).toEqual([]);
    coordinator.stop();
  });

  it("releases a blocked sender inventory and request state", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "peer-session", sender: "local-b", cursor: null, messageIds: [], nextCursor: null, hasMore: false, limitReached: false });
    for (let index = 0; index < 193; index += 1) {
      await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: `blocked-${index}`, sender: "local-b", targetSender: "local-a", messageIds: ["saved"] });
    }
    expect(state).toBe("partial");
    expect(wasmState.frees).toBe(2);
    coordinator.stop();
  });

  it("bounds blocked sender identities and stops cleanly when the cap is full", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ sender: "local-a", room, makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state = next; } });
    const internal = coordinator as unknown as { stopped: boolean; blockedSenders: Set<string>; remote: Map<string, unknown>; wasmRequestBooks: Map<string, unknown> };
    await coordinator.start();

    for (let peer = 0; peer < 16; peer += 1) {
      const sender = `blocked-peer-${peer}`;
      for (let index = 0; index < 193; index += 1) {
        await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: `blocked-${peer}-${index}`, sender, targetSender: "local-a", messageIds: ["saved"] });
      }
    }
    expect(internal.blockedSenders.size).toBe(16);
    expect(state).toBe("partial");

    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "overflow-session", sender: "overflow-peer", cursor: null, messageIds: [], nextCursor: null, hasMore: false, limitReached: false });
    expect(internal.remote.size).toBe(1);
    const freesBeforeOverflow = wasmState.frees;
    for (let index = 0; index < 193; index += 1) {
      await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: `overflow-${index}`, sender: "overflow-peer", targetSender: "local-a", messageIds: ["saved"] });
    }

    expect(state).toBe("partial");
    expect(internal.stopped).toBe(true);
    expect(internal.blockedSenders.size).toBe(0);
    expect(internal.remote.size).toBe(0);
    expect(internal.wasmRequestBooks.size).toBe(0);
    expect(wasmState.frees).toBeGreaterThan(freesBeforeOverflow);
    const requestCountAtStop = wasmState.registeredRequests.length;
    for (let peer = 0; peer < 32; peer += 1) {
      await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: `after-stop-${peer}`, sender: `after-stop-peer-${peer}`, targetSender: "local-a", messageIds: ["saved"] });
    }
    expect(wasmState.registeredRequests).toHaveLength(requestCountAtStop);
    expect(internal.blockedSenders.size).toBe(0);
    expect(internal.remote.size).toBe(0);
    expect(internal.wasmRequestBooks.size).toBe(0);
  });

  it("abandons a response when its sender is blocked during storage loading", async () => {
    const rows = [stored("saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let loads = 0;
    let releaseResponse!: (value: StoredMessage[]) => void;
    const responseSnapshot = new Promise<StoredMessage[]>((resolve) => { releaseResponse = resolve; });
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => "local-session",
      send: (value) => sent.push(value),
      ...boundedStorage(() => { loads += 1; return loads === 1 ? Promise.resolve(rows) : responseSnapshot; }),
      validateMessage: () => true,
      onState: (next) => { state = next; },
    });
    await coordinator.start();
    const response = coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "pending-response", sender: "local-b", targetSender: "local-a", messageIds: ["saved"] });
    await vi.waitFor(() => expect(loads).toBe(2));
    for (const page of uncompletedInventoryPages("local-b")) await coordinator.receive(page);
    releaseResponse(rows);
    await response;
    expect(state).toBe("partial");
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "pending-response")).toBe(false);
    expect(sent.some((value) => value.type === "message" && value.id === "saved")).toBe(false);
    coordinator.stop();
  });

  it("cancels a paced response when its sender is blocked", async () => {
    const rows = [stored("alpha", "local-a"), stored("bravo", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, messageIntervalMs: 10_000, onState: (next) => { state = next; } });
    await coordinator.start();
    const response = coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "paced-response", sender: "local-b", targetSender: "local-a", messageIds: ["alpha", "bravo"] });
    await vi.waitFor(() => expect(sent.some((value) => value.type === "message" && value.id === "alpha")).toBe(true));
    for (const page of uncompletedInventoryPages("local-b")) await coordinator.receive(page);
    await response;
    expect(state).toBe("partial");
    expect(sent.filter((value) => value.type === "message")).toHaveLength(1);
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "paced-response")).toBe(false);
    coordinator.stop();
  });

  it("reuses the frozen local inventory without re-reading IndexedDB for peer comparisons", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let loads = 0;
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => "local-session",
      send: (value) => sent.push(value),
      ...boundedStorage(async () => { loads += 1; return []; }),
      validateMessage: () => true,
    });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "initial-peer", sender: "local-b", cursor: null, messageIds: ["missing"], nextCursor: "missing", hasMore: false, limitReached: false });
    expect(loads).toBe(1);
    expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true);
    coordinator.stop();
  });

  it("discards exchange state on stop and creates fresh state after restart", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let sequence = 0;
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => `local-${++sequence}`, send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true });
    const remoteInventory: SyncPacket = { version: 1, type: "sync_inventory_page", room, syncId: "remote-session", sender: "local-b", cursor: null, messageIds: ["remote-message"], nextCursor: "remote-message", hasMore: false, limitReached: false };
    await coordinator.start();
    await coordinator.receive(remoteInventory);
    await vi.waitFor(() => expect(sent.filter((value) => value.type === "sync_missing_request")).toHaveLength(1));
    coordinator.stop();
    expect(wasmState.frees).toBe(2);

    await coordinator.start();
    await coordinator.receive(remoteInventory);
    await vi.waitFor(() => expect(sent.filter((value) => value.type === "sync_missing_request")).toHaveLength(2));
    expect([...new Set(sent.filter((value) => value.type === "sync_inventory_page").map((value) => value.type === "sync_inventory_page" ? value.syncId : ""))]).toEqual(["local-1", "local-3"]);
    coordinator.stop();
  });

  it("ignores an old storage snapshot that resolves after stop and restart", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    const pending: Array<(rows: StoredMessage[]) => void> = [];
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: (() => { let id = 0; return () => `epoch-${++id}`; })(),
      send: (value) => sent.push(value),
      ...boundedStorage(() => new Promise<StoredMessage[]>((resolve) => { pending.push(resolve); })),
      validateMessage: () => true,
    });
    const staleStart = coordinator.start();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    coordinator.stop();
    const currentStart = coordinator.start();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]([stored("current-snapshot", "local-a")]);
    await currentStart;
    pending[0]([stored("stale-snapshot", "local-a")]);
    await staleStart;

    const inventories = sent.filter((value) => value.type === "sync_inventory_page");
    expect(inventories).toHaveLength(1);
    expect(inventories[0]).toMatchObject({ syncId: "epoch-1", messageIds: ["current-snapshot"] });
    coordinator.stop();
  });

  it("exchanges only accepted messages and verifies transferred packets after durable storage", async () => {
    const aRows = [stored("only-a", "local-a"), stored("queued-a", "local-a", "queued")];
    const bRows = [stored("only-b", "local-b")];
    const queue: Array<{ target: "a" | "b"; packet: SyncPacket | MessagePacket }> = [];
    let a!: SyncCoordinator;
    let b!: SyncCoordinator;
    const states: SyncState[] = [];
    a = new SyncCoordinator({ room, sender: "local-a", makeId: (() => { let id = 0; return () => `a-${++id}`; })(), send: (value) => queue.push({ target: "b", packet: value }), ...boundedStorage(async () => aRows), validateMessage: () => true, onState: (state) => states.push(state) });
    b = new SyncCoordinator({ room, sender: "local-b", makeId: (() => { let id = 0; return () => `b-${++id}`; })(), send: (value) => queue.push({ target: "a", packet: value }), ...boundedStorage(async () => bRows), validateMessage: () => true });

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

  it("waits for interleaved multi-page peer plans before reporting complete", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    const states: SyncState[] = [];
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: (() => { let id = 0; return () => `coverage-${++id}`; })(),
      send: (value) => sent.push(value),
      ...boundedStorage(async () => []),
      validateMessage: () => true,
      onState: (state) => states.push(state),
    });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "streaming-peer", sender: "local-c", cursor: null, messageIds: ["alpha"], nextCursor: "alpha", hasMore: true, limitReached: false });
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "empty-peer", sender: "local-b", cursor: null, messageIds: [], nextCursor: null, hasMore: false, limitReached: false });
    expect(states).not.toContain("complete");
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "streaming-peer", sender: "local-c", cursor: "alpha", messageIds: ["missing"], nextCursor: "missing", hasMore: false, limitReached: false });
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true));

    expect(states).not.toContain("complete");
    const request = sent.find((value): value is Extract<SyncPacket, { type: "sync_missing_request" }> => value.type === "sync_missing_request");
    expect(request).toBeDefined();
    await coordinator.receive({ version: 1, type: "sync_page_complete", room, syncId: request!.syncId, requestId: request!.requestId, sender: "local-c", targetSender: "local-a", messageIds: [] });
    expect(states).toContain("partial");
    expect(states).not.toContain("complete");
    coordinator.stop();
  });

  it("caps a frozen inventory at 4,096 IDs and marks its final page partial", async () => {
    const rows = Array.from({ length: 4097 }, (_, index) => stored(`id-${String(index).padStart(4, "0")}`, "local-a"));
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    const pages = sent.filter((value) => value.type === "sync_inventory_page");
    expect(pages).toHaveLength(41);
    expect(pages.reduce((total, value) => total + (value.type === "sync_inventory_page" ? value.messageIds.length : 0), 0)).toBe(4096);
    expect(pages.at(-1)).toMatchObject({ hasMore: false, limitReached: true });
    expect(state).toBe("partial");
    coordinator.stop();
  });

  it("fails before publishing when the row scan is incomplete without proven ID overflow", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => "truncated-session",
      send: (value) => sent.push(value),
      loadAcceptedMessageIds: async () => ({ version: 1, room, ids: [], scanComplete: false, acceptedIdOverflow: false }),
      loadRequestedMessages: async () => [],
      validateMessage: () => true,
      onState: (next) => { state = next; },
    });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: [], nextCursor: null, hasMore: false, limitReached: false });
    expect(state).toBe("error");
    expect(sent.some((item) => item.type === "sync_inventory_page")).toBe(false);
    expect(sent.some((item) => item.type === "sync_page_complete")).toBe(false);
    coordinator.stop();
  });

  it("fails storage reads without sending completion or claiming a complete exchange", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => "storage-failure-session",
      send: (value) => sent.push(value),
      loadAcceptedMessageIds: async () => ({ version: 1, room, ids: [], scanComplete: true, acceptedIdOverflow: false }),
      loadRequestedMessages: async () => { throw new Error("storage unavailable"); },
      validateMessage: () => true,
      onState: (next) => { state = next; },
    });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_missing_request", room, syncId: "storage-failure-session", requestId: "failed-request", sender: "local-b", targetSender: "local-a", messageIds: ["wanted"] });
    expect(state).toBe("error");
    expect(sent.some((item) => item.type === "sync_page_complete")).toBe(false);
    coordinator.stop();
  });

  it("compares peer inventories against local history larger than the inventory bound", async () => {
    const rows = Array.from({ length: 4097 }, (_, index) => stored(`local-${String(index).padStart(4, "0")}`, "local-a"));
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    let detail = "";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "request", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, onState: (next, message) => { state = next; detail = message; } });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: ["local-4096", "remote-missing"], nextCursor: "remote-missing", hasMore: false, limitReached: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state, detail).not.toBe("error");
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true));
    expect(sent.find((value) => value.type === "sync_missing_request")).toMatchObject({ messageIds: ["local-4096", "remote-missing"] });
    expect(state).toBe("partial");
    coordinator.stop();
  });

  it("stops when a sender changes a previously received inventory page", async () => {
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local", send: () => undefined, ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state = next; } });
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
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "request", send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state = next; } });
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
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => snapshot), validateMessage: () => true });
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
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true });
    await coordinator.start();
    const request: SyncPacket = { version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "duplicate-request", sender: "local-b", targetSender: "local-a", messageIds: ["local-saved"] };
    await coordinator.receive(request);
    await coordinator.receive(request);
    expect(sent.filter((value) => value.type === "message" && value.id === "local-saved")).toHaveLength(1);
    expect(sent.filter((value) => value.type === "sync_page_complete" && value.requestId === "duplicate-request")).toHaveLength(1);
    expect(wasmState.registeredRequests.filter((id) => id === "duplicate-request")).toHaveLength(2);
    coordinator.stop();
  });

  it("routes a conflicting reused request ID through WASM before TypeScript dedupe", async () => {
    const rows = [stored("local-saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    const request: SyncPacket = { version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "reused-request", sender: "local-b", targetSender: "local-a", messageIds: ["local-saved"] };
    await coordinator.receive(request);
    await coordinator.receive({ ...request, messageIds: ["different-message"] });
    expect(wasmState.registeredRequests.filter((id) => id === "reused-request")).toHaveLength(2);
    expect(state).toBe("error");
    expect(sent.filter((value) => value.type === "sync_page_complete" && value.requestId === "reused-request")).toHaveLength(1);
    coordinator.stop();
  });

  it("isolates equal request IDs from unrelated peers", async () => {
    const rows = [stored("shared-message", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, onState: (next) => { state = next; } });
    await coordinator.start();
    const request = (sender: string): SyncPacket => ({ version: 1, type: "sync_missing_request", room, syncId: "local-session", requestId: "same-opaque-id", sender, targetSender: "local-a", messageIds: ["shared-message"] });
    await coordinator.receive(request("local-b"));
    await coordinator.receive(request("local-c"));
    expect(sent.filter((value) => value.type === "sync_page_complete" && value.requestId === "same-opaque-id").map((value) => value.type === "sync_page_complete" ? value.targetSender : "")).toEqual(["local-b", "local-c"]);
    expect(state).not.toBe("error");
    coordinator.stop();
  });

  it("does not use an inventory receiver after rebroadcast stops the coordinator", async () => {
    let advertCount = 0;
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => "local-session",
      send: (value) => {
        if (value.type !== "sync_inventory_page") return;
        advertCount += 1;
        if (advertCount === 2) throw new Error("Simulated transport send failure.");
      },
      ...boundedStorage(async () => []),
      validateMessage: () => true,
      onState: (next) => { state = next; },
    });
    await coordinator.start();
    await coordinator.receive({ version: 1, type: "sync_inventory_page", room, syncId: "remote", sender: "local-b", cursor: null, messageIds: ["alpha"], nextCursor: "alpha", hasMore: false, limitReached: false });
    expect(state).toBe("error");
    expect(wasmState.acceptAfterFree).toBe(0);
    expect(wasmState.frees).toBe(1);
    coordinator.stop();
  });

  it("ignores broadcast requests addressed to other room members before retaining controls", async () => {
    const rows = [stored("local-saved", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, onState: (next) => { state = next; } });
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
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "request", send: (value) => sent.push(value), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next, message) => { state = next; detail = message; } });
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

  it("frees exchange state on stop and prevents stale async completion from reviving after restart", async () => {
    const sent: Array<SyncPacket | MessagePacket> = [];
    let requestId = 0;
    let releaseDurableCheck!: (rows: StoredMessage[]) => void;
    const pendingDurableCheck = new Promise<StoredMessage[]>((resolve) => { releaseDurableCheck = resolve; });
    let durableLoads = 0;
    let state: SyncState = "idle";
    const coordinator = new SyncCoordinator({
      room,
      sender: "local-a",
      makeId: () => `lifecycle-${++requestId}`,
      send: (value) => sent.push(value),
      ...boundedStorage(async () => []),
      loadRequestedMessages: async (ids: string[]) => {
        if (ids.length > 0) {
          durableLoads += 1;
          return pendingDurableCheck;
        }
        return [];
      },
      validateMessage: () => true,
      onState: (next) => { state = next; },
    });
    await coordinator.start();
    const remote: SyncPacket = { version: 1, type: "sync_inventory_page", room, syncId: "remote-life", sender: "local-b", cursor: null, messageIds: ["pending"], nextCursor: "pending", hasMore: false, limitReached: false };
    await coordinator.receive(remote);
    await vi.waitFor(() => expect(sent.some((value) => value.type === "sync_missing_request")).toBe(true));
    const request = sent.find((value): value is Extract<SyncPacket, { type: "sync_missing_request" }> => value.type === "sync_missing_request")!;
    coordinator.observeAcceptedMessage(packet("pending", "local-b"));
    const completing = coordinator.receive({ version: 1, type: "sync_page_complete", room, syncId: request.syncId, requestId: request.requestId, sender: "local-b", targetSender: "local-a", messageIds: ["pending"] });
    await vi.waitFor(() => expect(durableLoads).toBe(1));
    const freedBeforeRestart = wasmState.frees;
    coordinator.stop();
    expect(wasmState.frees).toBeGreaterThan(freedBeforeRestart);
    await coordinator.start();
    const freshSentCount = sent.length;
    releaseDurableCheck([stored("pending", "local-b")]);
    await completing;
    await Promise.resolve();
    expect(state).toBe("syncing");
    expect(sent.slice(freshSentCount).some((value) => value.type === "sync_missing_request" || value.type === "sync_page_complete")).toBe(false);
    coordinator.stop();
  });

  it("cancels a paced hub response timer when the coordinator stops", async () => {
    const rows = [stored("alpha", "local-a"), stored("bravo", "local-a")];
    const sent: Array<SyncPacket | MessagePacket> = [];
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => "local-session", send: (value) => sent.push(value), ...boundedStorage(async () => rows), validateMessage: () => true, messageIntervalMs: 1000 });
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
    }, ...boundedStorage(async () => rows), validateMessage: () => true, messageIntervalMs: 700 });
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
    const a = new SyncCoordinator({ room, sender: "local-a", makeId: () => "a-session", send: (value) => toB.push(value), ...boundedStorage(async () => aRows), validateMessage: () => true, rebroadcastOnPeerInventory: true });
    await a.start();
    toB.length = 0; // The peer had not confirmed its direct session and ignored the first advertisement.
    const b = new SyncCoordinator({ room, sender: "local-b", makeId: () => "b-session", send: (value) => toA.push(value), ...boundedStorage(async () => bRows), validateMessage: () => true });
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
    const coordinator = new SyncCoordinator({ room, sender: "local-a", makeId: () => `request-${sent.length}`, send: (packet) => sent.push(packet), ...boundedStorage(async () => []), validateMessage: () => true, onState: (next) => { state.value = next; } });
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
