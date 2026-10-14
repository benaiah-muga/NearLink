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
  pages: Map<string, SyncInventoryPagePacket>;
  ids: string[];
  nextCursor: string | null;
  done: boolean;
  limitReached: boolean;
  missingIds: string[];
  nextRequestOffset: number;
  activeRequestId: string | null;
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

function sortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export class SyncCoordinator {
  private readonly options: SyncCoordinatorOptions;
  private stopped = true;
  private localSyncId = "";
  private localIds = new Set<string>();
  private remote = new Map<string, InventorySession>();
  private requests = new Map<string, PendingRequest>();
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
  private pendingMessageWait: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
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
    this.localSnapshotReady = new Promise<void>((resolve) => { this.resolveLocalSnapshotReady = resolve; });
    this.options.onState?.("syncing", "Exchanging bounded local message inventories.");
    try {
      const stored = await this.options.loadAccepted();
      if (this.stopped) return;
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
      this.fail("Local storage could not provide an accepted-message snapshot. Reconnect to restart synchronization.");
    }
  }

  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.markLocalSnapshotReady();
    this.remote.clear();
    this.requests.clear();
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
      await this.localSnapshotReady;
      if (this.stopped || this.failed || !this.localSyncId || packet.targetSender !== this.options.sender || packet.syncId !== this.localSyncId) return;
      const prior = this.handledRequests.get(packet.requestId);
      if (prior) {
        if (!sameJson(prior, packet)) this.fail("A request ID was reused with different contents. Reconnect to start over.");
        return;
      }
      if (!this.retainControl(packet)) return;
      this.handledRequests.set(packet.requestId, packet);
      await this.respond(packet);
    } else if (packet.type === "sync_page_complete") {
      if (!isSyncPageCompletePacket(packet)) return this.fail("A peer sent an invalid synchronization completion. Reconnect to start over.");
      await this.localSnapshotReady;
      if (this.stopped || this.failed) return;
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
    for (const [sessionKey, session] of this.remote) if (session.sender === sender) this.remote.delete(sessionKey);
    for (const [requestId, request] of this.requests) if (request.sender === sender) this.requests.delete(requestId);
    for (const [requestId, request] of this.handledRequests) if (request.sender === sender) this.handledRequests.delete(requestId);
    this.options.onState?.("partial", "A peer exceeded the bounded synchronization control budget. That peer is incomplete; reconnect to retry from saved messages while other peer exchanges may continue.");
  }

  private acceptInventory(packet: SyncInventoryPagePacket): void {
    const sessionKey = key(packet.sender, packet.syncId);
    let session = this.remote.get(sessionKey);
    if (!session) {
      if (this.remote.size >= 32) return this.fail("Too many peer inventory sessions arrived. Reconnect to start over.");
      session = { sender: packet.sender, syncId: packet.syncId, pages: new Map(), ids: [], nextCursor: null, done: false, limitReached: false, missingIds: [], nextRequestOffset: 0, activeRequestId: null };
      this.remote.set(sessionKey, session);
      if (this.options.rebroadcastOnPeerInventory !== false) {
        if (this.localSyncId) this.rebroadcastInventoryOnce();
        else this.inventoryRebroadcastPending = true;
      }
    }
    const pageKey = packet.cursor ?? "";
    const known = session.pages.get(pageKey);
    if (known) {
      if (!sameJson(known, packet)) this.fail("A peer changed an inventory page after sending it. Reconnect to start over.");
      return;
    }
    if (session.done || packet.cursor !== session.nextCursor || (session.ids.length === 0 && packet.cursor !== null)
      || (session.ids.length > 0 && packet.cursor === null)
      || session.ids.length + packet.messageIds.length > MAX_SYNC_INVENTORY_IDS
      || !sortedUnique(packet.messageIds)
      || (session.ids.length > 0 && packet.messageIds.length > 0 && session.ids.at(-1)! >= packet.messageIds[0])) {
      this.fail("Inventory pages had a gap, duplicate, or limit violation. Reconnect to start over.");
      return;
    }
    if (!this.retainControl(packet)) return;
    session.pages.set(pageKey, packet);
    session.ids.push(...packet.messageIds);
    session.nextCursor = packet.nextCursor;
    session.done = !packet.hasMore;
    session.limitReached = packet.limitReached;
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
    try {
      await this.localSnapshotReady;
      if (this.stopped || this.failed) return;
      const current = await this.options.loadAccepted();
      if (this.stopped || this.failed) return;
      const currentIds = new Set(current.filter((item) => item.packet.room === this.options.room
        && item.delivery === "sent" && item.failure === undefined && this.options.validateMessage(item.packet)).map((item) => item.packet.id));
      session.missingIds = session.ids.filter((id) => !currentIds.has(id));
      if (session.missingIds.length === 0) {
        this.options.onState?.(this.partial ? "partial" : "complete", this.partial
          ? "An inventory exceeded the 4,096 ID limit. This exchange cannot claim complete synchronization."
          : "The peer inventory contains no message IDs missing from this local snapshot.");
        return;
      }
      this.sendNextRequest(session);
    } catch {
      this.fail("The local storage check failed. Reconnect to restart synchronization from fresh inventories.");
    }
  }

  private sendNextRequest(session?: InventorySession): void {
    if (this.stopped || this.failed) return;
    if ([...this.remote.values()].some((entry) => entry.activeRequestId !== null)) return;
    if (!session) session = [...this.remote.values()].find((entry) => entry.nextRequestOffset < entry.missingIds.length);
    if (!session) {
      this.options.onState?.(this.partial ? "partial" : "complete", this.partial
        ? "Requested pages were verified, but an inventory or page was incomplete. This exchange is partial."
        : "Requested message pages were received and verified in local storage.");
      return;
    }
    if (session.activeRequestId) return;
    if (session.nextRequestOffset >= session.missingIds.length) {
      return this.sendNextRequest();
    }
    const ids = session.missingIds.slice(session.nextRequestOffset, session.nextRequestOffset + MAX_SYNC_PACKET_IDS);
    session.nextRequestOffset += ids.length;
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
    this.requests.set(requestId, { sender: session.sender, syncId: session.syncId, ids, received: new Map() });
    session.activeRequestId = requestId;
    try { this.options.send(request); }
    catch { this.fail("A missing-message request could not be sent. Reconnect to restart synchronization."); }
  }

  private async respond(request: SyncMissingRequestPacket): Promise<void> {
    await this.localSnapshotReady;
    if (this.stopped || this.failed) return;
    if (request.targetSender !== this.options.sender || request.syncId !== this.localSyncId || this.localSyncId === "") return;
    const prior = this.handledRequests.get(request.requestId);
    if (prior && !sameJson(prior, request)) return this.fail("A request ID was reused with different contents. Reconnect to start over.");
    try {
      const current = await this.options.loadAccepted();
      if (this.stopped || this.failed || request.syncId !== this.localSyncId) return;
      const available = new Map(current.filter((item) => item.packet.room === this.options.room
        && item.delivery === "sent" && item.failure === undefined && request.messageIds.includes(item.packet.id)
        && this.localIds.has(item.packet.id)
        && this.options.validateMessage(item.packet)).map((item) => [item.packet.id, item.packet]));
      const emitted: string[] = [];
      for (const id of request.messageIds) {
        const message = available.get(id);
        if (!message) continue;
        const sent = await this.sendMessage(message);
        if (this.stopped || this.failed) return;
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
      this.options.send(completion);
    } catch {
      this.fail("The requested message snapshot could not be checked. Reconnect to restart synchronization.");
    }
  }

  private sendMessage(packet: MessagePacket): Promise<boolean> {
    const epoch = this.epoch;
    const operation = this.messageSendQueue.catch(() => undefined).then(async () => {
      if (this.stopped || this.failed || epoch !== this.epoch || this.messageSendBlocked) return false;
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
          this.pendingMessageWait = { timer, resolve };
        });
      }
      if (this.stopped || this.failed || epoch !== this.epoch || this.messageSendBlocked) return false;
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
      if (this.stopped || this.failed || this.requests.get(packet.requestId) !== request) return;
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
      this.fail("Local storage could not verify the received page. Reconnect to restart synchronization from fresh inventories.");
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

  private fail(detail: string): void {
    this.failed = true;
    this.options.onState?.("error", detail);
    this.stop();
    this.failed = true;
  }
}
