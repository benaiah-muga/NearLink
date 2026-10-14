// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageReadGate = vi.hoisted(() => ({
  room: null as string | null,
  pending: null as Promise<unknown> | null,
  requestedRooms: [] as string[],
  failNextSaveIds: [] as string[],
  saveAttempts: new Map<string, number>(),
  deliveryUpdateId: null as string | null,
  deliveryUpdatePending: null as Promise<void> | null,
  releaseDeliveryUpdate: null as (() => void) | null,
  deliveryUpdateStarted: false,
  deliveryUpdateReject: false,
}));
const wasmGate = vi.hoisted(() => ({ fail: false }));

vi.mock("./lib/wasmProtocol", async () => {
  const protocol = await import("@nearlink/protocol");
  return {
    MAX_PROTOCOL_ENVELOPE_BYTES: 18 * 1024,
    initializeWasmProtocol: async () => !wasmGate.fail,
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
  };
});

vi.mock("./lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/storage")>();
  return {
    ...actual,
    loadMessages: (room: string) => {
      messageReadGate.requestedRooms.push(room);
      if (room === messageReadGate.room && messageReadGate.pending) {
        return messageReadGate.pending as ReturnType<typeof actual.loadMessages>;
      }
      return actual.loadMessages(room);
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
});

import App from "./App";
import { loadMessages, saveMessage, type StoredMessage } from "./lib/storage";

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, "storage");

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

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
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
    const request = indexedDB.open("nearlink-local", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const messages = database.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
      messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
      messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
      database.createObjectStore("identity", { keyPath: "key" });
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

beforeEach(async () => {
  wasmGate.fail = false;
  MockWebSocket.instances = [];
  messageReadGate.room = null;
  messageReadGate.pending = null;
  messageReadGate.requestedRooms = [];
  messageReadGate.failNextSaveIds = [];
  messageReadGate.saveAttempts = new Map();
  messageReadGate.deliveryUpdateId = null;
  messageReadGate.deliveryUpdatePending = null;
  messageReadGate.releaseDeliveryUpdate = null;
  messageReadGate.deliveryUpdateStarted = false;
  messageReadGate.deliveryUpdateReject = false;
  vi.stubGlobal("WebSocket", MockWebSocket);
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  localStorage.setItem("nearlink.room", ROOM);
  localStorage.setItem("nearlink.hub", "ws://localhost:8000/ws");
  await resetDatabase();
});

afterEach(() => {
  cleanup();
  if (originalStorageDescriptor) Object.defineProperty(navigator, "storage", originalStorageDescriptor);
  else Reflect.deleteProperty(navigator, "storage");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("browser app messaging flow", () => {
  it("fails closed with an accessible action when Rust protocol checks cannot load", async () => {
    wasmGate.fail = true;
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/will not connect, send messages, or accept peer packets/i);
    expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(true);
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
    await waitFor(() => expect(messageReadGate.requestedRooms.filter((room) => room === ROOM)).toHaveLength(2));

    expect(await loadMessages(ROOM)).toEqual([replay]);
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

    expect(await loadMessages(ROOM)).toEqual([saved]);
    expect(screen.getByText(saved.packet.body)).toBeTruthy();
    expect(screen.queryByText("Different replay content")).toBeNull();
    expect(messageReadGate.saveAttempts.get(saved.packet.id) ?? 0).toBe(0);
  });

  it("warns when the hub reports truncated replay history", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));
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
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect radio" }) as HTMLButtonElement).disabled).toBe(false));

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
});
