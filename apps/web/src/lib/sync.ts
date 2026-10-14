import {
  MAX_SYNC_INVENTORY_IDS,
  MAX_SYNC_PACKET_IDS,
  PROTOCOL_VERSION,
  isSyncInventoryPagePacket,
  isSyncMissingRequestPacket,
  isSyncPageCompletePacket,
  type MessagePacket,
  type SyncInventoryPagePacket,
  type SyncMissingRequestPacket,
  type SyncPacket,
  type SyncPageCompletePacket,
} from "@nearlink/protocol";
import {
  createWasmSyncInventoryReceiver,
  createWasmSyncRequestBook,
  isWasmSyncStateReady,
  planWasmMissingBatch,
  createWasmMissingIdSelector,
  MAX_SYNC_SELECTION_CHUNK_IDS,
  type SyncInventoryState,
  type SyncRequestState,
} from "./wasmProtocol";
import type { StoredMessage } from "./storage";

export type SyncState = "idle" | "syncing" | "partial" | "complete" | "error";

export interface SyncCoordinatorOptions {
  room: string;
  sender: string;
  makeId: () => string;
  send: (packet: SyncPacket | MessagePacket) => void;
  loadAccepted: () => Promise<StoredMessage[]>;
  validateMessage: (packet: MessagePacket) => boolean;
  rebroadcastOnPeerInventory?: boolean;
  messageIntervalMs?: number;
  onState?: (state: SyncState, detail: string) => void;
}

interface InventorySession {
  sender: string;
  syncId: string;
  ids: string[];
  nextCursor: string | null;
  done: boolean;
  limitReached: boolean;
  missingIds: string[];
  nextRequestOffset: number;
  activeRequestId: string | null;
  inventoryState: SyncInventoryState;
}

interface PendingRequest {
  sender: string;
  syncId: string;
  ids: string[];
  received: Map<string, MessagePacket>;
  completion?: SyncPageCompletePacket;
}

interface SenderControlBudget {
  bytes: number;
  count: number;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function key(sender: string, syncId: string): string {
  return `${sender}\u0000${syncId}`;
}

function handledRequestKey(sender: string, syncId: string, requestId: string): string {
  return `${sender}\u0000${syncId}\u0000${requestId}`;
}

export class SyncCoordinator {
  private readonly options: SyncCoordinatorOptions;
  private stopped = true;
  private localSyncId = "";
  private localIds = new Set<string>();
  private remote = new Map<string, InventorySession>();
  private requests = new Map<string, PendingRequest>();
  private wasmInventoryReceivers = new Set<SyncInventoryState>();
  private wasmRequestBooks = new Map<string, SyncRequestState>();
  private handledRequests = new Map<string, SyncMissingRequestPacket>();
  private retainedControlBytes = 0;
  private retainedControlCount = 0;
  private senderControlBudgets = new Map<string, SenderControlBudget>();
  private blockedSenders = new Set<string>();
  private failed = false;
  private partial = false;
  private inventoryRebroadcast = false;
  private inventoryRebroadcastPending = false;
  private localLimitReached = false;
  private nextMessageAt = 0;
  private messageSendQueue: Promise<void> = Promise.resolve();
  private pendingMessageWait: { timer: ReturnType<typeof setTimeout>; resolve: () => void; recipient: string } | null = null;
  private epoch = 0;
  private messageSendBlocked = false;
  private localSnapshotReady: Promise<void> = Promise.resolve();
  private resolveLocalSnapshotReady: (() => void) | null = null;

  constructor(options: SyncCoordinatorOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.reset();
    this.stopped = false;
    const startEpoch = this.epoch;
    this.localSnapshotReady = new Promise<void>((resolve) => { this.resolveLocalSnapshotReady = resolve; });
    this.options.onState?.("syncing", "Exchanging bounded local message inventories.");
    try {
      if (!isWasmSyncStateReady()) throw new Error("WASM synchronization state is unavailable.");
      const stored = await this.options.loadAccepted();
      if (!this.isRunActive(startEpoch)) return;
      const accepted = stored.filter((item) => item.packet.room === this.options.room
        && item.delivery === "sent"
        && item.failure === undefined
        && this.options.validateMessage(item.packet));
      const allIds = [...new Set(accepted.map((item) => item.packet.id))].sort();
      const limitReached = allIds.length > MAX_SYNC_INVENTORY_IDS;
      const ids = allIds.slice(0, MAX_SYNC_INVENTORY_IDS);
      this.localLimitReached = limitReached;
      this.localIds = new Set(ids);
      this.localSyncId = this.options.makeId();
      this.publishInventory();
      if (this.inventoryRebroadcastPending) this.rebroadcastInventoryOnce();
      this.markLocalSnapshotReady();
      if (limitReached) {
        this.partial = true;
        this.options.onState?.("partial", "The local inventory exceeded 4,096 IDs. This exchange can only report partial synchronization.");
      }
    } catch {
      if (this.isRunActive(startEpoch)) this.fail("Local storage could not provide an accepted-message snapshot. Reconnect to restart synchronization.");
    }
  }

  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.markLocalSnapshotReady();
    this.remote.clear();
    this.requests.clear();
    for (const receiver of this.wasmInventoryReceivers) receiver.free();
    this.wasmInventoryReceivers.clear();
    for (const book of this.wasmRequestBooks.values()) book.free();
    this.wasmRequestBooks.clear();
    this.handledRequests.clear();
    this.retainedControlBytes = 0;
    this.retainedControlCount = 0;
    this.senderControlBudgets.clear();
    this.blockedSenders.clear();
    this.localIds.clear();
    this.localSyncId = "";
    this.inventoryRebroadcast = false;
    this.inventoryRebroadcastPending = false;
    this.localLimitReached = false;
    this.nextMessageAt = 0;
    if (this.pendingMessageWait) {
      clearTimeout(this.pendingMessageWait.timer);
      this.pendingMessageWait.resolve();
      this.pendingMessageWait = null;
    }
    this.messageSendQueue = Promise.resolve();
    this.messageSendBlocked = false;
  }

  /** Call after normal message validation and successful durable storage. */
  observeAcceptedMessage(packet: MessagePacket): void {
    if (this.stopped || this.failed || packet.room !== this.options.room) return;
    for (const request of this.requests.values()) {
      if (request.completion || !request.ids.includes(packet.id)) continue;
      const prior = request.received.get(packet.id);
      if (prior && !sameJson(prior, packet)) {
        this.fail("Conflicting content arrived for a requested message ID. Reconnect to start a fresh exchange.");
        return;
      }
      request.received.set(packet.id, packet);
    }
  }

  rejectMessage(packet: MessagePacket, detail: string): void {
    if (this.stopped || this.failed || packet.room !== this.options.room) return;
    this.rejectMessageId(packet.room, packet.id, detail);
  }

  rejectMessageId(room: string, id: string, detail: string): void {
    if (this.stopped || this.failed || room !== this.options.room) return;
    if ([...this.requests.values()].some((request) => !request.completion && request.ids.includes(id))) this.fail(detail);
  }

  abort(detail: string): void {
    if (this.stopped || this.failed) return;
    this.fail(detail);
  }

  notePartial(detail: string): void {
    if (this.stopped || this.failed) return;
    this.partial = true;
    this.options.onState?.("partial", detail);
  }

  noteMessageRateLimited(detail: string): void {
    if (this.stopped || this.failed) return;
    this.messageSendBlocked = true;
    if (this.pendingMessageWait) {
      clearTimeout(this.pendingMessageWait.timer);
      this.pendingMessageWait.resolve();
      this.pendingMessageWait = null;
    }
    this.notePartial(detail);
  }

  noteControlRateLimited(detail: string): void {
    if (this.stopped || this.failed) return;
    this.partial = true;
    this.stop();
    this.options.onState?.("partial", detail);
  }

  async receive(packet: SyncPacket): Promise<void> {
    if (this.stopped || this.failed || packet.room !== this.options.room || packet.sender === this.options.sender || this.blockedSenders.has(packet.sender)) return;
    if (packet.type === "sync_inventory_page") {
      if (!isSyncInventoryPagePacket(packet)) return this.fail("A peer sent an invalid inventory page. Reconnect to start over.");
      this.acceptInventory(packet);
    } else if (packet.type === "sync_missing_request") {
      if (!isSyncMissingRequestPacket(packet)) return this.fail("A peer sent an invalid missing-message request. Reconnect to start over.");
      const receiveEpoch = this.epoch;
      await this.localSnapshotReady;
      if (!this.isRunActive(receiveEpoch) || !this.localSyncId || packet.targetSender !== this.options.sender || packet.syncId !== this.localSyncId) return;
      const bookKey = `in:${key(packet.sender, packet.syncId)}`;
      let book = this.wasmRequestBooks.get(bookKey);
      const newBook = !book;
      if (newBook && !this.retainControl(packet)) return;
      try {
        if (!book) {
          book = createWasmSyncRequestBook();
          this.wasmRequestBooks.set(bookKey, book);
        }
        const outcome = book.registerRequest(packet);
        if (outcome === "duplicate") return;
      } catch {
        this.fail("WASM could not verify synchronization request state. Reconnect to start over.");
        return;
      }
      const requestKey = handledRequestKey(packet.sender, packet.syncId, packet.requestId);
      const prior = this.handledRequests.get(requestKey);
      if (prior) {
        if (!sameJson(prior, packet)) this.fail("A request ID was reused with different contents. Reconnect to start over.");
        return;
      }
      if (!newBook && !this.retainControl(packet)) return;
      this.handledRequests.set(requestKey, packet);
      await this.respond(packet, receiveEpoch);
    } else if (packet.type === "sync_page_complete") {
      if (!isSyncPageCompletePacket(packet)) return this.fail("A peer sent an invalid synchronization completion. Reconnect to start over.");
      const receiveEpoch = this.epoch;
      await this.localSnapshotReady;
      if (!this.isRunActive(receiveEpoch)) return;
      await this.complete(packet);
    }
  }

  private retainControl(packet: SyncPacket): boolean {
    let bytes: number;
    try { bytes = new TextEncoder().encode(JSON.stringify(packet)).byteLength; }
    catch { this.fail("A synchronization control packet could not be measured. Reconnect to start over."); return false; }
    const budget = this.senderControlBudgets.get(packet.sender) ?? { bytes: 0, count: 0 };
    if (budget.count >= 192 || budget.bytes + bytes > 2 * 1024 * 1024 || this.retainedControlCount >= 8192 || this.retainedControlBytes + bytes > 2 * 1024 * 1024) {
      this.blockSender(packet.sender);
      return false;
    }
    budget.bytes += bytes;
    budget.count += 1;
    this.senderControlBudgets.set(packet.sender, budget);
    this.retainedControlCount += 1;
    this.retainedControlBytes += bytes;
    return true;
  }

  private blockSender(sender: string): void {
    if (this.blockedSenders.has(sender)) return;
    this.blockedSenders.add(sender);
    this.partial = true;
    const budget = this.senderControlBudgets.get(sender);
    if (budget) {
      this.retainedControlBytes -= budget.bytes;
      this.retainedControlCount -= budget.count;
      this.senderControlBudgets.delete(sender);
    }
    for (const [sessionKey, session] of this.remote) {
      if (session.sender !== sender) continue;
      session.inventoryState.free();
      this.wasmInventoryReceivers.delete(session.inventoryState);
      this.remote.delete(sessionKey);
    }
    for (const [bookKey, book] of this.wasmRequestBooks) {
      if (!bookKey.startsWith(`in:${sender}\u0000`) && !bookKey.startsWith(`out:${sender}\u0000`)) continue;
      book.free();
      this.wasmRequestBooks.delete(bookKey);
    }
    for (const [requestId, request] of this.requests) if (request.sender === sender) this.requests.delete(requestId);
    for (const [requestId, request] of this.handledRequests) if (request.sender === sender) this.handledRequests.delete(requestId);
    if (this.pendingMessageWait?.recipient === sender) {
      clearTimeout(this.pendingMessageWait.timer);
      this.pendingMessageWait.resolve();
      this.pendingMessageWait = null;
    }
    this.options.onState?.("partial", "A peer exceeded the bounded synchronization control budget. That peer is incomplete; reconnect to retry from saved messages while other peer exchanges may continue.");
  }

  private acceptInventory(packet: SyncInventoryPagePacket): void {
    const inventoryEpoch = this.epoch;
    const sessionKey = key(packet.sender, packet.syncId);
    let session = this.remote.get(sessionKey);
    if (!session) {
      if (this.remote.size >= 32) return this.fail("Too many peer inventory sessions arrived. Reconnect to start over.");
      let inventoryState: SyncInventoryState;
      try {
        inventoryState = createWasmSyncInventoryReceiver();
      } catch {
        return this.fail("WASM could not start synchronization inventory state. Reconnect to retry.");
      }
      this.wasmInventoryReceivers.add(inventoryState);
      session = { sender: packet.sender, syncId: packet.syncId, ids: [], nextCursor: null, done: false, limitReached: false, missingIds: [], nextRequestOffset: 0, activeRequestId: null, inventoryState };
      this.remote.set(sessionKey, session);
      if (this.options.rebroadcastOnPeerInventory !== false) {
        if (this.localSyncId) this.rebroadcastInventoryOnce();
        else this.inventoryRebroadcastPending = true;
      }
      if (!this.isRunActive(inventoryEpoch)) return;
    }
    let accepted: ReturnType<SyncInventoryState["acceptPage"]>;
    try {
      accepted = session.inventoryState.acceptPage(packet);
    } catch {
      this.fail("A peer sent an invalid or conflicting inventory sequence. Reconnect to start over.");
      return;
    }
    if (accepted.outcome === "duplicate") return;
    if (!this.retainControl(packet)) return;
    session.ids = accepted.ids;
    session.nextCursor = packet.nextCursor;
    session.done = accepted.complete;
    session.limitReached = accepted.limitReached;
    if (packet.limitReached) this.partial = true;
    if (!session.done) return;
    void this.requestMissing(session);
  }

  private publishInventory(): void {
    if (this.stopped || !this.localSyncId) return;
    const ids = [...this.localIds];
    for (let offset = 0; offset < ids.length || offset === 0; offset += MAX_SYNC_PACKET_IDS) {
      const messageIds = ids.slice(offset, offset + MAX_SYNC_PACKET_IDS);
      const hasMore = offset + messageIds.length < ids.length;
      const packet: SyncInventoryPagePacket = {
        version: PROTOCOL_VERSION,
        type: "sync_inventory_page",
        room: this.options.room,
        syncId: this.localSyncId,
        sender: this.options.sender,
        cursor: offset === 0 ? null : ids[offset - 1],
        messageIds,
        nextCursor: messageIds.at(-1) ?? null,
        hasMore,
        limitReached: this.localLimitReached && !hasMore,
      };
      this.options.send(packet);
      if (!hasMore) break;
    }
  }

  private rebroadcastInventoryOnce(): void {
    if (this.inventoryRebroadcast || this.stopped || !this.localSyncId) return;
    this.inventoryRebroadcast = true;
    this.inventoryRebroadcastPending = false;
    try {
      this.publishInventory();
    } catch {
      this.fail("The local inventory could not be re-advertised. Reconnect to restart synchronization.");
    }
  }

  private async requestMissing(session: InventorySession): Promise<void> {
    const requestEpoch = this.epoch;
    let current: StoredMessage[];
    try {
      await this.localSnapshotReady;
      if (!this.isRunActive(requestEpoch) || !this.isSessionActive(session)) return;
      current = await this.options.loadAccepted();
    } catch {
      if (this.isRunActive(requestEpoch) && this.isSessionActive(session)) this.fail("The local storage check failed. Reconnect to restart synchronization from fresh inventories.");
      return;
    }
    if (!this.isRunActive(requestEpoch) || !this.isSessionActive(session)) return;
    let selector: ReturnType<typeof createWasmMissingIdSelector> | null = null;
    try {
      selector = createWasmMissingIdSelector(session.ids);
      let localChunk: string[] = [];
      for (const item of current) {
        if (item.packet.room !== this.options.room || item.delivery !== "sent" || item.failure !== undefined
          || !this.options.validateMessage(item.packet)) continue;
        localChunk.push(item.packet.id);
        if (localChunk.length === MAX_SYNC_SELECTION_CHUNK_IDS) {
          selector.observeLocalIds(localChunk);
          localChunk = [];
        }
      }
      if (localChunk.length > 0) selector.observeLocalIds(localChunk);
      session.missingIds = selector.finish();
      if (session.missingIds.length === 0) {
        this.options.onState?.(this.partial ? "partial" : "complete", this.partial
          ? "An inventory exceeded the 4,096 ID limit. This exchange cannot claim complete synchronization."
          : "The peer inventory contains no message IDs missing from this local snapshot.");
        return;
      }
      this.sendNextRequest(session);
    } catch {
      if (this.isRunActive(requestEpoch) && this.isSessionActive(session)) this.fail("WASM could not compare the local snapshot with the peer inventory. Reconnect to restart synchronization.");
    } finally {
      selector?.free();
    }
  }

  private sendNextRequest(session?: InventorySession): void {
    if (this.stopped || this.failed) return;
    if ([...this.remote.values()].some((entry) => !this.blockedSenders.has(entry.sender) && entry.activeRequestId !== null)) return;
    if (!session) session = [...this.remote.values()].find((entry) => !this.blockedSenders.has(entry.sender) && entry.nextRequestOffset < entry.missingIds.length);
    if (!session) {
      this.options.onState?.(this.partial ? "partial" : "complete", this.partial
        ? "Requested pages were verified, but an inventory or page was incomplete. This exchange is partial."
        : "Requested message pages were received and verified in local storage.");
      return;
    }
    if (!this.isSessionActive(session)) return;
    if (session.activeRequestId) return;
    if (session.nextRequestOffset >= session.missingIds.length) {
      return this.sendNextRequest();
    }
    let ids: string[];
    try {
      const batch = planWasmMissingBatch(session.missingIds, session.nextRequestOffset);
      ids = batch.ids;
      if (ids.length === 0 || batch.nextOffset <= session.nextRequestOffset || batch.nextOffset > session.missingIds.length
        || batch.hasMore !== (batch.nextOffset < session.missingIds.length)) {
        throw new Error("WASM returned an invalid synchronization request batch.");
      }
      session.nextRequestOffset = batch.nextOffset;
    } catch {
      this.fail("WASM could not plan synchronization request batches. Reconnect to start over.");
      return;
    }
    const requestId = this.options.makeId();
    const request: SyncMissingRequestPacket = {
      version: PROTOCOL_VERSION,
      type: "sync_missing_request",
      room: this.options.room,
      syncId: session.syncId,
      requestId,
      sender: this.options.sender,
      targetSender: session.sender,
      messageIds: ids,
    };
    const bookKey = `out:${key(session.sender, session.syncId)}`;
    let book = this.wasmRequestBooks.get(bookKey);
    try {
      if (!book) {
        book = createWasmSyncRequestBook();
        this.wasmRequestBooks.set(bookKey, book);
      }
      book.registerRequest(request);
    } catch {
      this.fail("WASM could not register synchronization request state. Reconnect to start over.");
      return;
    }
    this.requests.set(requestId, { sender: session.sender, syncId: session.syncId, ids, received: new Map() });
    session.activeRequestId = requestId;
    try { this.options.send(request); }
    catch { this.fail("A missing-message request could not be sent. Reconnect to restart synchronization."); }
  }

  private async respond(request: SyncMissingRequestPacket, responseEpoch: number): Promise<void> {
    await this.localSnapshotReady;
    if (!this.isResponseActive(request, responseEpoch)) return;
    if (request.targetSender !== this.options.sender || request.syncId !== this.localSyncId || this.localSyncId === "") return;
    const prior = this.handledRequests.get(handledRequestKey(request.sender, request.syncId, request.requestId));
    if (prior && !sameJson(prior, request)) return this.fail("A request ID was reused with different contents. Reconnect to start over.");
    try {
      const current = await this.options.loadAccepted();
      if (!this.isResponseActive(request, responseEpoch)) return;
      const available = new Map(current.filter((item) => item.packet.room === this.options.room
        && item.delivery === "sent" && item.failure === undefined && request.messageIds.includes(item.packet.id)
        && this.localIds.has(item.packet.id)
        && this.options.validateMessage(item.packet)).map((item) => [item.packet.id, item.packet]));
      const emitted: string[] = [];
      for (const id of request.messageIds) {
        const message = available.get(id);
        if (!message) continue;
        const sent = await this.sendMessage(message, request.sender);
        if (!this.isResponseActive(request, responseEpoch)) return;
        if (!sent) break;
        emitted.push(id);
      }
      const completion: SyncPageCompletePacket = {
        version: PROTOCOL_VERSION,
        type: "sync_page_complete",
        room: this.options.room,
        syncId: request.syncId,
        requestId: request.requestId,
        sender: this.options.sender,
        targetSender: request.sender,
        messageIds: emitted,
      };
      if (!this.isResponseActive(request, responseEpoch)) return;
      const book = this.wasmRequestBooks.get(`in:${key(request.sender, request.syncId)}`);
      if (!book) return;
      try {
        book.acceptCompletion(completion);
      } catch {
        if (this.isResponseActive(request, responseEpoch)) this.fail("WASM could not verify the outgoing synchronization completion. Reconnect to start over.");
        return;
      }
      if (!this.isResponseActive(request, responseEpoch)) return;
      this.options.send(completion);
    } catch {
      if (this.isResponseActive(request, responseEpoch)) this.fail("The requested message snapshot could not be checked. Reconnect to restart synchronization.");
    }
  }

  private sendMessage(packet: MessagePacket, recipient: string): Promise<boolean> {
    const epoch = this.epoch;
    const operation = this.messageSendQueue.catch(() => undefined).then(async () => {
      if (this.stopped || this.failed || epoch !== this.epoch || this.messageSendBlocked || this.blockedSenders.has(recipient)) return false;
      const interval = Math.max(0, this.options.messageIntervalMs ?? 0);
      if (interval > 0) {
        const now = Date.now();
        const sendAt = Math.max(now, this.nextMessageAt);
        this.nextMessageAt = sendAt + interval;
        const waitMs = sendAt - now;
        if (waitMs > 0) await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingMessageWait = null;
            resolve();
          }, waitMs);
          this.pendingMessageWait = { timer, resolve, recipient };
        });
      }
      if (this.stopped || this.failed || epoch !== this.epoch || this.messageSendBlocked || this.blockedSenders.has(recipient)) return false;
      this.options.send(packet);
      return true;
    });
    this.messageSendQueue = operation.then(() => undefined);
    return operation;
  }

  private async complete(packet: SyncPageCompletePacket): Promise<void> {
    if (packet.targetSender !== this.options.sender) return;
    const request = this.requests.get(packet.requestId);
    if (!request || request.sender !== packet.sender || request.syncId !== packet.syncId) return;
    const completeEpoch = this.epoch;
    const book = this.wasmRequestBooks.get(`out:${key(packet.sender, packet.syncId)}`);
    if (!book) return this.fail("WASM synchronization request state was lost. Reconnect to start over.");
    let outcome: "accepted" | "duplicate";
    try {
      outcome = book.acceptCompletion(packet);
    } catch {
      this.fail("WASM could not verify synchronization completion state. Reconnect to start over.");
      return;
    }
    if (outcome === "duplicate") return;
    if (request.completion) {
      if (!sameJson(request.completion, packet)) this.fail("A completed request ID was reused with different contents. Reconnect to start over.");
      return;
    }
    if (!packet.messageIds.every((id) => request.ids.includes(id))) {
      this.fail("A completion listed a message that was not requested. Reconnect to restart synchronization.");
      return;
    }
    const observedIds = [...request.received.keys()].sort();
    const completedIds = [...packet.messageIds].sort();
    if (observedIds.some((id) => !completedIds.includes(id))) {
      this.fail("The peer completion omitted a message that was durably received. Reconnect to restart synchronization.");
      return;
    }
    const incompletePage = completedIds.length < request.ids.length || observedIds.length < completedIds.length;
    try {
      const stored = await this.options.loadAccepted();
      if (!this.isRunActive(completeEpoch) || this.requests.get(packet.requestId) !== request) return;
      const byId = new Map(stored.filter((item) => item.packet.room === this.options.room && item.delivery === "sent" && item.failure === undefined).map((item) => [item.packet.id, item.packet]));
      for (const id of observedIds) {
        const expected = request.received.get(id);
        const actual = byId.get(id);
        if (!actual || !this.options.validateMessage(actual) || (expected && !sameJson(expected, actual))) {
          this.fail("A requested message was not durably saved before page completion. Reconnect to retry with a fresh exchange.");
          return;
        }
      }
      if (!this.retainControl(packet)) return;
      if (incompletePage) this.partial = true;
      request.completion = packet;
      request.received.clear();
      const session = this.remote.get(key(packet.sender, packet.syncId));
      if (session?.activeRequestId === packet.requestId) session.activeRequestId = null;
      if (incompletePage) this.options.onState?.("partial", "The peer completed only part of a requested page. Available messages were saved; the exchange is partial.");
      this.sendNextRequest();
    } catch {
      if (this.isRunActive(completeEpoch) && this.requests.get(packet.requestId) === request) this.fail("Local storage could not verify the received page. Reconnect to restart synchronization from fresh inventories.");
    }
  }

  private reset(): void {
    this.stop();
    this.stopped = true;
    this.failed = false;
    this.partial = false;
  }

  private markLocalSnapshotReady(): void {
    if (!this.resolveLocalSnapshotReady) return;
    this.resolveLocalSnapshotReady();
    this.resolveLocalSnapshotReady = null;
  }

  private isRunActive(epoch: number): boolean {
    return !this.stopped && !this.failed && this.epoch === epoch;
  }

  private isSessionActive(session: InventorySession): boolean {
    return this.remote.get(key(session.sender, session.syncId)) === session && !this.blockedSenders.has(session.sender);
  }

  private isResponseActive(request: SyncMissingRequestPacket, epoch: number): boolean {
    return this.isRunActive(epoch) && !this.blockedSenders.has(request.sender)
      && request.targetSender === this.options.sender && request.syncId === this.localSyncId;
  }

  private fail(detail: string): void {
    this.failed = true;
    this.options.onState?.("error", detail);
    this.stop();
    this.failed = true;
  }
}
