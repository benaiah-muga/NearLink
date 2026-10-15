// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MessagePacket } from "@nearlink/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageReadGate = vi.hoisted(() => ({
  room: null as string | null,
  readGateAfter: null as number | null,
  identityPending: null as Promise<import("./lib/storage").LocalIdentity | null> | null,
  identitySavePending: null as Promise<void> | null,
  identitySaveStarted: false,
  releaseIdentitySave: null as (() => void) | null,
  reconcilePendingId: null as string | null,
  reconcilePending: null as Promise<void> | null,
  releaseReconcile: null as (() => void) | null,
  reconcileStarted: false,
  pending: null as Promise<unknown> | null,
  releaseRead: null as ((rows?: StoredMessage[]) => void) | null,
  requestedRooms: [] as string[],
  ackDispatching: false,
  ackDispatchRoomReads: 0,
  rejectAckFallbackRead: false,
  failNextMessageLoads: 0,
  failNextSaveIds: [] as string[],
  failDeleteRoomMessages: false,
  failCancelRoomDeletion: false,
  saveAttempts: new Map<string, number>(),
  deliveryUpdateId: null as string | null,
  deliveryUpdatePending: null as Promise<void> | null,
  releaseDeliveryUpdate: null as (() => void) | null,
  deliveryUpdateStarted: false,
  deliveryUpdateReject: false,
  resumeRoom: null as string | null,
  resumePending: null as Promise<void> | null,
  releaseResume: null as (() => void) | null,
  resumeStarted: false,
}));
const wasmGate = vi.hoisted(() => ({ fail: false }));

vi.mock("./lib/wasmProtocol", async () => {
  const protocol = await import("@nearlink/protocol");
  return {
    MAX_PROTOCOL_ENVELOPE_BYTES: 18 * 1024,
    initializeWasmProtocol: async () => !wasmGate.fail,
    classifyInboundAcceptance: (expectedRoom: string, roomDeleted: boolean, candidate: MessagePacket, existing?: MessagePacket) => {
      if (wasmGate.fail) throw new Error("WASM inbound acceptance is unavailable.");
      if (candidate.room !== expectedRoom) throw new Error("WASM rejected inbound acceptance (room_mismatch).");
      if (roomDeleted) return "room_deleted";
      if (!existing) return "saved";
      return JSON.stringify(candidate) === JSON.stringify(existing) ? "duplicate" : "conflict";
    },
    validateJsonWithWasm: (validator: string, json: string) => {
      if (wasmGate.fail || json.length > 18 * 1024) return false;
      try {
        const value: unknown = JSON.parse(json);
        if (validator === "client") return protocol.isClientPacket(value);
        if (validator === "message") return protocol.isMessagePacket(value);
        return protocol.isServerPacket(value);
      } catch { return false; }
    },
    validateWithWasm: (validator: string, value: unknown) => {
      if (wasmGate.fail) return false;
      if (validator === "client") return protocol.isClientPacket(value);
      if (validator === "message") return protocol.isMessagePacket(value);
      if (validator === "server") return protocol.isServerPacket(value);
      if (validator === "room") return protocol.isProtocolRoom(value);
      return protocol.isProtocolIdentifier(value);
    },
    isWasmSyncStateReady: () => !wasmGate.fail,
    MAX_SYNC_SELECTION_CHUNK_IDS: 4096,
    createWasmSyncInventoryReceiver: () => {
      const ids: string[] = [];
      let missingIds: string[] | null = null;
      let nextMissingOffset = 0;
      return {
        acceptPage: (packet: import("@nearlink/protocol").SyncInventoryPagePacket) => {
          ids.push(...packet.messageIds);
          return { outcome: "accepted" as const, ids: [...ids], complete: !packet.hasMore, limitReached: !packet.hasMore && packet.limitReached };
        },
        setMissingIds: (next: string[]) => { missingIds = [...next]; nextMissingOffset = 0; },
        nextMissingBatch: () => {
          if (!missingIds) throw new Error("Missing-ID plan is unavailable.");
          const batch = missingIds.slice(nextMissingOffset, nextMissingOffset + 100);
          nextMissingOffset += batch.length;
          return { ids: batch, hasMore: nextMissingOffset < missingIds.length };
        },
        hasMissingPlan: () => missingIds !== null,
        hasMissingIdsRemaining: () => missingIds !== null && nextMissingOffset < missingIds.length,
        free: () => undefined,
      };
    },
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
    createWasmSyncRequestBook: () => {
      const requests = new Map<string, {
        packet: import("@nearlink/protocol").SyncMissingRequestPacket;
        received: Map<string, MessagePacket>;
        staged?: import("@nearlink/protocol").SyncPageCompletePacket;
        completion?: import("@nearlink/protocol").SyncPageCompletePacket;
      }>();
      return {
        registerRequest: (packet: import("@nearlink/protocol").SyncMissingRequestPacket) => {
          const existing = requests.get(packet.requestId);
          if (existing) {
            if (JSON.stringify(existing.packet) !== JSON.stringify(packet)) throw new Error("Request ID conflict.");
            return "duplicate" as const;
          }
          requests.set(packet.requestId, { packet, received: new Map() });
          return "accepted" as const;
        },
        acceptCompletion: (packet: import("@nearlink/protocol").SyncPageCompletePacket) => {
          const entry = requests.get(packet.requestId);
          if (!entry || packet.room !== entry.packet.room || packet.syncId !== entry.packet.syncId
            || packet.sender !== entry.packet.targetSender || packet.targetSender !== entry.packet.sender
            || packet.messageIds.some((id) => !entry.packet.messageIds.includes(id))) throw new Error("Completion mismatch.");
          if (entry.completion) {
            if (JSON.stringify(entry.completion) !== JSON.stringify(packet)) throw new Error("Completion conflict.");
            return "duplicate" as const;
          }
          entry.completion = packet;
          return "accepted" as const;
        },
        observeMessage: (packet: MessagePacket) => {
          let matched = false;
          for (const entry of requests.values()) {
            if (entry.completion || packet.room !== entry.packet.room || packet.sender !== entry.packet.targetSender || !entry.packet.messageIds.includes(packet.id)) continue;
            if (entry.staged && !entry.staged.messageIds.includes(packet.id)) throw new Error("Message arrived outside staged completion.");
            const prior = entry.received.get(packet.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(packet)) throw new Error("Message conflict.");
            entry.received.set(packet.id, packet);
            matched = true;
          }
          return matched ? "matched" as const : "unmatched" as const;
        },
        hasOutstandingMessageId: (id: string) => [...requests.values()].some((entry) => !entry.completion && entry.packet.messageIds.includes(id)),
        stageCompletion: (packet: import("@nearlink/protocol").SyncPageCompletePacket) => {
          const entry = requests.get(packet.requestId);
          if (!entry) return { outcome: "unknown" as const, requestedIds: [], observedIds: [], completedIds: [], isCompleted: false };
          const duplicate = Boolean(entry.completion || entry.staged);
          if (entry.completion && JSON.stringify(entry.completion) !== JSON.stringify(packet)) throw new Error("Completion conflict.");
          if (entry.staged && JSON.stringify(entry.staged) !== JSON.stringify(packet)) throw new Error("Completion conflict.");
          if (!entry.completion && !entry.staged) {
            if (packet.room !== entry.packet.room || packet.syncId !== entry.packet.syncId
              || packet.sender !== entry.packet.targetSender || packet.targetSender !== entry.packet.sender
              || packet.messageIds.some((id) => !entry.packet.messageIds.includes(id))
              || [...entry.received.keys()].some((id) => !packet.messageIds.includes(id))) throw new Error("Completion mismatch.");
            entry.staged = packet;
          }
          return {
            outcome: duplicate ? "duplicate" as const : "accepted" as const,
            requestedIds: [...entry.packet.messageIds],
            observedIds: [...entry.received.keys()].sort(),
            completedIds: [...packet.messageIds],
            isCompleted: Boolean(entry.completion),
          };
        },
        finishCompletion: (requestId: string, durable: boolean) => {
          const entry = requests.get(requestId);
          if (!entry?.staged) throw new Error("Missing staged completion.");
          if (durable) { entry.completion = entry.staged; entry.received.clear(); }
          entry.staged = undefined;
        },
        verifyDurableMessages: (requestId: string, packets: MessagePacket[]) => {
          const entry = requests.get(requestId);
          if (!entry || entry.received.size !== packets.length) return false;
          const byId = new Map(packets.map((packet) => [packet.id, packet]));
          return [...entry.received].every(([id, packet]) => JSON.stringify(byId.get(id)) === JSON.stringify(packet));
        },
        free: () => undefined,
      };
    },
  };
});

vi.mock("./lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/storage")>();
  const overrides = {
    loadIdentity: () => messageReadGate.identityPending ?? actual.loadIdentity(),
    saveIdentity: async (...args: Parameters<typeof actual.saveIdentity>) => {
      if (messageReadGate.identitySavePending) {
        messageReadGate.identitySaveStarted = true;
        await messageReadGate.identitySavePending;
      }
      return actual.saveIdentity(...args);
    },
    reconcileHubReplayOrder: async (...args: Parameters<typeof actual.reconcileHubReplayOrder>) => {
      if (args[1].includes(messageReadGate.reconcilePendingId ?? "") && messageReadGate.reconcilePending) {
        messageReadGate.reconcileStarted = true;
        await messageReadGate.reconcilePending;
      }
      return actual.reconcileHubReplayOrder(...args);
    },
    loadMessages: (room: string) => {
      messageReadGate.requestedRooms.push(room);
      if (messageReadGate.failNextMessageLoads > 0) {
        messageReadGate.failNextMessageLoads -= 1;
        return Promise.reject(new Error("Injected message read failure."));
      }
      if (messageReadGate.ackDispatching && room === messageReadGate.room) {
        messageReadGate.ackDispatchRoomReads += 1;
        if (messageReadGate.rejectAckFallbackRead) {
          messageReadGate.rejectAckFallbackRead = false;
          return Promise.reject(new Error("Injected message read failure."));
        }
      }
      const roomReadCount = messageReadGate.requestedRooms.filter((requestedRoom) => requestedRoom === room).length;
      if (room === messageReadGate.room && messageReadGate.pending && (messageReadGate.readGateAfter === null || roomReadCount >= messageReadGate.readGateAfter)) {
        return messageReadGate.pending as ReturnType<typeof actual.loadMessages>;
      }
      return actual.loadMessages(room);
    },
    loadRequestedMessages: (room: string, ids: string[], validate: (packet: MessagePacket) => boolean) => {
      messageReadGate.requestedRooms.push(room);
      if (messageReadGate.failNextMessageLoads > 0) {
        messageReadGate.failNextMessageLoads -= 1;
        return Promise.reject(new Error("Injected message read failure."));
      }
      const roomReadCount = messageReadGate.requestedRooms.filter((requestedRoom) => requestedRoom === room).length;
      if (room === messageReadGate.room && messageReadGate.pending && (messageReadGate.readGateAfter === null || roomReadCount >= messageReadGate.readGateAfter)) {
        return messageReadGate.pending.then((rows) => (rows as StoredMessage[]).filter((row) => ids.includes(row.packet.id) && validate(row.packet)));
      }
      return actual.loadRequestedMessages(room, ids, validate);
    },
    saveMessage: async (message: Parameters<typeof actual.saveMessage>[0]) => {
      const id = message.packet.id;
      messageReadGate.saveAttempts.set(id, (messageReadGate.saveAttempts.get(id) ?? 0) + 1);
      const failureIndex = messageReadGate.failNextSaveIds.indexOf(id);
      if (failureIndex !== -1) {
        messageReadGate.failNextSaveIds.splice(failureIndex, 1);
        throw new Error("Injected local storage failure.");
      }
      return actual.saveMessage(message);
    },
    acceptInboundMessage: async (message: Parameters<typeof actual.acceptInboundMessage>[0]) => {
      const id = message.packet.id;
      messageReadGate.saveAttempts.set(id, (messageReadGate.saveAttempts.get(id) ?? 0) + 1);
      const failureIndex = messageReadGate.failNextSaveIds.indexOf(id);
      if (failureIndex !== -1) {
        messageReadGate.failNextSaveIds.splice(failureIndex, 1);
        throw new Error("Injected local storage failure.");
      }
      return actual.acceptInboundMessage(message);
    },
    resumeRoomMessages: async (room: string) => {
      if (room === messageReadGate.resumeRoom && messageReadGate.resumePending) {
        messageReadGate.resumeStarted = true;
        await messageReadGate.resumePending;
      }
      return actual.resumeRoomMessages(room);
    },
    deleteRoomMessages: async (room: string) => {
      if (messageReadGate.failDeleteRoomMessages) throw new Error("Injected room deletion failure.");
      return actual.deleteRoomMessages(room);
    },
    cancelRoomDeletion: async (room: string) => {
      if (messageReadGate.failCancelRoomDeletion) throw new Error("Injected marker cleanup failure.");
      return actual.cancelRoomDeletion(room);
    },
    updateDelivery: async (...args: Parameters<typeof actual.updateDelivery>) => {
      const [, id] = args;
      if (id === messageReadGate.deliveryUpdateId && messageReadGate.deliveryUpdatePending) {
        messageReadGate.deliveryUpdateStarted = true;
        await messageReadGate.deliveryUpdatePending;
        if (messageReadGate.deliveryUpdateReject) throw new Error("Injected status write failure.");
      }
      return actual.updateDelivery(...args);
    },
  };
  return {
    ...actual,
    ...overrides,
    browserConversationStore: {
      ...actual.browserConversationStore,
      ...overrides,
    },
  };
});

import App from "./App";
import { beginRoomDeletion, deleteRoomMessages, isRoomMessagesDeleted, loadIdentity, loadMessages, saveMessage, type LocalIdentity, type StoredMessage } from "./lib/storage";

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, "storage");
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalDialogCloseDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function setStorageManager(storageManager: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, "storage", { configurable: true, value: storageManager });
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly sentAt: number[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
    this.sentAt.push(performance.now());
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(packet: unknown): void {
    this.onmessage?.({ data: JSON.stringify(packet) } as MessageEvent);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) return;
    this.readyState = MockWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({} as CloseEvent);
    });
  }
}

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    for (const channel of MockBroadcastChannel.instances) {
      if (channel !== this && !channel.closed && channel.name === this.name) {
        queueMicrotask(() => channel.onmessage?.({ data } as MessageEvent<unknown>));
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

const ROOM = "campus-radio";
const IDENTITY = { sender: "station-a", senderName: "Ari" };

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nearlink-local");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked."));
  });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("nearlink-local", 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      const messages = database.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
      messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
      messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
      messages.createIndex("roomDisplayOrder", ["packet.room", "displayOrder"]);
      database.createObjectStore("identity", { keyPath: "key" });
      database.createObjectStore("roomDeletions", { keyPath: "room" });
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("identity", "readwrite");
      transaction.objectStore("identity").put({ key: "profile", ...IDENTITY });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
    request.onerror = () => reject(request.error);
  });
}

function hubMessage(id: string, createdAt: string, body = id): MessagePacket {
  return { version: 1, type: "message", id, room: ROOM, sender: "station-b", senderName: "Bea", createdAt, body };
}

function sendHistoryCompletion(socket: MockWebSocket, packets: ReturnType<typeof hubMessage>[], nextCursor: string | null, hasMore: boolean) {
  const historyRequest = JSON.parse(socket.sent.filter((item) => JSON.parse(item).type === "history_request").at(-1)!);
  const pageBytes = packets.reduce((total, packet) => total + new TextEncoder().encode(JSON.stringify(packet)).byteLength, 0);
  socket.receive({ version: 1, type: "history_page_complete", requestId: historyRequest.requestId, room: ROOM, messageIds: packets.map((packet) => packet.id), pageBytes, nextCursor, hasMore, historyTruncated: false });
}

async function connectTestHub(sendReplayBoundary = true): Promise<MockWebSocket> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];
  act(() => socket.open());
  act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
  if (sendReplayBoundary) act(() => socket.receive({ version: 1, type: "presence", room: ROOM, peers: 1 }));
  await screen.findByText("On frequency");
  return socket;
}

beforeEach(async () => {
  wasmGate.fail = false;
  MockWebSocket.instances = [];
  messageReadGate.room = null;
  messageReadGate.readGateAfter = null;
  messageReadGate.identityPending = null;
  messageReadGate.identitySavePending = null;
  messageReadGate.identitySaveStarted = false;
  messageReadGate.releaseIdentitySave = null;
  messageReadGate.reconcilePendingId = null;
  messageReadGate.reconcilePending = null;
  messageReadGate.releaseReconcile = null;
  messageReadGate.reconcileStarted = false;
  messageReadGate.pending = null;
  messageReadGate.releaseRead = null;
  messageReadGate.requestedRooms = [];
  messageReadGate.ackDispatching = false;
  messageReadGate.ackDispatchRoomReads = 0;
  messageReadGate.rejectAckFallbackRead = false;
  messageReadGate.failNextMessageLoads = 0;
  messageReadGate.failNextSaveIds = [];
  messageReadGate.failDeleteRoomMessages = false;
  messageReadGate.failCancelRoomDeletion = false;
  messageReadGate.saveAttempts = new Map();
  messageReadGate.deliveryUpdateId = null;
  messageReadGate.deliveryUpdatePending = null;
  messageReadGate.releaseDeliveryUpdate = null;
  messageReadGate.deliveryUpdateStarted = false;
  messageReadGate.deliveryUpdateReject = false;
  messageReadGate.resumeRoom = null;
  messageReadGate.resumePending = null;
  messageReadGate.releaseResume = null;
  messageReadGate.resumeStarted = false;
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockBroadcastChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  localStorage.setItem("nearlink.room", ROOM);
  localStorage.setItem("nearlink.hub", "ws://localhost:8000/ws");
  await resetDatabase();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalStorageDescriptor) Object.defineProperty(navigator, "storage", originalStorageDescriptor);
  else Reflect.deleteProperty(navigator, "storage");
  if (originalClipboardDescriptor) Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalShowModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalDialogCloseDescriptor) Object.defineProperty(HTMLDialogElement.prototype, "close", originalDialogCloseDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hub join handshake", () => {
  async function enableFakeTimersAfterReady(): Promise<void> {
    const connectButton = screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement;
    if (connectButton.disabled) {
      fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Sam" } });
      const saveButton = screen.getByRole("button", { name: "Save and join room" }) as HTMLButtonElement;
      await waitFor(() => expect(saveButton.disabled).toBe(false));
      fireEvent.click(saveButton);
    } else {
      fireEvent.click(connectButton);
    }
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    vi.useFakeTimers();
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("times out an open socket without joined and caps backoff before join", async () => {
    render(<App />);
    await enableFakeTimersAfterReady();

    const retryDelays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, retryDelay] of retryDelays.entries()) {
      const socket = MockWebSocket.instances[index];
      expect(socket).toBeDefined();
      act(() => socket.open());
      await advance(10_000);
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      expect(screen.getByText("The hub did not confirm the room join. The radio will retry.")).toBeTruthy();
      await advance(retryDelay - 1);
      expect(MockWebSocket.instances).toHaveLength(index + 1);
      await advance(1);
      expect(MockWebSocket.instances).toHaveLength(index + 2);
    }
  });

  it("clears the join timeout on a validated join and resets the retry delay", async () => {
    render(<App />);
    await enableFakeTimersAfterReady();

    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    await advance(10_000);
    await advance(1_999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await advance(1);

    const joinedSocket = MockWebSocket.instances[1];
    act(() => joinedSocket.open());
    act(() => joinedSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    expect(screen.getByText("On frequency")).toBeTruthy();
    await advance(10_000);
    expect(joinedSocket.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => joinedSocket.close());
    await advance(0);
    await advance(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await advance(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("ignores stale socket callbacks after hub changes and unmount", async () => {
    const view = render(<App />);
    await enableFakeTimersAfterReady();
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    await advance(10_000);

    vi.useRealTimers();
    fireEvent.change(screen.getByLabelText("Hub address"), { target: { value: "ws://localhost:9000/ws" } });
    await act(async () => { await Promise.resolve(); });
    const staleClose = socket.onclose;
    const staleError = socket.onerror;
    act(() => {
      staleClose?.({} as CloseEvent);
      staleError?.(new Event("error"));
    });
    expect(screen.queryByText("The radio link reported a socket error. Retrying automatically.")).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);

    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    vi.useFakeTimers();
    const replacementSocket = MockWebSocket.instances[1];
    act(() => replacementSocket.open());
    await advance(10_000);
    await advance(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await advance(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    const currentSocket = MockWebSocket.instances[2];
    act(() => currentSocket.open());
    act(() => {
      currentSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 });
      currentSocket.receive({ version: 1, type: "presence", room: ROOM, peers: 1 });
    });
    view.unmount();
    const lateClose = currentSocket.onclose;
    const lateError = currentSocket.onerror;
    act(() => {
      lateClose?.({} as CloseEvent);
      lateError?.(new Event("error"));
    });
    await advance(60_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("replays persisted outbox messages when a timed out join eventually succeeds", async () => {
    await saveMessage({
      packet: hubMessage("queued-replay-first", "2026-10-15T08:00:00.000Z", "First queued message"),
      direction: "outgoing",
      delivery: "queued",
      transport: "hub",
    });
    await expect(loadMessages(ROOM)).resolves.toMatchObject([{ packet: { id: "queued-replay-first" }, direction: "outgoing", delivery: "queued", transport: "hub" }]);
    render(<App />);
    await enableFakeTimersAfterReady();

    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    await advance(10_000);
    await advance(2_000);
    const retrySocket = MockWebSocket.instances[1];
    act(() => retrySocket.open());
    act(() => retrySocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await advance(0);
    vi.useRealTimers();

    await screen.findByText("On frequency");
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((requestedRoom) => requestedRoom === ROOM).length).toBeGreaterThan(1));
    await expect(loadMessages(ROOM)).resolves.toMatchObject([{ packet: { id: "queued-replay-first" }, direction: "outgoing", delivery: "queued", transport: "hub" }]);
    expect(screen.queryByText("A saved message did not pass protocol checks and was not sent.")).toBeNull();
    await waitFor(() => expect(retrySocket.sent.map((raw) => JSON.parse(raw).id)).toContain("queued-replay-first"));
  });
});

describe("browser storage retention feedback", () => {
  it("reports when persistent storage is granted", async () => {
    const persisted = vi.fn().mockResolvedValue(false);
    const persist = vi.fn().mockResolvedValue(true);
    setStorageManager({ persisted, persist });

    render(<App />);

    expect(await screen.findByText(/browser reports that NearLink storage is persistent/i)).toBeTruthy();
    expect(screen.getByText(/does not guarantee retention/i)).toBeTruthy();
    expect(screen.getByText(/user action, device loss, or browser behavior/i)).toBeTruthy();
    expect(screen.getByText(/this is not a backup/i)).toBeTruthy();
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("recognizes storage that is already persistent when the request API is missing", async () => {
    const persisted = vi.fn().mockResolvedValue(true);
    setStorageManager({ persisted });

    render(<App />);

    expect(await screen.findByText(/browser reports that NearLink storage is persistent/i)).toBeTruthy();
    expect(persisted).toHaveBeenCalledOnce();
  });

  it("explains a denied request and still lets the user save messages locally", async () => {
    const persist = vi.fn().mockResolvedValue(false);
    setStorageManager({ persisted: vi.fn().mockResolvedValue(false), persist });

    render(<App />);

    expect(await screen.findByText(/cannot assure that saved messages will be retained/i)).toBeTruthy();
    const draft = await screen.findByRole("textbox", { name: "Write a message" });
    await waitFor(() => expect((draft as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(draft, { target: { value: "Still available locally" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Queued on this device");
    expect(await loadMessages(ROOM)).toHaveLength(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("explains when persistent storage APIs are unavailable", async () => {
    setStorageManager(undefined);

    render(<App />);

    expect(await screen.findByText(/cannot assure that saved messages will be retained/i)).toBeTruthy();
    const draft = await screen.findByRole("textbox", { name: "Write a message" });
    await waitFor(() => expect((draft as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("treats a rejected persistence request as unprotected storage", async () => {
    setStorageManager({
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });

    render(<App />);

    expect(await screen.findByText(/cannot assure that saved messages will be retained/i)).toBeTruthy();
  });
});

describe("guided station setup", () => {
  it("explains first-run values and keeps manual peer setup behind an optional path", async () => {
    messageReadGate.identityPending = Promise.resolve({ sender: IDENTITY.sender, senderName: "" });
    render(<App />);

    expect(await screen.findByText("Start with three details")).toBeTruthy();
    expect(screen.getByText(/same shared room code/i)).toBeTruthy();
    expect(screen.getByText(/WebSocket address from the local hub operator/i)).toBeTruthy();
    expect(screen.getByText("Optional advanced path: manual direct peer setup").closest("details")?.open).toBe(false);

    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Ari" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(screen.queryByText("Start with three details")).toBeNull());

    fireEvent.click(screen.getByText("Optional advanced path: manual direct peer setup"));
    expect(screen.getByRole("button", { name: "Create offer" })).toBeTruthy();
  });

  it("shows practical recovery steps after an established hub link drops", async () => {
    render(<App />);
    const socket = await connectTestHub();

    act(() => socket.close());

    expect(await screen.findByText("Hub not reachable yet")).toBeTruthy();
    expect(screen.getByText(/hub is running, both devices can reach it on the local network/i)).toBeTruthy();
    expect(screen.getByText(/messages remain saved on this device while the app retries/i)).toBeTruthy();
  });
});

describe("browser app messaging flow", () => {
  it("shows a startup error without creating an identity when secure randomness is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    messageReadGate.identityPending = Promise.resolve(null);

    render(<App />);

    expect(await screen.findByText(/Secure NearLink IDs are unavailable in this browser/i)).toBeTruthy();
    expect(MockBroadcastChannel.instances).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Save and join room" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps an existing identity usable but refuses to queue a message without secure randomness", async () => {
    vi.stubGlobal("crypto", undefined);

    render(<App />);

    const draft = await screen.findByRole("textbox", { name: "Write a message" });
    await waitFor(() => expect((draft as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(draft, { target: { value: "Must not get a weak ID" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/Secure NearLink IDs are unavailable in this browser/i)).toBeTruthy();
    expect(await loadMessages(ROOM)).toHaveLength(0);
  });

  it("exchanges a hub inventory and serves a missing-message batch from accepted local storage", async () => {
    const accepted: StoredMessage = {
      packet: { version: 1, type: "message", id: "saved-sync-message", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Saved sync body" },
      direction: "outgoing",
      delivery: "sent",
      transport: "hub",
    };
    await saveMessage(accepted);
    render(<App />);
    const socket = await connectTestHub();
    await waitFor(() => expect(socket.sent.some((value) => JSON.parse(value).type === "sync_inventory_page")).toBe(true));
    const inventory = JSON.parse(socket.sent.find((value) => JSON.parse(value).type === "sync_inventory_page")!);
    expect(inventory).toMatchObject({ sender: IDENTITY.sender, room: ROOM, messageIds: [accepted.packet.id], hasMore: false });

    act(() => socket.receive({
      version: 1,
      type: "sync_missing_request",
      room: ROOM,
      syncId: inventory.syncId,
      requestId: accepted.packet.id,
      sender: "station-b",
      targetSender: IDENTITY.sender,
      messageIds: [accepted.packet.id],
    }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual(accepted.packet));
    act(() => socket.receive({ version: 1, type: "ack", id: accepted.packet.id }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "sync_page_complete" && value.requestId === accepted.packet.id)).toBe(true));
  });

  it("re-advertises once when a hub peer inventory arrives after local join readiness", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const inventory = { version: 1, type: "sync_inventory_page", room: ROOM, syncId: "existing-session", sender: "station-b", cursor: null, messageIds: ["older-message"], nextCursor: "older-message", hasMore: false, limitReached: false };
    act(() => socket.receive(inventory));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "sync_inventory_page")).toHaveLength(2));
    act(() => socket.receive(inventory));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "sync_inventory_page")).toHaveLength(2);
  });

  it("shows partial and stops waiting when the hub rate-limits a sync control without an ID", async () => {
    render(<App />);
    const socket = await connectTestHub();
    await waitFor(() => expect(socket.sent.some((value) => JSON.parse(value).type === "sync_inventory_page")).toBe(true));
    act(() => socket.receive({ version: 1, type: "sync_inventory_page", room: ROOM, syncId: "peer-session", sender: "station-b", cursor: null, messageIds: ["older-message"], nextCursor: "older-message", hasMore: false, limitReached: false }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "sync_missing_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "error", code: "rate_limited", message: "Please wait before sending more synchronization controls." }));
    await screen.findByText(/Message sync: The hub rate-limited a synchronization control/i);
    act(() => socket.receive({ version: 1, type: "sync_page_complete", room: ROOM, syncId: "peer-session", requestId: JSON.parse(socket.sent.find((value) => JSON.parse(value).type === "sync_missing_request")!).requestId, sender: "station-b", targetSender: IDENTITY.sender, messageIds: [] }));
    await screen.findByText(/Message sync: The hub rate-limited a synchronization control/i);
  });

  it("keeps a rate-limited history request retryable when the hub error has no ID", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("history-rate-boundary", "2026-10-14T08:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "history_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "error", code: "rate_limited", message: "Please wait before requesting more history." }));
    await screen.findByText(/The hub rate-limited this history request/i);
    expect(screen.getByRole("button", { name: "Retry loading older messages" })).toBeTruthy();
  });

  it("routes sync rate rejection to sync while a history page is pending", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("overlap-sync-rate-boundary", "2026-10-14T08:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "history_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "sync_inventory_page", room: ROOM, syncId: "sync-overlap-a", sender: "station-c", cursor: null, messageIds: ["older-sync-message"], nextCursor: "older-sync-message", hasMore: false, limitReached: false }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "sync_missing_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "error", code: "sync_rate_limited", message: "Sync controls are rate-limited." }));
    await screen.findByText(/Message sync: The hub rate-limited a synchronization control/i);
    expect(screen.getByText("Loading older messages…")).toBeTruthy();
    const historyRequest = socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "history_request").at(-1)!;
    act(() => socket.receive({ version: 1, type: "history_page_complete", requestId: historyRequest.requestId, room: ROOM, messageIds: [], pageBytes: 0, nextCursor: null, hasMore: false, historyTruncated: false }));
    await screen.findByText("No more retained hub history is available.");
  });

  it("routes history rate rejection to history while a sync request is pending", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("overlap-history-rate-boundary", "2026-10-14T08:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "history_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "sync_inventory_page", room: ROOM, syncId: "sync-overlap-b", sender: "station-c", cursor: null, messageIds: ["older-sync-message"], nextCursor: "older-sync-message", hasMore: false, limitReached: false }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "sync_missing_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "error", code: "history_rate_limited", message: "History requests are rate-limited." }));
    await screen.findByText(/The hub rate-limited this history request/i);
    expect(screen.getByText(/Message sync: Exchanging bounded local message inventories/)).toBeTruthy();
    const request = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === "sync_missing_request")!;
    act(() => socket.receive({ version: 1, type: "sync_page_complete", room: ROOM, syncId: request.syncId, requestId: request.requestId, sender: "station-c", targetSender: IDENTITY.sender, messageIds: [] }));
    await screen.findByText(/Message sync: Requested pages were verified, but an inventory or page was incomplete/);
  });

  it("does not treat a legacy history rate error as sync rejection when no history request is pending", async () => {
    render(<App />);
    const socket = await connectTestHub();
    act(() => socket.receive({ version: 1, type: "sync_inventory_page", room: ROOM, syncId: "legacy-rate-session", sender: "station-c", cursor: null, messageIds: ["older-sync-message"], nextCursor: "older-sync-message", hasMore: false, limitReached: false }));
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "sync_missing_request")).toBe(true));
    act(() => socket.receive({ version: 1, type: "error", code: "rate_limited", message: "Please wait before requesting more history." }));
    expect(screen.getByText(/Message sync: Exchanging bounded local message inventories/)).toBeTruthy();
    const request = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === "sync_missing_request")!;
    act(() => socket.receive({ version: 1, type: "sync_page_complete", room: ROOM, syncId: request.syncId, requestId: request.requestId, sender: "station-c", targetSender: IDENTITY.sender, messageIds: [] }));
    await screen.findByText(/Message sync: Requested pages were verified, but an inventory or page was incomplete/);
  });

  it("does not finish an active sync response after room deletion starts", async () => {
    const accepted: StoredMessage = {
      packet: { version: 1, type: "message", id: "delete-during-sync", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Saved before deletion" },
      direction: "outgoing",
      delivery: "sent",
      transport: "hub",
    };
    await saveMessage(accepted);
    render(<App />);
    const socket = await connectTestHub();
    await waitFor(() => expect(socket.sent.some((value) => JSON.parse(value).type === "sync_inventory_page")).toBe(true));
    const inventory = JSON.parse(socket.sent.find((value) => JSON.parse(value).type === "sync_inventory_page")!);
    messageReadGate.room = ROOM;
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve([accepted]); });
    const readCount = messageReadGate.requestedRooms.length;
    act(() => socket.receive({
      version: 1,
      type: "sync_missing_request",
      room: ROOM,
      syncId: inventory.syncId,
      requestId: "delete-request",
      sender: "station-b",
      targetSender: IDENTITY.sender,
      messageIds: [accepted.packet.id],
    }));
    await waitFor(() => expect(messageReadGate.requestedRooms.length).toBeGreaterThan(readCount));
    fireEvent.click(screen.getByRole("button", { name: "Clear this device's saved conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete local messages" }));
    await screen.findByText(/were deleted from this device/i);
    messageReadGate.releaseRead?.();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    messageReadGate.pending = null;
    messageReadGate.room = null;
    const sent = socket.sent.map((value) => JSON.parse(value));
    expect(sent.some((value) => value.type === "message" && value.id === accepted.packet.id)).toBe(false);
    expect(sent.some((value) => value.type === "sync_page_complete" && value.requestId === "delete-request")).toBe(false);
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
  });

  it("preserves a call sign typed before the saved identity finishes loading", async () => {
    let finishIdentity!: (identity: LocalIdentity | null) => void;
    messageReadGate.identityPending = new Promise((resolve) => { finishIdentity = resolve; });
    render(<App />);

    const callSign = screen.getByLabelText("Your call sign") as HTMLInputElement;
    fireEvent.change(callSign, { target: { value: "Quick Station" } });
    expect(callSign.value).toBe("Quick Station");

    await act(async () => {
      finishIdentity(IDENTITY);
      await Promise.resolve();
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save and join room" }) as HTMLButtonElement).disabled).toBe(false));
    expect(callSign.value).toBe("Quick Station");
  });

  it("shows and copies only privacy-safe states and counts for the loaded room", async () => {
    const sensitive = {
      room: "private-room-code-9f2a",
      callSign: "Private Call Sign",
      sender: "sender-secret-identifier",
      hub: "ws://private-hub.example:8123/ws?token=secret",
      sdp: '{"type":"offer","sdp":"private-sdp-value"}',
      fingerprint: "sha-256 AA:BB:CC:DD private-fingerprint",
      body: "A private message body that must not be copied",
    };
    localStorage.setItem("nearlink.room", sensitive.room);
    localStorage.setItem("nearlink.hub", sensitive.hub);
    await saveMessage({
      packet: { version: 1, type: "message", id: "private-message-id", room: sensitive.room, sender: sensitive.sender, senderName: sensitive.callSign, createdAt: "2026-10-14T09:00:00.000Z", body: sensitive.body },
      direction: "incoming",
      delivery: "queued",
    });
    await saveMessage({
      packet: { version: 1, type: "message", id: "other-room-private-id", room: "other-private-room", sender: sensitive.sender, senderName: sensitive.callSign, createdAt: "2026-10-14T10:00:00.000Z", body: "Other room body" },
      direction: "outgoing",
      delivery: "sent",
    });
    await Promise.all([loadIdentity(), loadMessages(sensitive.room), isRoomMessagesDeleted(sensitive.room)]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error(`Private clipboard failure ${sensitive.fingerprint}`)) },
    });
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    await screen.findByText(sensitive.body);

    const details = screen.getByText("Connection diagnostics").closest("details")!;
    fireEvent.click(screen.getByText("Connection diagnostics"));
    await screen.findByText("Messages", { selector: "dt" });
    expect(within(details).getAllByText("1", { selector: "dd" })).toHaveLength(2);
    expect(within(details).getByText("Queued", { selector: "dt" })).toBeTruthy();
    fireEvent.click(within(details).getByRole("button", { name: "Copy diagnostics summary" }));
    const fallback = await within(details).findByLabelText("Copy this summary manually");
    expect(within(details).getByText("Clipboard access failed. Copy the summary from the text box below.")).toBeTruthy();
    const summaryText = (fallback as HTMLTextAreaElement).value;
    for (const value of Object.values(sensitive)) {
      expect(summaryText).not.toContain(value);
      expect(details.textContent).not.toContain(value);
    }
    expect(summaryText).toContain("Messages: 1");
    expect(summaryText).toContain("Queued: 1");
    expect(summaryText).not.toContain("Other room body");

    messageReadGate.room = "next-room";
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve([]); });
    const nextRoomReadCount = messageReadGate.requestedRooms.length;
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "next-room" } });
    await within(details).findByText("Unavailable while the selected conversation loads or changes", { selector: "dd" });
    await waitFor(() => expect(messageReadGate.requestedRooms.slice(nextRoomReadCount)).toContain("next-room"));
    expect(within(details).queryByText("1", { selector: "dd" })).toBeNull();
    expect(within(details).queryByLabelText("Copy this summary manually")).toBeNull();
    expect(within(details).queryByText("Clipboard access failed. Copy the summary from the text box below.")).toBeNull();
    await within(details).findByText("Diagnostics changed. Copy the updated summary if needed.");
    await act(async () => {
      messageReadGate.releaseRead?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("requires confirmation, clears only this room on this device, and closes live room transport", async () => {
    const localMessage = {
      packet: { version: 1 as const, type: "message" as const, id: "saved-local", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Saved locally" },
      direction: "outgoing" as const,
      delivery: "queued" as const,
      transport: "hub" as const,
    };
    const otherRoomMessage = { ...localMessage, packet: { ...localMessage.packet, id: "other-room", room: "another-room", body: "Keep this room" } };
    await saveMessage(localMessage);
    await saveMessage(otherRoomMessage);
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await screen.findByText("Saved locally", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    fireEvent.click(screen.getByRole("button", { name: "Clear this device's saved conversation" }));
    const confirmation = screen.getByRole("dialog", { name: `Clear saved messages for ${ROOM}?` });
    const opener = screen.getByRole("button", { name: "Clear this device's saved conversation" });
    opener.focus();
    expect((confirmation as HTMLDialogElement).open).toBe(true);
    fireEvent(confirmation, new Event("cancel", { bubbles: false, cancelable: true }));
    await waitFor(() => expect((confirmation as HTMLDialogElement).open).toBe(false));
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    const reopenedConfirmation = screen.getByRole("dialog", { name: `Clear saved messages for ${ROOM}?` });
    expect(reopenedConfirmation.textContent).toMatch(/only on this device/i);
    expect(reopenedConfirmation.textContent).toMatch(/identity and settings stay saved/i);
    expect(reopenedConfirmation.textContent).toMatch(/hub's retained history is not affected and may appear again after you reconnect/i);
    expect(await loadMessages(ROOM)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep messages" }));
    expect(await loadMessages(ROOM)).toHaveLength(1);

    messageReadGate.room = ROOM;
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve([]); });
    const inFlightReplay = { version: 1, type: "message", id: "late-replay", room: ROOM, sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T10:00:00.000Z", body: "Late hub replay" };
    const readCountBeforeReplay = messageReadGate.requestedRooms.length;
    act(() => socket.receive(inFlightReplay));
    await waitFor(() => expect(messageReadGate.requestedRooms.length).toBeGreaterThan(readCountBeforeReplay));
    fireEvent.click(screen.getByRole("button", { name: "Clear this device's saved conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete local messages" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByText(/were deleted from this device/i)).toBeNull();
    messageReadGate.releaseRead?.();
    await screen.findByText(/were deleted from this device/i);
    await waitFor(() => expect(socket.readyState).toBe(MockWebSocket.CLOSED));
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(document.activeElement).toBe(screen.getByText(/Saved and queued messages for this room were deleted/).closest('[role="status"]'));
    expect(await loadMessages("another-room")).toMatchObject([otherRoomMessage]);
    expect(await loadIdentity()).toEqual(IDENTITY);
    expect(localStorage.getItem("nearlink.room")).toBe(ROOM);
    expect(localStorage.getItem("nearlink.hub")).toBe("ws://localhost:8000/ws");

    act(() => socket.receive({ ...inFlightReplay, id: "post-delete-replay" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(screen.queryByText("Late hub replay")).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);

    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(await isRoomMessagesDeleted(ROOM)).toBe(false);
    act(() => MockWebSocket.instances[1].open());
    act(() => MockWebSocket.instances[1].receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
  });

  it("notifies another open tab and blocks its stale replay from restoring the cleared room", async () => {
    const saved = {
      packet: { version: 1 as const, type: "message" as const, id: "shared-message", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Shared local history" },
      direction: "incoming" as const,
      delivery: "sent" as const,
      transport: "hub" as const,
    };
    await saveMessage(saved);
    await expect(Promise.all([loadIdentity(), loadMessages(ROOM), isRoomMessagesDeleted(ROOM)])).resolves.toMatchObject([IDENTITY, [saved], false]);
    const firstTab = render(<App />);
    await waitFor(() => expect((within(firstTab.container).getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await within(firstTab.container).findByText("Shared local history", {}, { timeout: 5000 });
    const secondTab = render(<App />);
    await waitFor(() => expect((within(secondTab.container).getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await within(secondTab.container).findByText("Shared local history", {}, { timeout: 5000 });

    fireEvent.click(within(firstTab.container).getByRole("button", { name: "Connect radio" }));
    fireEvent.click(within(secondTab.container).getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    act(() => { firstSocket.open(); secondSocket.open(); });
    act(() => {
      firstSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 });
      secondSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 });
    });

    fireEvent.click(within(firstTab.container).getByRole("button", { name: "Clear this device's saved conversation" }));
    fireEvent.click(within(firstTab.container).getByRole("button", { name: "Delete local messages" }));
    await within(firstTab.container).findByText(/were deleted from this device/i);
    await within(secondTab.container).findByText(/deleted from this device in another tab/i);
    await waitFor(() => expect(secondSocket.readyState).toBe(MockWebSocket.CLOSED));
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(await saveMessage({ ...saved, packet: { ...saved.packet, id: "stale-cross-tab-replay", body: "Late replay" } })).toBe(false);
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(within(secondTab.container).queryByText("Shared local history")).toBeNull();
  });

  it("does not let a tab resume or reconnect while another tab is deleting the room", async () => {
    await saveMessage({
      packet: { version: 1, type: "message", id: "before-delete", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "History to clear" },
      direction: "incoming",
      delivery: "sent",
      transport: "hub",
    });
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await screen.findByText("History to clear", {}, { timeout: 5000 });

    const externalTab = new MockBroadcastChannel("nearlink-room-deletion-v1");
    messageReadGate.resumeRoom = ROOM;
    messageReadGate.resumePending = new Promise<void>((resolve) => { messageReadGate.releaseResume = resolve; });
    fireEvent.submit(screen.getByRole("button", { name: "Save and join room" }).closest("form")!);
    await waitFor(() => expect(messageReadGate.resumeStarted).toBe(true));
    await beginRoomDeletion(ROOM);
    externalTab.postMessage({ version: 1, type: "deleting", room: ROOM, sender: "other-tab" });
    await screen.findByText("Another open tab is clearing this room's local messages.");

    fireEvent.click(screen.getByText("Optional advanced path: manual direct peer setup"));
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    expect((screen.getByRole("button", { name: "Save and join room" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
    expect(await loadMessages(ROOM)).toHaveLength(1);

    await deleteRoomMessages(ROOM);
    expect(await loadMessages(ROOM)).toEqual([]);
    externalTab.postMessage({ version: 1, type: "deleted", room: ROOM, sender: "other-tab" });
    await screen.findByText(/deleted from this device in another tab/i);
    await act(async () => {
      messageReadGate.releaseResume?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(isRoomMessagesDeleted(ROOM)).resolves.toBe(true));
    expect(await loadMessages(ROOM)).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(0);
    externalTab.close();
  });

  it("keeps a room locked and offers retry when failed deletion cannot clear its marker", async () => {
    const saved = {
      packet: { version: 1 as const, type: "message" as const, id: "locked-message", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Must remain saved" },
      direction: "incoming" as const,
      delivery: "sent" as const,
      transport: "hub" as const,
    };
    await saveMessage(saved);
    messageReadGate.failDeleteRoomMessages = true;
    messageReadGate.failCancelRoomDeletion = true;
    render(<App />);
    await screen.findByText("Must remain saved");

    fireEvent.click(screen.getByRole("button", { name: "Clear this device's saved conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete local messages" }));
    await screen.findByText(/room remains locked on this device/i);
    expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
    expect(await loadMessages(ROOM)).toMatchObject([saved]);
    expect((screen.getByRole("button", { name: "Clear this device's saved conversation" }) as HTMLButtonElement).disabled).toBe(false);

    messageReadGate.failDeleteRoomMessages = false;
    messageReadGate.failCancelRoomDeletion = false;
    fireEvent.click(screen.getByRole("button", { name: "Clear this device's saved conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete local messages" }));
    await screen.findByText(/were deleted from this device/i);
    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
    expect(await loadMessages(ROOM)).toEqual([]);
  });

  it("ignores a delayed cancellation reload after a newer deletion event", async () => {
    const saved = {
      packet: { version: 1 as const, type: "message" as const, id: "stale-cancel-message", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Saved before delayed reload" },
      direction: "incoming" as const,
      delivery: "sent" as const,
      transport: "hub" as const,
    };
    await saveMessage(saved);
    render(<App />);
    await screen.findByText(saved.packet.body);
    const externalTab = new MockBroadcastChannel("nearlink-room-deletion-v1");
    messageReadGate.room = ROOM;
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve([]); });
    const readCountBeforeCancel = messageReadGate.requestedRooms.length;

    externalTab.postMessage({ version: 1, type: "cancelled", room: ROOM, sender: "other-tab" });
    await waitFor(() => expect(messageReadGate.requestedRooms.length).toBeGreaterThan(readCountBeforeCancel));
    externalTab.postMessage({ version: 1, type: "deleting", room: ROOM, sender: "other-tab" });
    await screen.findByText("Another open tab is clearing this room's local messages.");
    await beginRoomDeletion(ROOM);
    await deleteRoomMessages(ROOM);
    externalTab.postMessage({ version: 1, type: "deleted", room: ROOM, sender: "other-tab" });
    await screen.findByText(/deleted from this device in another tab/i);

    await act(async () => {
      messageReadGate.releaseRead?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Saved messages are shown again/i)).toBeNull();
    expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(await isRoomMessagesDeleted(ROOM)).toBe(true);
    expect(await loadMessages(ROOM)).toEqual([]);
    externalTab.close();
  });

  it("ignores a delayed cancellation reload after switching rooms", async () => {
    const saved = {
      packet: { version: 1 as const, type: "message" as const, id: "old-room-message", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Old room history" },
      direction: "incoming" as const,
      delivery: "sent" as const,
      transport: "hub" as const,
    };
    await saveMessage(saved);
    render(<App />);
    await screen.findByText(saved.packet.body);
    const externalTab = new MockBroadcastChannel("nearlink-room-deletion-v1");
    messageReadGate.room = ROOM;
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve([saved]); });
    const readCountBeforeCancel = messageReadGate.requestedRooms.length;

    externalTab.postMessage({ version: 1, type: "cancelled", room: ROOM, sender: "other-tab" });
    await waitFor(() => expect(messageReadGate.requestedRooms.length).toBeGreaterThan(readCountBeforeCancel));
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "different-room" } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false));

    await act(async () => {
      messageReadGate.releaseRead?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("Old room history")).toBeNull();
    expect(screen.queryByText(/The other tab could not delete the conversation/i)).toBeNull();
    expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false);
    externalTab.close();
  });

  it("fails closed with an accessible action when Rust protocol checks cannot load", async () => {
    wasmGate.fail = true;
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/will not connect, send messages, or accept peer packets/i);
    expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Hub not reachable yet")).toBeNull();
    fireEvent.click(screen.getByText("Optional advanced path: manual direct peer setup"));
    expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(0));
    expect(await loadMessages(ROOM)).toHaveLength(0);
  });

  it("persists offline messages, replays the same id, records acknowledgments, and deduplicates inbound messages", async () => {
    render(<App />);

    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false));
    const draft = screen.getByRole("textbox", { name: "Write a message" });
    fireEvent.change(draft, { target: { value: "Meet at the north gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Queued on this device");
    let stored = await loadMessages(ROOM);
    expect(stored).toHaveLength(1);
    expect(stored[0].delivery).toBe("queued");
    const originalPacket = stored[0].packet;

    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    expect(JSON.parse(firstSocket.sent[0])).toMatchObject({ type: "join", room: ROOM, sender: IDENTITY.sender });
    act(() => firstSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect radio" }));
    await screen.findByText("Standby");
    await waitFor(() => expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED));

    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 2 }));

    await waitFor(() => expect(reconnectSocket.sent).toHaveLength(2));
    const replayedPacket = JSON.parse(reconnectSocket.sent[1]);
    expect(replayedPacket).toEqual(originalPacket);
    expect(replayedPacket.id).toBe(originalPacket.id);

    act(() => reconnectSocket.receive({ version: 1, type: "ack", id: originalPacket.id }));
    await screen.findByText("Accepted by hub");
    stored = await loadMessages(ROOM);
    expect(stored.find((item) => item.packet.id === originalPacket.id)?.delivery).toBe("sent");

    const inbound = {
      version: 1,
      type: "message",
      id: "peer-message-1",
      room: ROOM,
      sender: "station-b",
      senderName: "Bea",
      createdAt: "2026-10-14T10:00:00.000Z",
      body: "I am nearby",
    };
    act(() => {
      reconnectSocket.receive(inbound);
      reconnectSocket.receive(inbound);
    });
    await screen.findByText("I am nearby");
    await waitFor(async () => {
      const messages = await loadMessages(ROOM);
      expect(messages.filter((item: StoredMessage) => item.packet.id === inbound.id)).toHaveLength(1);
    });
    expect(document.querySelectorAll(".message-incoming")).toHaveLength(1);
  });

  it("replays queued hub messages one at a time and waits between exact acknowledgments", async () => {
    const first = hubMessage("queued-replay-first", "2026-10-15T08:00:00.000Z", "First queued message");
    const second = hubMessage("queued-replay-second", "2026-10-15T08:00:01.000Z", "Second queued message");
    await saveMessage({ packet: first, direction: "outgoing", delivery: "queued", transport: "hub" });
    await saveMessage({ packet: second, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    const socket = await connectTestHub(false);
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1])).toEqual(first);
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    expect((await loadMessages(ROOM)).filter((item) => item.direction === "outgoing").map((item) => item.delivery)).toEqual(["queued", "queued"]);

    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    act(() => socket.receive({ version: 1, type: "ack", id: second.id }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === second.id)?.delivery).toBe("queued");
    act(() => {
      socket.receive({ version: 1, type: "ack", id: first.id });
      socket.receive({ version: 1, type: "ack", id: first.id });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(2));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual(second);
    expect(socket.sentAt[2] - socket.sentAt[1]).toBeGreaterThanOrEqual(550);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === second.id)?.delivery).toBe("queued");

    act(() => {
      socket.receive({ version: 1, type: "ack", id: second.id });
      socket.receive({ version: 1, type: "ack", id: second.id });
    });
    await waitFor(async () => expect((await loadMessages(ROOM)).every((item) => item.delivery === "sent")).toBe(true));
  });

  it("refills persisted hub replay in bounded batches", async () => {
    const packets = Array.from({ length: 65 }, (_, index) => hubMessage(
      `bounded-replay-${String(index + 1).padStart(2, "0")}`,
      `2026-10-15T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    ));
    for (const packet of packets) await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    const socket = await connectTestHub(false);
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1));
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => { now += 600; return now; });
    const actualStorage = await vi.importActual<typeof import("./lib/storage")>("./lib/storage");
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Saved during partial batch" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(async () => expect((await actualStorage.loadMessages(ROOM)).some((item) => item.packet.body === "Saved during partial batch")).toBe(true));
    const savedDuringBatch = await actualStorage.loadMessages(ROOM);
    const liveDuringBatch = savedDuringBatch.find((item) => item.packet.body === "Saved during partial batch")!;
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    for (let index = 0; index < packets.length - 2; index += 1) {
      act(() => socket.receive({ version: 1, type: "ack", id: packets[index].id }));
      await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(index + 2), { timeout: 2000 });
      expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message").at(-1)!).id).toBe(packets[index + 1].id);
    }
    const roomReadsBeforeRefill = messageReadGate.requestedRooms.filter((room) => room === ROOM).length;
    messageReadGate.room = ROOM;
    messageReadGate.readGateAfter = roomReadsBeforeRefill + 1;
    let releaseRefill!: (rows: StoredMessage[]) => void;
    messageReadGate.pending = new Promise<StoredMessage[]>((resolve) => { releaseRefill = resolve; });
    act(() => socket.receive({ version: 1, type: "ack", id: packets[63].id }));
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((room) => room === ROOM).length).toBeGreaterThan(roomReadsBeforeRefill));
    const refillSnapshot = await actualStorage.loadMessages(ROOM);

    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Saved while replay refills" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(64);
    await waitFor(async () => expect((await actualStorage.loadMessages(ROOM)).some((item) => item.packet.body === "Saved while replay refills")).toBe(true));
    const savedDuringRefill = await actualStorage.loadMessages(ROOM);
    const live = savedDuringRefill.find((item) => item.packet.body === "Saved while replay refills")!;
    expect(live).toBeTruthy();
    messageReadGate.pending = null;
    messageReadGate.room = null;
    releaseRefill(refillSnapshot);
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(65));
    expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message").at(-1)!).id).toBe(packets[64].id);
    act(() => socket.receive({ version: 1, type: "ack", id: packets[64].id }));
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(66));
    expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message").at(-1)!).id).toBe(liveDuringBatch.packet.id);
    act(() => socket.receive({ version: 1, type: "ack", id: liveDuringBatch.packet.id }));
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(67));
    expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message").at(-1)!).id).toBe(live.packet.id);
    const saved = await loadMessages(ROOM);
    expect(saved.find((item) => item.packet.id === liveDuringBatch.packet.id)?.delivery).toBe("sent");
    expect(saved.find((item) => item.packet.id === live.packet.id)?.delivery).toBe("queued");
  }, 45000);

  it("does not refill an invalid queued hub message repeatedly on one socket", async () => {
    const invalidPacket = { ...hubMessage("invalid-queued-replay", "2026-10-15T08:04:00.000Z"), sender: "!" };
    await saveMessage({ packet: invalidPacket as MessagePacket, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    const readsBeforeJoin = messageReadGate.requestedRooms.filter((room) => room === ROOM).length;
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((room) => room === ROOM).length).toBeGreaterThanOrEqual(readsBeforeJoin + 2));
    const readsAfterReject = messageReadGate.requestedRooms.filter((room) => room === ROOM).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(messageReadGate.requestedRooms.filter((room) => room === ROOM).length).toBe(readsAfterReject);
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(0);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === invalidPacket.id)?.delivery).toBe("queued");
  });

  it("reconnects and replays after the initial hub outbox load fails", async () => {
    const packet = hubMessage("replay-after-load-failure", "2026-10-15T08:04:30.000Z");
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    messageReadGate.failNextMessageLoads = 1;
    act(() => firstSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));

    await waitFor(() => expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 5000 });
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));

    await waitFor(() => expect(reconnectSocket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1));
    expect(JSON.parse(reconnectSocket.sent.filter((raw) => JSON.parse(raw).type === "message")[0])).toEqual(packet);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === packet.id)?.delivery).toBe("queued");
  });

  it("refills a live persisted send deferred by a full 64-entry batch", async () => {
    const packets = Array.from({ length: 64 }, (_, index) => hubMessage(
      `full-batch-${String(index + 1).padStart(2, "0")}`,
      `2026-10-15T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    ));
    for (const packet of packets) await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    const socket = await connectTestHub(false);
    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1));
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => { now += 600; return now; });
    const actualStorage = await vi.importActual<typeof import("./lib/storage")>("./lib/storage");
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Deferred at full capacity" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(async () => expect((await actualStorage.loadMessages(ROOM)).some((item) => item.packet.body === "Deferred at full capacity")).toBe(true));
    const deferred = (await actualStorage.loadMessages(ROOM)).find((item) => item.packet.body === "Deferred at full capacity")!;

    for (let index = 0; index < packets.length; index += 1) {
      act(() => socket.receive({ version: 1, type: "ack", id: packets[index].id }));
      await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(index + 2), { timeout: 2000 });
      expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message").at(-1)!).id).toBe(index + 1 < packets.length ? packets[index + 1].id : deferred.packet.id);
    }
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === deferred.packet.id)?.delivery).toBe("queued");
  }, 15000);

  it("preserves messages enqueued while persisted replay rows are still loading", async () => {
    const first = hubMessage("replay-load-race-first", "2026-10-15T08:00:10.000Z", "Saved before join");
    await saveMessage({ packet: first, direction: "outgoing", delivery: "queued", transport: "hub" });
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    const roomReadsBeforeJoin = messageReadGate.requestedRooms.filter((room) => room === ROOM).length;
    messageReadGate.room = ROOM;
    messageReadGate.readGateAfter = roomReadsBeforeJoin + 1;
    let releaseReplayLoad!: (rows: StoredMessage[]) => void;
    messageReadGate.pending = new Promise<StoredMessage[]>((resolve) => { releaseReplayLoad = resolve; });
    messageReadGate.releaseRead = (rows = []) => releaseReplayLoad(rows);
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));

    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Queued during replay load" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getAllByText("Queued on this device")).toHaveLength(2));
    const actualStorage = await vi.importActual<typeof import("./lib/storage")>("./lib/storage");
    const savedRows = await actualStorage.loadMessages(ROOM);
    const live = savedRows.find((item) => item.packet.body === "Queued during replay load")!;
    expect(live).toBeTruthy();
    releaseReplayLoad(savedRows);

    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1])).toEqual(first);
    act(() => socket.receive({ version: 1, type: "ack", id: first.id }));
    await waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2])).toEqual(live.packet);
  });

  it("keeps a rate-limited replay queued and stops later messages on that connection", async () => {
    const first = hubMessage("rate-limited-replay-first", "2026-10-15T08:01:00.000Z");
    const second = hubMessage("rate-limited-replay-second", "2026-10-15T08:01:01.000Z");
    await saveMessage({ packet: first, direction: "outgoing", delivery: "queued", transport: "hub" });
    await saveMessage({ packet: second, direction: "outgoing", delivery: "queued", transport: "hub" });

    render(<App />);
    const socket = await connectTestHub(false);
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    act(() => socket.receive({ version: 1, type: "error", code: "rate_limited", message: "Message rate limit reached.", id: first.id }));
    await screen.findByText(/rate-limited an outgoing message/i);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rows = await loadMessages(ROOM);
    expect(rows.find((item) => item.packet.id === first.id)?.delivery).toBe("queued");
    expect(rows.find((item) => item.packet.id === second.id)?.delivery).toBe("queued");
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(1);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 5000 });
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await waitFor(() => expect(reconnectSocket.sent).toHaveLength(2));
    expect(JSON.parse(reconnectSocket.sent[1]).id).toBe(first.id);
  }, 15000);

  it("retries a definitively rejected hub message on the same open socket", async () => {
    const packet = hubMessage("same-socket-retry", "2026-10-15T08:01:30.000Z");
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });
    render(<App />);
    const socket = await connectTestHub(false);
    await waitFor(() => expect(socket.sent).toHaveLength(2));

    act(() => socket.receive({ version: 1, type: "error", code: "capacity_reached", message: "Room capacity reached.", id: packet.id }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === packet.id)?.delivery).toBe("failed");
    fireEvent.click(retry);

    await waitFor(() => expect(socket.sent.filter((raw) => JSON.parse(raw).type === "message")).toHaveLength(2), { timeout: 3000 });
    expect(JSON.parse(socket.sent.filter((raw) => JSON.parse(raw).type === "message")[1])).toEqual(packet);
  });

  it("reconnects after a missing hub acknowledgment and retries the same queued ID", async () => {
    const packet = hubMessage("ack-timeout-replay", "2026-10-15T08:02:00.000Z");
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });
    render(<App />);
    const firstSocket = await connectTestHub(false);
    await waitFor(() => expect(firstSocket.sent).toHaveLength(2));
    expect(JSON.parse(firstSocket.sent[1])).toEqual(packet);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10_100)); });
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === packet.id)?.delivery).toBe("queued");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 5000 });
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await waitFor(() => expect(reconnectSocket.sent).toHaveLength(2));
    expect(JSON.parse(reconnectSocket.sent[1])).toEqual(packet);
    expect(JSON.parse(reconnectSocket.sent[1]).id).toBe(packet.id);
  }, 25000);

  it("reconnects with the same queued ID when its exact ACK status write fails", async () => {
    const packet = hubMessage("ack-storage-failure", "2026-10-15T08:03:00.000Z");
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });
    render(<App />);
    const firstSocket = await connectTestHub(false);
    await waitFor(() => expect(firstSocket.sent).toHaveLength(2));
    messageReadGate.deliveryUpdateId = packet.id;
    messageReadGate.deliveryUpdateReject = true;
    messageReadGate.deliveryUpdatePending = new Promise<void>((resolve) => { messageReadGate.releaseDeliveryUpdate = resolve; });
    act(() => firstSocket.receive({ version: 1, type: "ack", id: packet.id }));
    await waitFor(() => expect(messageReadGate.deliveryUpdateStarted).toBe(true));
    messageReadGate.releaseDeliveryUpdate?.();
    await screen.findByText(/status could not be saved on this device/i);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === packet.id)?.delivery).toBe("queued");

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 5000 });
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await waitFor(() => expect(reconnectSocket.sent).toHaveLength(2));
    expect(JSON.parse(reconnectSocket.sent[1])).toEqual(packet);
  }, 15000);

  it("loads retained history page by page in hub order rather than timestamp order", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("history-boundary", "2026-10-14T08:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1)!).type).toBe("history_request"));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ cursor: boundary.id, room: ROOM });
    const newestFirst = [
      hubMessage("page-one-newest", "2026-10-14T07:00:00.000Z"),
      hubMessage("page-one-oldest", "2026-10-14T23:00:00.000Z"),
    ];
    act(() => { socket.receive(newestFirst[0]); socket.receive(newestFirst[1]); sendHistoryCompletion(socket, newestFirst, "page-one-oldest", true); });
    await screen.findByText(newestFirst[1].body);
    await waitFor(async () => expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual([
      "page-one-oldest", "page-one-newest", "history-boundary",
    ]));

    await screen.findByRole("button", { name: "Load older messages" });
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1)!).cursor).toBe("page-one-oldest"));
    const secondPage = [
      hubMessage("page-two-newest", "2026-10-14T06:00:00.000Z"),
      hubMessage("page-two-oldest", "2026-10-14T22:00:00.000Z"),
    ];
    act(() => { socket.receive(secondPage[0]); socket.receive(secondPage[1]); sendHistoryCompletion(socket, secondPage, null, false); });
    await screen.findByText(secondPage[1].body);
    await waitFor(async () => expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual([
      "page-two-oldest", "page-two-newest", "page-one-oldest", "page-one-newest", "history-boundary",
    ]));
    await screen.findByText("No more retained hub history is available.");
  });

  it("resets unsupported history paging when joining a different hub URL", async () => {
    render(<App />);
    const oldHub = await connectTestHub();
    const oldBoundary = hubMessage("old-hub-boundary", "2026-10-14T10:00:00.000Z");
    act(() => oldHub.receive(oldBoundary));
    await screen.findByText(oldBoundary.body);

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(oldHub.sent.at(-1)!).type).toBe("history_request"));
    act(() => oldHub.receive({ version: 1, type: "error", code: "invalid_packet", message: "History pages are unavailable." }));
    await screen.findByText(/This hub does not support older history pages/);

    fireEvent.change(screen.getByLabelText("Hub address"), { target: { value: "ws://new-hub.local:8000/ws" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const newHub = MockWebSocket.instances[1];
    act(() => newHub.open());
    act(() => newHub.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
    const newBoundary = hubMessage("new-hub-boundary", "2026-10-14T11:00:00.000Z");
    act(() => newHub.receive(newBoundary));
    await screen.findByText(newBoundary.body);

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(newHub.sent.at(-1)!).type).toBe("history_request"));
    expect(JSON.parse(newHub.sent.at(-1)!)).toMatchObject({ type: "history_request", cursor: oldBoundary.id, room: ROOM });
  });

  it("repairs legacy hub order from join replay while preserving direct message order", async () => {
    const replayedLater: StoredMessage = {
      packet: hubMessage("legacy-hub-later", "2026-10-14T08:00:00.000Z"),
      direction: "incoming", delivery: "sent", transport: "hub", displayOrder: 0,
    };
    const direct: StoredMessage = {
      packet: { ...hubMessage("direct-between-hub-rows", "2026-10-14T09:00:00.000Z"), sender: IDENTITY.sender, senderName: IDENTITY.senderName },
      direction: "incoming", delivery: "sent", transport: "direct", displayOrder: 1,
    };
    const replayedEarlier: StoredMessage = {
      packet: hubMessage("legacy-hub-earlier", "2026-10-14T22:00:00.000Z"),
      direction: "incoming", delivery: "sent", transport: "hub", displayOrder: 2,
    };
    await saveMessage(replayedLater);
    await saveMessage(direct);
    await saveMessage(replayedEarlier);
    messageReadGate.reconcilePendingId = replayedEarlier.packet.id;
    messageReadGate.reconcilePending = new Promise((resolve) => { messageReadGate.releaseReconcile = resolve; });

    render(<App />);
    const socket = await connectTestHub(false);
    await screen.findByText(replayedLater.packet.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1)!).type).toBe("history_request"));
    act(() => {
      socket.receive(replayedEarlier.packet);
      socket.receive(replayedLater.packet);
      socket.receive({ version: 1, type: "presence", room: ROOM, peers: 1 });
      socket.receive({ version: 1, type: "error", code: "history_page_too_large", message: "Retry with a smaller page." });
    });
    await waitFor(() => expect(messageReadGate.reconcileStarted).toBe(true));
    act(() => messageReadGate.releaseReconcile?.());
    await screen.findByText(replayedEarlier.packet.body);
    await waitFor(async () => expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual([
      replayedEarlier.packet.id,
      direct.packet.id,
      replayedLater.packet.id,
    ]));
  });

  it("does not apply a delayed replay reload after switching rooms", async () => {
    const replay: StoredMessage = {
      packet: hubMessage("delayed-room-replay", "2026-10-14T10:00:00.000Z", "Old room replay"),
      direction: "incoming", delivery: "sent", transport: "hub",
    };
    await saveMessage(replay);
    render(<App />);
    const socket = await connectTestHub();
    await screen.findByText(replay.packet.body);
    const staleRows = await loadMessages(ROOM);
    messageReadGate.requestedRooms = [];
    messageReadGate.room = ROOM;
    messageReadGate.readGateAfter = 1;
    messageReadGate.pending = new Promise((resolve) => { messageReadGate.releaseRead = () => resolve(staleRows); });

    act(() => socket.receive(replay.packet));
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((requestedRoom) => requestedRoom === ROOM)).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "next-room" } });
    await screen.findByRole("log", { name: "Messages in next-room" });
    await waitFor(() => expect((screen.getByLabelText("Room frequency") as HTMLInputElement).value).toBe("next-room"));

    act(() => messageReadGate.releaseRead?.());
    await waitFor(() => expect(screen.queryByText(replay.packet.body)).toBeNull());
    expect((await loadMessages("next-room")).map((item) => item.packet.id)).toEqual([]);
  });

  it("serializes history completion with live traffic and retries a failed page at the same cursor", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("overlap-boundary", "2026-10-14T10:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1)!).type).toBe("history_request"));
    const originalRequest = JSON.parse(socket.sent.at(-1)!);
    const page = [hubMessage("retry-page-new", "2026-10-14T09:00:00.000Z"), hubMessage("retry-page-old", "2026-10-14T11:00:00.000Z")];
    const live = hubMessage("live-during-page", "2026-10-14T01:00:00.000Z");
    messageReadGate.failNextSaveIds.push(page[0].id);
    act(() => { socket.receive(page[0]); socket.receive(page[1]); socket.receive(live); sendHistoryCompletion(socket, page, page[1].id, true); });
    await screen.findByRole("button", { name: "Retry loading older messages" });
    expect(JSON.parse(socket.sent.filter((item) => JSON.parse(item).type === "history_request")[0]).cursor).toBe(originalRequest.cursor);
    expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual(["overlap-boundary", "retry-page-old", "live-during-page"]);

    fireEvent.click(screen.getByRole("button", { name: "Retry loading older messages" }));
    await waitFor(() => expect(socket.sent.filter((item) => JSON.parse(item).type === "history_request")).toHaveLength(2));
    expect(JSON.parse(socket.sent.filter((item) => JSON.parse(item).type === "history_request")[1]).cursor).toBe(originalRequest.cursor);
    act(() => { socket.receive(page[0]); socket.receive(page[1]); sendHistoryCompletion(socket, page, page[1].id, true); });
    await screen.findByText(page[0].body);
    await waitFor(async () => expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual([
      "retry-page-old", "retry-page-new", "overlap-boundary", "live-during-page",
    ]));
    expect(document.querySelectorAll(".message-incoming")).toHaveLength(4);
  });

  it("does not advance history after the room deletion tombstone blocks a page", async () => {
    render(<App />);
    const socket = await connectTestHub();
    const boundary = hubMessage("tombstone-boundary", "2026-10-14T10:00:00.000Z");
    act(() => socket.receive(boundary));
    await screen.findByText(boundary.body);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1)!).type).toBe("history_request"));
    const page = [hubMessage("tombstone-page", "2026-10-14T09:00:00.000Z")];
    await beginRoomDeletion(ROOM);
    act(() => { socket.receive(page[0]); sendHistoryCompletion(socket, page, page[0].id, true); });
    await screen.findByRole("button", { name: "Retry loading older messages" });
    expect((await loadMessages(ROOM)).map((item) => item.packet.id)).toEqual(["tombstone-boundary"]);
    expect(socket.sent.filter((item) => JSON.parse(item).type === "history_request")).toHaveLength(1);
  });

  it("retries an inbound hub replay after local save fails", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    const replay = {
      version: 1,
      type: "message",
      id: "retry-after-save-failure",
      room: ROOM,
      sender: "station-b",
      senderName: "Bea",
      createdAt: "2026-10-14T10:00:00.000Z",
      body: "Retry this stored replay",
    };
    messageReadGate.failNextSaveIds.push(replay.id);
    act(() => socket.receive(replay));
    await screen.findByText(/A hub message could not be saved or checked/);

    expect(await loadMessages(ROOM)).toEqual([]);
    expect(screen.queryByText(replay.body)).toBeNull();
    act(() => socket.receive(replay));
    await screen.findByText(replay.body);
    const stored = await loadMessages(ROOM);
    expect(stored.filter((item) => item.packet.id === replay.id)).toHaveLength(1);
    expect(messageReadGate.saveAttempts.get(replay.id)).toBe(2);
    expect(screen.queryByText(/A hub message could not be saved or checked/)).toBeNull();
  });

  it("treats exact hub replay duplicates as idempotent from IndexedDB", async () => {
    const replay: StoredMessage = {
      packet: {
        version: 1,
        type: "message",
        id: "already-stored-replay",
        room: ROOM,
        sender: "station-b",
        senderName: "Bea",
        createdAt: "2026-10-14T10:00:00.000Z",
        body: "Already saved by the first replay",
      },
      direction: "incoming",
      delivery: "sent",
      transport: "hub",
    };
    await saveMessage(replay);
    messageReadGate.saveAttempts.clear();
    render(<App />);
    await screen.findByText(replay.packet.body);
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    messageReadGate.requestedRooms = [];
    act(() => {
      socket.receive(replay.packet);
      socket.receive(replay.packet);
    });
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((room) => room === ROOM).length).toBeGreaterThanOrEqual(2));

    expect(await loadMessages(ROOM)).toMatchObject([replay]);
    expect(document.querySelectorAll(".message-incoming")).toHaveLength(1);
  });

  it("keeps saved content when a replay reuses its ID with conflicting content", async () => {
    const saved: StoredMessage = {
      packet: {
        version: 1,
        type: "message",
        id: "conflicting-replay-id",
        room: ROOM,
        sender: "station-b",
        senderName: "Bea",
        createdAt: "2026-10-14T10:00:00.000Z",
        body: "Original persisted content",
      },
      direction: "incoming",
      delivery: "sent",
      transport: "hub",
    };
    await saveMessage(saved);
    messageReadGate.saveAttempts.clear();
    render(<App />);
    await screen.findByText(saved.packet.body);
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    act(() => socket.receive({ ...saved.packet, body: "Different replay content" }));
    await screen.findByText(/conflicts with saved message content/);

    expect(await loadMessages(ROOM)).toMatchObject([saved]);
    expect(screen.getByText(saved.packet.body)).toBeTruthy();
    expect(screen.queryByText("Different replay content")).toBeNull();
    expect(messageReadGate.saveAttempts.get(saved.packet.id) ?? 0).toBe(1);
  });

  it("warns when the hub reports truncated replay history", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1, historyTruncated: true }));

    expect(await screen.findByText(/could not replay the full room history/)).toBeTruthy();
  });

  it("does not offer an impossible retry for a hub message ID conflict", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Send this once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Queued on this device");
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    const outgoing = JSON.parse(socket.sent[1]);
    act(() => socket.receive({
      version: 1,
      type: "error",
      code: "message_conflict",
      message: "This message ID was already used for different content.",
      id: outgoing.id,
    }));

    expect(await screen.findByText(/Compose a new message to send with a new ID/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    const stored = await loadMessages(ROOM);
    expect(stored.find((item) => item.packet.id === outgoing.id)?.delivery).toBe("failed");
    expect(stored.find((item) => item.packet.id === outgoing.id)?.failure).toBe("message_conflict");

    cleanup();
    render(<App />);
    await screen.findByText("Send this once");
    expect(await screen.findByText(/Compose a new message to send with a new ID/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not carry a hub replay storage warning into a different room", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    act(() => firstSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    const replay = {
      version: 1,
      type: "message",
      id: "room-scoped-replay-failure",
      room: ROOM,
      sender: "station-b",
      senderName: "Bea",
      createdAt: "2026-10-14T10:00:00.000Z",
      body: "This room could not save the replay",
    };
    messageReadGate.failNextSaveIds.push(replay.id);
    act(() => firstSocket.receive(replay));
    await screen.findByText(/A hub message could not be saved or checked/);

    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "second-room" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "second-room" })).toBeTruthy());
    expect(screen.queryByText(/A hub message could not be saved or checked/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const secondSocket = MockWebSocket.instances[1];
    act(() => secondSocket.open());
    act(() => secondSocket.receive({ version: 1, type: "joined", room: "second-room", peers: 1 }));
    await screen.findByText("On frequency");
    expect(screen.queryByText(/A hub message could not be saved or checked/)).toBeNull();
  });

  it("records a hub acknowledgment for a persisted message missing from the React snapshot", async () => {
    messageReadGate.identityPending = Promise.resolve({ sender: IDENTITY.sender, senderName: "" });
    render(<App />);
    await screen.findByText("Start with three details");
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: IDENTITY.senderName } });
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    act(() => socket.receive({ version: 1, type: "presence", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
    messageReadGate.room = ROOM;

    const packet = {
      version: 1 as const,
      type: "message" as const,
      id: "ack-race-message",
      room: ROOM,
      sender: IDENTITY.sender,
      senderName: IDENTITY.senderName,
      createdAt: "2026-10-15T00:00:00.000Z",
      body: "Persisted before its acknowledgment",
    };
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });
    act(() => {
      messageReadGate.ackDispatching = true;
      try { socket.receive({ version: 1, type: "ack", id: packet.id }); }
      finally { messageReadGate.ackDispatching = false; }
    });
    expect(messageReadGate.ackDispatchRoomReads).toBe(1);
    await waitFor(async () => expect((await loadMessages(ROOM)).find((item) => item.packet.id === packet.id)?.delivery).toBe("sent"));
    const stored = await loadMessages(ROOM);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ packet, direction: "outgoing", delivery: "sent", transport: "hub" });
  }, 15000);

  it("warns when the persisted message lookup for a hub acknowledgment fails", async () => {
    messageReadGate.identityPending = Promise.resolve({ sender: IDENTITY.sender, senderName: "" });
    render(<App />);
    await screen.findByText("Start with three details");
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: IDENTITY.senderName } });
    fireEvent.click(screen.getByRole("button", { name: "Save and join room" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    act(() => socket.receive({ version: 1, type: "presence", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
    messageReadGate.room = ROOM;
    const packet = {
      version: 1 as const,
      type: "message" as const,
      id: "ack-read-failure",
      room: ROOM,
      sender: IDENTITY.sender,
      senderName: IDENTITY.senderName,
      createdAt: "2026-10-15T00:00:00.000Z",
      body: "Awaiting status confirmation",
    };
    await saveMessage({ packet, direction: "outgoing", delivery: "queued", transport: "hub" });
    messageReadGate.rejectAckFallbackRead = true;

    act(() => {
      messageReadGate.ackDispatching = true;
      try { socket.receive({ version: 1, type: "ack", id: packet.id }); }
      finally { messageReadGate.ackDispatching = false; }
    });

    expect(messageReadGate.ackDispatchRoomReads).toBe(1);
    expect(await screen.findByText(/saved outgoing message could not be checked on this device/i)).toBeTruthy();
    expect((await loadMessages(ROOM))[0]).toMatchObject({ packet, delivery: "queued" });
  }, 15000);

  it("does not replay a conflicted outgoing message when its status save finishes after disconnect", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    act(() => firstSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Conflict before reconnect" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Queued on this device");
    await waitFor(() => expect(firstSocket.sent).toHaveLength(2));
    const outgoing = JSON.parse(firstSocket.sent[1]);

    messageReadGate.deliveryUpdateId = outgoing.id;
    messageReadGate.deliveryUpdatePending = new Promise<void>((resolve) => { messageReadGate.releaseDeliveryUpdate = resolve; });
    act(() => firstSocket.receive({
      version: 1,
      type: "error",
      code: "message_conflict",
      message: "This message ID was already used for different content.",
      id: outgoing.id,
    }));
    await waitFor(() => expect(messageReadGate.deliveryUpdateStarted).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect radio" }));
    await screen.findByText("Standby");
    expect(screen.getByText("Radio switched to standby.")).toBeTruthy();
    await waitFor(() => expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED));

    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    act(() => reconnectSocket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");
    expect(reconnectSocket.sent).toHaveLength(1);
    expect(JSON.parse(reconnectSocket.sent[0])).toMatchObject({ type: "join", room: ROOM });

    messageReadGate.releaseDeliveryUpdate?.();
    await screen.findByText(/Compose a new message to send with a new ID/);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === outgoing.id)).toMatchObject({ delivery: "failed", failure: "message_conflict" });
    expect(reconnectSocket.sent).toHaveLength(1);
  });

  it("does not show a delayed hub error notice after switching rooms", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect radio" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive({ version: 1, type: "joined", room: ROOM, peers: 1 }));
    await screen.findByText("On frequency");

    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Switch before error settles" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Queued on this device");
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    const outgoing = JSON.parse(socket.sent[1]);

    messageReadGate.deliveryUpdateId = outgoing.id;
    messageReadGate.deliveryUpdateReject = true;
    messageReadGate.deliveryUpdatePending = new Promise<void>((resolve) => { messageReadGate.releaseDeliveryUpdate = resolve; });
    act(() => socket.receive({
      version: 1,
      type: "error",
      code: "storage_unavailable",
      message: "The hub could not store this message.",
      id: outgoing.id,
    }));
    await waitFor(() => expect(messageReadGate.deliveryUpdateStarted).toBe(true));

    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "notice-room" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "notice-room" })).toBeTruthy());
    messageReadGate.releaseDeliveryUpdate?.();
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));

    expect(screen.queryByText("The hub rejected your message, but its status could not be saved on this device.")).toBeNull();
    expect(screen.queryByText(/The hub could not store this message\./)).toBeNull();
  });

  it("keeps the composer disabled until the selected room has loaded", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });

    const draft = screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Ready for the next room" } });
    const nextRoom = "pending-room";
    let resolveRoomRead!: (messages: StoredMessage[]) => void;
    messageReadGate.room = nextRoom;
    messageReadGate.pending = new Promise<StoredMessage[]>((resolve) => { resolveRoomRead = resolve; });

    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: nextRoom } });
    await waitFor(() => expect(messageReadGate.requestedRooms).toContain(nextRoom));

    const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    await act(async () => {
      resolveRoomRead([]);
      await messageReadGate.pending;
    });

    await waitFor(() => {
      expect(draft.disabled).toBe(false);
      expect(sendButton.disabled).toBe(false);
    });
  });

  it("clears prior room messages while the newly selected room is still loading", async () => {
    const priorMessage: StoredMessage = {
      packet: {
        version: 1,
        type: "message",
        id: "old-room-message",
        room: ROOM,
        sender: "station-old",
        senderName: "Old room sender",
        createdAt: "2026-10-14T09:00:00.000Z",
        body: "Only visible in the original room",
      },
      direction: "incoming",
      delivery: "sent",
    };
    await saveMessage(priorMessage);
    render(<App />);
    await screen.findByText(priorMessage.packet.body);

    const nextRoom = "another-room";
    let resolveRoomRead!: (messages: StoredMessage[]) => void;
    messageReadGate.room = nextRoom;
    messageReadGate.pending = new Promise<StoredMessage[]>((resolve) => { resolveRoomRead = resolve; });
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: nextRoom } });

    await waitFor(() => expect(messageReadGate.requestedRooms).toContain(nextRoom));
    expect(screen.getByRole("heading", { name: nextRoom })).toBeTruthy();
    expect(screen.queryByText(priorMessage.packet.body)).toBeNull();

    await act(async () => {
      resolveRoomRead([]);
      await messageReadGate.pending;
    });

    expect(screen.queryByText(priorMessage.packet.body)).toBeNull();
  });

  it("keeps only valid, unique recent room codes and caps the list at ten", async () => {
    localStorage.setItem("nearlink.recent-rooms", JSON.stringify([
      "room-1", "room-2", "room-1", "has spaces", 7, "room/3", ...Array.from({ length: 12 }, (_, index) => `room-${index + 3}`),
    ]));

    render(<App />);
    const recentRooms = await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    await waitFor(() => expect([...within(recentRooms).getAllByRole("option")].map((option) => (option as HTMLOptionElement).value)).toEqual([
      "", ROOM, "room-1", "room-2", "room-3", "room-4", "room-5", "room-6", "room-7", "room-8", "room-9",
    ]));
    expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual([
      ROOM, "room-1", "room-2", "room-3", "room-4", "room-5", "room-6", "room-7", "room-8", "room-9",
    ]);
  });

  it("ignores malformed recent-room settings and restores the last valid room", async () => {
    localStorage.setItem("nearlink.recent-rooms", "{broken json");
    localStorage.setItem("nearlink.room", "saved-room");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "saved-room" })).toBeTruthy();
    const recentRooms = await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual(["saved-room"]));
    expect([...within(recentRooms).getAllByRole("option")].map((option) => (option as HTMLOptionElement).value)).toEqual(["", "saved-room"]);
  });

  it("records a room only after its profile is saved", async () => {
    render(<App />);
    await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "draft-room" } });

    expect(localStorage.getItem("nearlink.room")).toBe(ROOM);
    expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual([ROOM]);
    cleanup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: ROOM })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual([ROOM]);

    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "draft-room" } });
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Sam" } });
    const saveButton = screen.getByRole("button", { name: "Save and join room" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(localStorage.getItem("nearlink.room")).toBe("draft-room"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual(["draft-room", ROOM]));
  });

  it("does not join a room that changes while the profile save is pending", async () => {
    let releaseSave!: () => void;
    messageReadGate.identitySavePending = new Promise<void>((resolve) => { releaseSave = resolve; });
    messageReadGate.releaseIdentitySave = releaseSave;
    render(<App />);
    await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Sam" } });
    const saveButton = screen.getByRole("button", { name: "Save and join room" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(saveButton);
    await waitFor(() => expect(messageReadGate.identitySaveStarted).toBe(true));
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "next-room" } });
    messageReadGate.releaseIdentitySave?.();

    expect(await screen.findByText("The room changed while your profile was being saved. Save again to join the selected room.")).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(localStorage.getItem("nearlink.room")).toBe(ROOM);
    expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual([ROOM]);
  });

  it("rechecks station settings after the room resume step", async () => {
    messageReadGate.resumeRoom = ROOM;
    messageReadGate.resumePending = new Promise<void>((resolve) => { messageReadGate.releaseResume = resolve; });
    render(<App />);
    await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Sam" } });
    const saveButton = screen.getByRole("button", { name: "Save and join room" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(saveButton);
    await waitFor(() => expect(messageReadGate.resumeStarted).toBe(true));
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "next-room" } });
    messageReadGate.releaseResume?.();

    expect(await screen.findByText("The room changed while your profile was being saved. Save again to join the selected room.")).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(localStorage.getItem("nearlink.room")).toBe(ROOM);
  });

  it("switches through the room lifecycle, scopes history, and restores selection after reload", async () => {
    const otherRoom = "saved-room";
    const currentMessage: StoredMessage = {
      packet: { version: 1, type: "message", id: "current-room-message", room: ROOM, sender: "station-b", senderName: "Bea", createdAt: "2026-10-14T09:00:00.000Z", body: "Message in current room" },
      direction: "incoming",
      delivery: "sent",
    };
    const otherMessage: StoredMessage = {
      packet: { ...currentMessage.packet, id: "saved-room-message", room: otherRoom, body: "Message in saved room" },
      direction: "incoming",
      delivery: "sent",
    };
    await saveMessage(currentMessage);
    await saveMessage(otherMessage);
    localStorage.setItem("nearlink.recent-rooms", JSON.stringify([ROOM, otherRoom]));
    render(<App />);
    await screen.findByText(currentMessage.packet.body);

    const selector = screen.getByRole("combobox", { name: "Recent rooms on this device" });
    fireEvent.change(selector, { target: { value: otherRoom } });
    await screen.findByText(otherMessage.packet.body);
    expect(screen.getByRole("heading", { name: otherRoom })).toBeTruthy();
    expect(screen.queryByText(currentMessage.packet.body)).toBeNull();
    await waitFor(() => expect(localStorage.getItem("nearlink.room")).toBe(otherRoom));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nearlink.recent-rooms") ?? "null")).toEqual([otherRoom, ROOM]));

    cleanup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: otherRoom })).toBeTruthy();
    expect(await screen.findByText(otherMessage.packet.body)).toBeTruthy();
    expect(screen.queryByText(currentMessage.packet.body)).toBeNull();
  });

  it("starts with safe in-memory defaults when browser settings cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    render(<App />);

    const roomInput = await screen.findByLabelText("Room frequency") as HTMLInputElement;
    expect(roomInput.value).toBe("");
    expect((screen.getByLabelText("Hub address") as HTMLInputElement).value).toBe("ws://localhost:8000/ws");
  });

  it("keeps hub connection available when browser settings cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "QuotaExceededError"); });
    render(<App />);
    await screen.findByRole("combobox", { name: "Recent rooms on this device" });
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Sam" } });
    const saveButton = screen.getByRole("button", { name: "Save and join room" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    expect(await screen.findByText("Your station settings could not be saved. Re-enter them if you reload this page.")).toBeTruthy();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  });
});
