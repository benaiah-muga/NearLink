// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageReadGate = vi.hoisted(() => ({
  room: null as string | null,
  pending: null as Promise<unknown> | null,
  releaseRead: null as (() => void) | null,
  requestedRooms: [] as string[],
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
});

import App from "./App";
import { beginRoomDeletion, deleteRoomMessages, isRoomMessagesDeleted, loadIdentity, loadMessages, saveMessage, type StoredMessage } from "./lib/storage";

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
    const request = indexedDB.open("nearlink-local", 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      const messages = database.createObjectStore("messages", { keyPath: ["packet.room", "packet.id"] });
      messages.createIndex("roomCreatedAt", ["packet.room", "packet.createdAt"]);
      messages.createIndex("roomDeliveryCreatedAt", ["packet.room", "delivery", "packet.createdAt"]);
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

beforeEach(async () => {
  wasmGate.fail = false;
  MockWebSocket.instances = [];
  messageReadGate.room = null;
  messageReadGate.pending = null;
  messageReadGate.releaseRead = null;
  messageReadGate.requestedRooms = [];
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
    expect(await loadMessages("another-room")).toEqual([otherRoomMessage]);
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
    expect(await loadMessages(ROOM)).toEqual([saved]);
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
});
