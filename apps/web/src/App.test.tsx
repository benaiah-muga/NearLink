// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageReadGate = vi.hoisted(() => ({
  room: null as string | null,
  pending: null as Promise<unknown> | null,
  requestedRooms: [] as string[],
}));

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
  };
});

import App from "./App";
import { loadMessages, saveMessage, type StoredMessage } from "./lib/storage";

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
  MockWebSocket.instances = [];
  messageReadGate.room = null;
  messageReadGate.pending = null;
  messageReadGate.requestedRooms = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  localStorage.setItem("nearlink.room", ROOM);
  localStorage.setItem("nearlink.hub", "ws://localhost:8000/ws");
  await resetDatabase();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser app messaging flow", () => {
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
