// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "./lib/storage";

interface MockPeerTransport {
  currentState: string;
  peerFingerprint: string | null;
  sent: string[];
  emit(data: unknown): void;
  setState(state: string): void;
  sendErrorCode: string | null;
}

const peerMock = vi.hoisted(() => ({ instances: [] as Array<any> }));
const storageGate = vi.hoisted(() => ({ packetId: null as string | null, body: null as string | null, reject: false, finish: null as null | (() => void) }));
const offerGate = vi.hoisted(() => ({ blockNext: false, release: null as null | (() => void) }));
const constructorGate = vi.hoisted(() => ({ throwNext: false }));
const socketMock = vi.hoisted(() => ({ constructions: 0 }));
const wasmValidationCalls = vi.hoisted(() => ({ values: [] as Array<{ validator: string; value: unknown }> }));

vi.mock("./lib/wasmProtocol", async () => {
  const protocol = await import("@nearlink/protocol");
  return {
    MAX_PROTOCOL_ENVELOPE_BYTES: 18 * 1024,
    initializeWasmProtocol: async () => true,
    classifyInboundAcceptance: (expectedRoom: string, roomDeleted: boolean, candidate: import("@nearlink/protocol").MessagePacket, existing?: import("@nearlink/protocol").MessagePacket) => {
      if (candidate.room !== expectedRoom) throw new Error("WASM rejected inbound acceptance (room_mismatch).");
      if (roomDeleted) return "room_deleted";
      if (!existing) return "saved";
      return JSON.stringify(candidate) === JSON.stringify(existing) ? "duplicate" : "conflict";
    },
    validateJsonWithWasm: (validator: string, json: string) => {
      if (json.length > 18 * 1024) return false;
      try {
        const value: unknown = JSON.parse(json);
        if (validator === "client") return protocol.isClientPacket(value);
        if (validator === "message") return protocol.isMessagePacket(value);
        return protocol.isServerPacket(value);
      } catch { return false; }
    },
    validateWithWasm: (validator: string, value: unknown) => {
      wasmValidationCalls.values.push({ validator, value });
      if (validator === "client") return protocol.isClientPacket(value);
      if (validator === "message") return protocol.isMessagePacket(value);
      if (validator === "server") return protocol.isServerPacket(value);
      if (validator === "room") return protocol.isProtocolRoom(value);
      return protocol.isProtocolIdentifier(value);
    },
    isWasmSyncStateReady: () => true,
    MAX_SYNC_SELECTION_CHUNK_IDS: 4096,
    createWasmSyncInventoryReceiver: () => {
      const ids: string[] = [];
      return {
        acceptPage: (packet: import("@nearlink/protocol").SyncInventoryPagePacket) => {
          ids.push(...packet.messageIds);
          return { outcome: "accepted" as const, ids: [...ids], complete: !packet.hasMore, limitReached: !packet.hasMore && packet.limitReached };
        },
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
    createWasmSyncRequestBook: () => ({
      registerRequest: () => "accepted" as const,
      acceptCompletion: () => "accepted" as const,
      free: () => undefined,
    }),
  };
});

vi.mock("./lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/storage")>();
  const overrides = {
    saveMessage: async (message: Parameters<typeof actual.saveMessage>[0]) => {
      if (message.packet.id === storageGate.packetId || message.packet.body === storageGate.body) {
        await new Promise<void>((resolve) => { storageGate.finish = resolve; });
        if (storageGate.reject) throw new Error("Test storage write rejected.");
      }
      return actual.saveMessage(message);
    },
    acceptInboundMessage: async (message: Parameters<typeof actual.acceptInboundMessage>[0]) => {
      if (message.packet.id === storageGate.packetId || message.packet.body === storageGate.body) {
        await new Promise<void>((resolve) => { storageGate.finish = resolve; });
        if (storageGate.reject) throw new Error("Test storage write rejected.");
      }
      return actual.acceptInboundMessage(message);
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

vi.mock("./lib/webrtc", () => {
  class MockWebRtcTransportError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  class MockDirectWebRtcTransport {
    static readonly instances = peerMock.instances;
    currentState = "new";
    peerFingerprint: string | null = null;
    onMessage: ((data: unknown) => void) | null = null;
    onStateChange: ((state: string) => void) | null = null;
    onError: ((error: Error) => void) | null = null;
    readonly sent: string[] = [];
    sendErrorCode: string | null = null;
    constructor() {
      if (constructorGate.throwNext) {
        constructorGate.throwNext = false;
        throw new Error("Browser WebRTC is unavailable.");
      }
      peerMock.instances.push(this);
    }
    async createOffer() {
      if (offerGate.blockNext) {
        offerGate.blockNext = false;
        await new Promise<void>((resolve) => { offerGate.release = resolve; });
      }
      return JSON.stringify({ version: 1, type: "offer", sdp: "test-offer" });
    }
    async acceptOffer() {
      this.peerFingerprint = `sha-256 ${"AA:".repeat(31)}AA`;
      return JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" });
    }
    async acceptAnswer() {
      this.peerFingerprint = `sha-256 ${"AA:".repeat(31)}AA`;
      this.setState("connected");
    }
    send(data: string) {
      if (this.sendErrorCode) throw new MockWebRtcTransportError(this.sendErrorCode, "Injected direct send failure.");
      this.sent.push(data);
    }
    emit(data: unknown) { this.onMessage?.(JSON.stringify(data)); }
    setState(state: string) { this.currentState = state; this.onStateChange?.(state); }
    close() { this.setState("closed"); }
  }
  return { DirectWebRtcTransport: MockDirectWebRtcTransport, WebRtcTransportError: MockWebRtcTransportError };
});

import App from "./App";
import { isRoomMessagesDeleted, loadIdentity, loadMessages, saveIdentity, saveMessage } from "./lib/storage";

const ROOM = "campus-radio";
const IDENTITY = { sender: "station-a", senderName: "Ari" };
const FINGERPRINT = `sha-256 ${"AA:".repeat(31)}AA`;

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
  wasmValidationCalls.values = [];
  peerMock.instances.length = 0;
  socketMock.constructions = 0;
  storageGate.packetId = null;
  storageGate.body = null;
  storageGate.reject = false;
  storageGate.finish = null;
  offerGate.blockNext = false;
  offerGate.release = null;
  constructorGate.throwNext = false;
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  localStorage.setItem("nearlink.room", ROOM);
  localStorage.setItem("nearlink.hub", "ws://localhost:8000/ws");
  vi.stubGlobal("WebSocket", class {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    constructor() { socketMock.constructions += 1; throw new Error("The test socket must not be opened."); }
  });
  await resetDatabase();
  await Promise.all([loadIdentity(), loadMessages(ROOM), isRoomMessagesDeleted(ROOM)]);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

describe("direct peer app flow", () => {
  it("serves bounded synchronization requests over the confirmed direct transport", async () => {
    const accepted: StoredMessage = {
      packet: { version: 1, type: "message", id: "direct-sync-saved", room: ROOM, sender: IDENTITY.sender, senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Direct sync saved body" },
      direction: "outgoing",
      delivery: "sent",
      transport: "direct",
    };
    await saveMessage(accepted);
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    fireEvent.change(screen.getByLabelText("Paste peer offer or answer JSON"), { target: { value: JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await screen.findByLabelText("Remote SDP DTLS fingerprint");
    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    const transport = peerMock.instances[0] as MockPeerTransport;
    await waitFor(() => expect(transport.sent.map((entry) => JSON.parse(entry)).some((packet) => packet.type === "sync_inventory_page" && packet.messageIds.includes(accepted.packet.id))).toBe(true));
    const inventory = transport.sent.map((entry) => JSON.parse(entry)).find((packet) => packet.type === "sync_inventory_page");
    act(() => transport.emit({
      version: 1,
      type: "sync_missing_request",
      room: ROOM,
      syncId: inventory.syncId,
      requestId: "direct-peer-request",
      sender: "station-b",
      targetSender: IDENTITY.sender,
      messageIds: [accepted.packet.id],
    }));
    await waitFor(() => expect(transport.sent.map((entry) => JSON.parse(entry)).some((packet) => packet.type === "sync_page_complete" && packet.requestId === "direct-peer-request")).toBe(true));
    expect(transport.sent.map((entry) => JSON.parse(entry))).toContainEqual(accepted.packet);
  });

  it("exchanges signaling, blocks unverified direct send, saves messages before ACK, and records peer acceptance", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    expect(JSON.parse((screen.getByLabelText("Your signaling JSON to share") as HTMLTextAreaElement).value)).toMatchObject({ type: "offer", version: 1 });
    fireEvent.change(screen.getByLabelText("Paste peer offer or answer JSON"), { target: { value: JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await screen.findByLabelText("Remote SDP DTLS fingerprint");
    await screen.findByText(/Direct channel: connected/);

    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: `sha-256 ${"00:".repeat(31)}00` } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    expect(await screen.findByText(/Fingerprint does not match/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Do not send before verification" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Queued on this device");
    const transport = peerMock.instances[0] as MockPeerTransport;
    expect(transport.sent).toHaveLength(0);
    const unverifiedQueued = (await loadMessages(ROOM)).find((item) => item.packet.body === "Do not send before verification");
    expect(unverifiedQueued).toMatchObject({ transport: "direct", delivery: "queued" });
    const unverifiedInbound = {
      version: 1, type: "message", id: "unverified-inbound", room: ROOM, sender: IDENTITY.sender,
      senderName: IDENTITY.senderName, createdAt: "2026-10-14T09:00:00.000Z", body: "Do not accept before verification",
    };
    act(() => {
      transport.emit({ version: 1, type: "ack", id: unverifiedQueued?.packet.id });
      transport.emit(unverifiedInbound);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === unverifiedQueued?.packet.id)?.delivery).toBe("queued");
    expect((await loadMessages(ROOM)).some((item) => item.packet.id === unverifiedInbound.id)).toBe(false);
    expect(transport.sent).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    await screen.findByText(/Fingerprint matches this DTLS session/);
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    expect(screen.getByText("Session fingerprint compared")).toBeTruthy();
    await waitFor(() => expect(transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")).toHaveLength(1));
    expect(transport.sent.map((entry) => JSON.parse(entry)).find((packet) => packet.type === "message")).toEqual(unverifiedQueued?.packet);
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Hello peer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")).toHaveLength(2));
    const sentPacket = transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")[1];
    expect(sentPacket).toMatchObject({ type: "message", body: "Hello peer", room: ROOM });
    act(() => transport.emit({ version: 1, type: "ack", id: sentPacket.id }));
    await screen.findByText("Accepted by peer device");
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === sentPacket.id)).toMatchObject({ delivery: "sent", transport: "direct" });

    const inbound = {
      version: 1,
      type: "message",
      id: "peer-message-1",
      room: ROOM,
      sender: IDENTITY.sender,
      senderName: IDENTITY.senderName,
      createdAt: "2026-10-14T10:00:00.000Z",
      body: "Saved before acknowledgment",
    };
    storageGate.packetId = inbound.id;
    act(() => {
      transport.emit(inbound);
      transport.emit(inbound);
    });
    await waitFor(() => expect(storageGate.finish).toBeTruthy());
    expect(transport.sent.map((entry: string) => JSON.parse(entry))).not.toContainEqual({ version: 1, type: "ack", id: inbound.id });
    await act(async () => {
      const finish = storageGate.finish;
      storageGate.finish = null;
      storageGate.packetId = null;
      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText(inbound.body);
    await waitFor(async () => expect((await loadMessages(ROOM)).some((item) => item.packet.id === inbound.id && item.transport === "direct" && item.direction === "incoming")).toBe(true));
    expect(wasmValidationCalls.values.some(({ validator, value }) => validator === "message" && (value as { id?: string }).id === inbound.id)).toBe(true);
    expect(screen.getByText(inbound.body).closest(".message-row")?.classList.contains("message-incoming")).toBe(true);
    await waitFor(() => expect(transport.sent.map((entry: string) => JSON.parse(entry)).filter((packet: { type: string; id: string }) => packet.type === "ack" && packet.id === inbound.id)).toHaveLength(2));
    const countBeforeDuplicate = transport.sent.length;
    act(() => transport.emit(inbound));
    await waitFor(() => expect(transport.sent).toHaveLength(countBeforeDuplicate + 1));
    expect((await loadMessages(ROOM)).filter((item) => item.packet.id === inbound.id)).toHaveLength(1);
    const countBeforeConflict = transport.sent.length;
    act(() => transport.emit({ ...inbound, body: "Conflicting content" }));
    await waitFor(() => expect(screen.getByText(/conflicting direct message/)).toBeTruthy());
    expect(transport.sent).toHaveLength(countBeforeConflict);
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === inbound.id)?.packet.body).toBe(inbound.body);
  }, 30_000);

  it("keeps direct messages queued after disconnect and closes the peer on room changes", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    fireEvent.change(screen.getByLabelText("Paste peer offer or answer JSON"), { target: { value: JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await screen.findByLabelText("Remote SDP DTLS fingerprint");
    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    await screen.findByText(/Fingerprint matches this DTLS session/);
    const transport = peerMock.instances[0] as MockPeerTransport;
    act(() => transport.setState("disconnected"));
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Keep this queued" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Queued on this device");
    const queued = (await loadMessages(ROOM)).find((item) => item.packet.body === "Keep this queued");
    expect(queued).toMatchObject({ transport: "direct", delivery: "queued" });
    act(() => {
      transport.setState("connected");
      transport.emit({ version: 1, type: "ack", id: queued?.packet.id });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === queued?.packet.id)?.delivery).toBe("queued");
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    await waitFor(() => expect(transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")).toHaveLength(1));
    expect(transport.sent.map((entry) => JSON.parse(entry)).find((packet) => packet.type === "message")).toEqual(queued?.packet);

    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "new-room" } });
    await waitFor(() => expect(transport.currentState).toBe("closed"));
    expect((screen.getByLabelText("Message transport") as HTMLSelectElement).value).toBe("hub");
    expect(screen.queryByLabelText("Remote SDP DTLS fingerprint")).toBeNull();
  });

  it("closes replaced transports and ignores an offer completion after its room changes", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    const first = peerMock.instances[0];

    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await waitFor(() => expect(peerMock.instances).toHaveLength(2));
    await waitFor(() => expect(first.currentState).toBe("closed"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(false));

    offerGate.blockNext = true;
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await waitFor(() => expect(peerMock.instances).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Room frequency"), { target: { value: "different-room" } });
    await waitFor(() => expect(peerMock.instances[2].currentState).toBe("closed"));
    await act(async () => {
      offerGate.release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByLabelText("Your signaling JSON to share")).toBeNull();
  });

  it("does not transmit a direct message while its save is pending or after the save fails", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    fireEvent.change(screen.getByLabelText("Paste peer offer or answer JSON"), { target: { value: JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await screen.findByLabelText("Remote SDP DTLS fingerprint");
    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    await screen.findByText(/Fingerprint matches this DTLS session/);
    const transport = peerMock.instances[0] as MockPeerTransport;
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    storageGate.body = "Reject this unsaved message";
    storageGate.reject = true;
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: storageGate.body } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(storageGate.finish).toBeTruthy());
    expect(transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")).toHaveLength(0);
    await act(async () => {
      const finish = storageGate.finish;
      storageGate.finish = null;
      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText(/It has not been queued for delivery/);
    expect((await loadMessages(ROOM)).some((item) => item.packet.body === storageGate.body)).toBe(false);
    expect(transport.sent.map((entry) => JSON.parse(entry)).filter((packet) => packet.type === "message")).toHaveLength(0);
  });

  it("keeps a saturated direct send retryable with the same ID through link close", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByLabelText("Your signaling JSON to share");
    fireEvent.change(screen.getByLabelText("Paste peer offer or answer JSON"), { target: { value: JSON.stringify({ version: 1, type: "answer", sdp: "test-answer" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await screen.findByLabelText("Remote SDP DTLS fingerprint");
    fireEvent.change(screen.getByLabelText(/Fingerprint compared in person/), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: "Compare fingerprints" }));
    await screen.findByText(/Fingerprint matches this DTLS session/);

    const transport = peerMock.instances[0] as MockPeerTransport;
    transport.sendErrorCode = "outbound_queue_full";
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Retry after direct backpressure" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Direct send queue is full");
    const saturated = (await loadMessages(ROOM)).find((item) => item.packet.body === "Retry after direct backpressure");
    expect(saturated).toMatchObject({ direction: "outgoing", transport: "direct", delivery: "failed", failure: "transport_backpressure" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    transport.sendErrorCode = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(transport.sent.some((raw) => JSON.parse(raw).id === saturated?.packet.id)).toBe(true));
    await waitFor(async () => expect((await loadMessages(ROOM)).find((item) => item.packet.id === saturated?.packet.id)?.delivery).toBe("queued"));
    transport.setState("disconnected");
    await waitFor(async () => expect((await loadMessages(ROOM)).find((item) => item.packet.id === saturated?.packet.id)?.delivery).toBe("queued"));
    expect((await loadMessages(ROOM)).find((item) => item.packet.id === saturated?.packet.id)?.packet.id).toBe(saturated?.packet.id);
  });

  it("reports a WebRTC constructor failure and releases the busy controls", async () => {
    constructorGate.throwNext = true;
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await screen.findByText("Browser WebRTC is unavailable.");
    await waitFor(() => expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(false));
    expect(peerMock.instances).toHaveLength(0);
  });

  it("saves a direct profile without opening a WebSocket", async () => {
    await saveIdentity({ ...IDENTITY, senderName: "" });
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement).disabled).toBe(false), { timeout: 5000 });
    expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your call sign"), { target: { value: "Nia" } });
    fireEvent.change(screen.getByLabelText("Message transport"), { target: { value: "direct" } });
    fireEvent.change(screen.getByLabelText("Hub address"), { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Save profile for direct link" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save profile for direct link" }));
    await screen.findByText(/Profile saved for direct peer setup/);
    expect((screen.getByRole("button", { name: "Create offer" }) as HTMLButtonElement).disabled).toBe(false);
    expect(socketMock.constructions).toBe(0);
  });
});
