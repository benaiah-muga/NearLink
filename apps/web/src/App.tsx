import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { MAX_HISTORY_PAGE_MESSAGES, PROTOCOL_VERSION, type AcknowledgmentPacket, type ClientPacket, type HistoryPageCompletePacket, type HistoryRequestPacket, type MessagePacket, type SyncPacket } from "@nearlink/protocol";
import { browserConversationStore as conversationStore, type LocalIdentity, type StoragePersistenceResult, type StoredMessage } from "./lib/storage";
import { DirectWebRtcTransport, type TransportState } from "./lib/webrtc";
import { SyncCoordinator, type SyncState } from "./lib/sync";
import { buildDiagnosticsSummary, formatDiagnosticsSummary } from "./lib/diagnostics";
import { initializeWasmProtocol, MAX_PROTOCOL_ENVELOPE_BYTES, validateJsonWithWasm, validateWithWasm } from "./lib/wasmProtocol";

type LinkState = "offline" | "connecting" | "linking" | "online" | "retrying" | "error";
type HistoryPagingState = "unavailable" | "available" | "loading" | "retry" | "done" | "unsupported";
interface PendingHistoryRequest {
  socket: WebSocket;
  room: string;
  requestId: string;
  cursor: string | null;
  requestStartOrder: number;
  packets: Map<string, MessagePacket>;
  timeout: number;
}
const DEFAULT_HUB = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname || "localhost"}:8000/ws`;
const HUB_KEY = "nearlink.hub";
const ROOM_KEY = "nearlink.room";
const ROOM_DELETION_CHANNEL = "nearlink-room-deletion-v1";
const HUB_REPLAY_FAILURE_NOTICE = "A hub message could not be saved or checked on this device. It was not accepted and can be retried after reconnecting.";
const WASM_PROTOCOL_FAILURE_NOTICE = "Protocol checks could not start. NearLink will not connect, send messages, or accept peer packets. Reload the page. If this continues, update the browser and report this error.";

function readLocalSetting(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function writeLocalSetting(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `nl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeFingerprint(value: string): string | null {
  const match = /^\s*(sha-256|sha-384|sha-512)\s+([0-9a-f:]+)\s*$/i.exec(value);
  if (!match) return null;
  const algorithm = match[1].toLowerCase();
  const bytes = match[2].replaceAll(":", "").toUpperCase();
  const expectedLength = algorithm === "sha-256" ? 64 : algorithm === "sha-384" ? 96 : 128;
  if (bytes.length !== expectedLength || !/^[0-9A-F]+$/.test(bytes)) return null;
  return `${algorithm} ${bytes.match(/.{2}/g)?.join(":") ?? ""}`;
}

function isValidCallSign(value: string): boolean {
  return validateWithWasm("message", {
    version: PROTOCOL_VERSION,
    type: "message",
    id: "profile-check",
    room: "profile-check",
    sender: "profile-check",
    senderName: value,
    createdAt: "2026-01-01T00:00:00.000Z",
    body: "profile check",
  });
}

function sameMessagePacket(left: MessagePacket, right: MessagePacket): boolean {
  return left.version === right.version
    && left.type === right.type
    && left.id === right.id
    && left.room === right.room
    && left.sender === right.sender
    && left.senderName === right.senderName
    && left.createdAt === right.createdAt
    && left.body === right.body;
}

function compactPacketBytes(packet: MessagePacket): number {
  return new TextEncoder().encode(JSON.stringify(packet)).byteLength;
}

function hasHubInboundFailure(failures: Set<string>, room: string): boolean {
  const prefix = `${room}\u0000`;
  return [...failures].some((key) => key.startsWith(prefix));
}

function noteInvalidSyncPacket(value: unknown, coordinator: SyncCoordinator | null): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || !coordinator) return;
  const packet = value as Record<string, unknown>;
  if (packet.type === "sync_inventory_page" || packet.type === "sync_missing_request" || packet.type === "sync_page_complete") {
    coordinator.abort("A malformed synchronization control arrived. Reconnect to restart with fresh inventories.");
  } else if (packet.type === "message" && typeof packet.room === "string" && typeof packet.id === "string") {
    coordinator.rejectMessageId(packet.room, packet.id, "A requested message failed protocol checks. Reconnect to restart synchronization.");
  }
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "time unknown";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Recent transmissions";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

function SignalMark({ active }: { active: boolean }) {
  return <span className={`signal-mark${active ? " is-active" : ""}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [room, setRoom] = useState(() => readLocalSetting(ROOM_KEY) ?? "");
  const [hubUrl, setHubUrl] = useState(() => readLocalSetting(HUB_KEY) ?? DEFAULT_HUB);
  const [linkRequested, setLinkRequested] = useState(false);
  const [linkState, setLinkState] = useState<LinkState>("offline");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [peers, setPeers] = useState(0);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [storagePersistence, setStoragePersistence] = useState<StoragePersistenceResult | "checking">("checking");
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmFailed, setWasmFailed] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  const [loadedRoom, setLoadedRoom] = useState<string | null>(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [retryingMessageKeys, setRetryingMessageKeys] = useState<Set<string>>(() => new Set());
  const [conflictedHubMessageKeys, setConflictedHubMessageKeys] = useState<Set<string>>(() => new Set());
  const [directState, setDirectState] = useState<TransportState>("closed");
  const [signalInput, setSignalInput] = useState("");
  const [localSignal, setLocalSignal] = useState("");
  const [peerFingerprint, setPeerFingerprint] = useState<string | null>(null);
  const [trustedFingerprint, setTrustedFingerprint] = useState("");
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [directBusy, setDirectBusy] = useState(false);
  const [confirmRoomDeletion, setConfirmRoomDeletion] = useState(false);
  const [deletingRoom, setDeletingRoom] = useState(false);
  const [roomDeletedLocally, setRoomDeletedLocally] = useState(false);
  const [historyPagingState, setHistoryPagingState] = useState<HistoryPagingState>("unavailable");
  const [historyPagingMessage, setHistoryPagingMessage] = useState("");
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ state: SyncState; detail: string }>({ state: "idle", detail: "" });
  const [sendTransport, setSendTransport] = useState<"hub" | "direct">("hub");
  const [diagnosticsCopyStatus, setDiagnosticsCopyStatus] = useState("");
  const [manualDiagnosticsText, setManualDiagnosticsText] = useState<string | null>(null);
  const roomDeletionDialogRef = useRef<HTMLDialogElement>(null);
  const roomDeletionOpenerRef = useRef<HTMLElement | null>(null);
  const deletionStatusRef = useRef<HTMLDivElement>(null);
  const focusDeletionStatusRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const directRef = useRef<DirectWebRtcTransport | null>(null);
  const hubSyncRef = useRef<SyncCoordinator | null>(null);
  const directSyncRef = useRef<SyncCoordinator | null>(null);
  const messagesRef = useRef(messages);
  const callSignEditedRef = useRef(false);
  const messageKeysRef = useRef(new Set<string>());
  const conflictedHubMessageKeysRef = useRef(new Set<string>());
  const retryingMessageKeysRef = useRef(new Set<string>());
  const activeRoomRef = useRef(room.trim());
  const pendingSendRef = useRef(false);
  const pendingSendOperationRef = useRef<Promise<void> | null>(null);
  const deletionInProgressRef = useRef(false);
  const deletionGenerationRef = useRef(0);
  const deletionEventsRef = useRef(new Map<string, "deleting" | "deleted" | "cancelled">());
  const tabIdRef = useRef(makeId());
  const deletionChannelRef = useRef<BroadcastChannel | null>(null);
  const shouldReconnectRef = useRef(false);
  const attemptRef = useRef(0);
  const currentRoomRef = useRef(room.trim());
  const fingerprintConfirmedRef = useRef(fingerprintConfirmed);
  const directInFlightRef = useRef(new Set<string>());
  const directInboundOperationsRef = useRef(new Map<string, Promise<void>>());
  const directInboundTailRef = useRef<Promise<void>>(Promise.resolve());
  const hubInboundOperationsRef = useRef(new Map<string, Promise<void>>());
  const hubInboundTailRef = useRef<Promise<void>>(Promise.resolve());
  const hubInboundFailuresRef = useRef(new Set<string>());
  const historyRequestRef = useRef<PendingHistoryRequest | null>(null);
  const historyCursorRef = useRef<string | null | undefined>(undefined);
  const historyLimitRef = useRef(MAX_HISTORY_PAGE_MESSAGES);
  const historyRestartedRef = useRef(false);
  const joinedHistoryHubUrlRef = useRef<string | null>(null);
  const lastHubPeersRef = useRef<number | null>(null);
  const hubReplayOrderRef = useRef<{ socket: WebSocket; room: string; ids: string[] } | null>(null);
  const skipHistoryAutoScrollRef = useRef(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);

  messagesRef.current = messages;
  activeRoomRef.current = room.trim();
  currentRoomRef.current = room.trim();
  fingerprintConfirmedRef.current = fingerprintConfirmed;

  function oldestLoadedHubMessageId(): string | null {
    return [...messagesRef.current]
      .filter((item) => item.packet.room === activeRoomRef.current && item.transport === "hub" && item.delivery === "sent")
      .sort((left, right) => (left.displayOrder ?? Number.MAX_SAFE_INTEGER) - (right.displayOrder ?? Number.MAX_SAFE_INTEGER))[0]
      ?.packet.id ?? null;
  }

  function requestOlderHistory(cursorOverride?: string | null): void {
    const socket = socketRef.current;
    const connectionRoom = activeRoomRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || historyRequestRef.current || historyPagingState === "done" || historyPagingState === "unsupported") return;
    const cursor = cursorOverride === undefined
      ? historyCursorRef.current === undefined ? oldestLoadedHubMessageId() : historyCursorRef.current
      : cursorOverride;
    const request: HistoryRequestPacket = {
      version: PROTOCOL_VERSION,
      type: "history_request",
      requestId: makeId(),
      room: connectionRoom,
      cursor,
      limit: historyLimitRef.current,
    };
    if (!validateWithWasm("client", request)) {
      setHistoryPagingState("retry");
      setHistoryPagingMessage("The history request did not pass protocol checks. The current page cursor was kept so you can retry.");
      return;
    }
    const requestStartOrder = messagesRef.current
      .filter((item) => item.packet.room === connectionRoom && Number.isFinite(item.displayOrder))
      .reduce((maximum, item) => Math.max(maximum, item.displayOrder!), -1);
    const pending: PendingHistoryRequest = {
      socket,
      room: connectionRoom,
      requestId: request.requestId,
      cursor,
      requestStartOrder,
      packets: new Map(),
      timeout: 0,
    };
    historyRequestRef.current = pending;
    historyCursorRef.current = cursor;
    setHistoryPagingState("loading");
    setHistoryPagingMessage("Loading older messages from the hub.");
    pending.timeout = window.setTimeout(() => {
      if (historyRequestRef.current !== pending) return;
      historyRequestRef.current = null;
      setHistoryPagingState("retry");
      setHistoryPagingMessage("The hub did not finish this history page. Retry to request the same cursor again.");
    }, 10000);
    try {
      socket.send(JSON.stringify(request));
    } catch {
      window.clearTimeout(pending.timeout);
      historyRequestRef.current = null;
      setHistoryPagingState("retry");
      setHistoryPagingMessage("The history request could not be sent. Retry the same page when the hub is connected.");
    }
  }

  function failHistoryRequest(pending: PendingHistoryRequest, message: string): void {
    if (historyRequestRef.current !== pending) return;
    window.clearTimeout(pending.timeout);
    historyRequestRef.current = null;
    historyCursorRef.current = pending.cursor;
    setHistoryPagingState("retry");
    setHistoryPagingMessage(message);
  }

  function makeSyncCoordinator(transport: "hub" | "direct", connectionRoom: string, send: (packet: SyncPacket | MessagePacket) => void): SyncCoordinator {
    return new SyncCoordinator({
      room: connectionRoom,
      sender: identity?.sender ?? "",
      makeId,
      send: (packet) => {
        if (!validateWithWasm("client", packet)) throw new Error("The synchronization packet failed protocol checks.");
        send(packet);
      },
      loadAccepted: () => conversationStore.loadMessages(connectionRoom),
      validateMessage: (packet) => validateWithWasm("message", packet),
      rebroadcastOnPeerInventory: true,
      messageIntervalMs: transport === "hub" ? 700 : 0,
      onState: (state, detail) => {
        const active = transport === "hub"
          ? currentRoomRef.current === connectionRoom && socketRef.current?.readyState === WebSocket.OPEN
          : currentRoomRef.current === connectionRoom && directRef.current?.currentState === "connected" && fingerprintConfirmedRef.current;
        if (active) setSyncStatus({ state, detail });
      },
    });
  }

  function startHubSync(socket: WebSocket, connectionRoom: string): void {
    hubSyncRef.current?.stop();
    const coordinator = makeSyncCoordinator("hub", connectionRoom, (packet) => {
      if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || currentRoomRef.current !== connectionRoom) throw new Error("The hub session ended.");
      socket.send(JSON.stringify(packet));
    });
    hubSyncRef.current = coordinator;
    setSyncStatus({ state: "syncing", detail: "Exchanging bounded local message inventories over the hub." });
    void coordinator.start();
  }

  function startDirectSync(transport: DirectWebRtcTransport, connectionRoom: string): void {
    directSyncRef.current?.stop();
    const coordinator = makeSyncCoordinator("direct", connectionRoom, (packet) => {
      if (directRef.current !== transport || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || currentRoomRef.current !== connectionRoom) throw new Error("The direct session ended.");
      transport.send(JSON.stringify(packet));
    });
    directSyncRef.current = coordinator;
    setSyncStatus({ state: "syncing", detail: "Exchanging bounded local message inventories over the confirmed direct session." });
    void coordinator.start();
  }

  function closeDirectTransport() {
    directSyncRef.current?.stop();
    directSyncRef.current = null;
    directRef.current?.close();
    directRef.current = null;
    directInFlightRef.current.clear();
    fingerprintConfirmedRef.current = false;
    setDirectState("closed");
    setPeerFingerprint(null);
    setTrustedFingerprint("");
    setFingerprintConfirmed(false);
    setLocalSignal("");
  }

  function stopRoomTransports() {
    shouldReconnectRef.current = false;
    setLinkRequested(false);
    setLinkState("offline");
    const pendingHistory = historyRequestRef.current;
    if (pendingHistory) {
      window.clearTimeout(pendingHistory.timeout);
      historyRequestRef.current = null;
      setHistoryPagingState("retry");
      setHistoryPagingMessage("The connection closed before this history page finished. Retry the same cursor after reconnecting.");
    }
    const socket = socketRef.current;
    hubSyncRef.current?.stop();
    hubSyncRef.current = null;
    socketRef.current = null;
    socket?.close();
    closeDirectTransport();
  }

  function publishRoomDeletion(type: "deleting" | "deleted" | "cancelled", selectedRoom: string) {
    deletionChannelRef.current?.postMessage({
      version: 1,
      type,
      room: selectedRoom,
      sender: tabIdRef.current,
    });
  }

  async function resumeRoomForUserAction(selectedRoom: string): Promise<void> {
    const generation = deletionGenerationRef.current;
    await conversationStore.resumeRoomMessages(selectedRoom);
    if (deletionInProgressRef.current || deletingRoom || generation !== deletionGenerationRef.current) {
      if (deletionEventsRef.current.get(selectedRoom) === "deleted") {
        await conversationStore.beginRoomDeletion(selectedRoom);
        await conversationStore.deleteRoomMessages(selectedRoom);
      }
      throw new Error("A room deletion took priority over resuming this room.");
    }
  }

  async function reconcileHubReplayPacket(selectedRoom: string, socket: WebSocket, messageId: string): Promise<boolean> {
    const replayOrder = hubReplayOrderRef.current;
    if (!replayOrder || replayOrder.socket !== socket || replayOrder.room !== selectedRoom) return true;
    if (!replayOrder.ids.includes(messageId)) replayOrder.ids.push(messageId);
    return conversationStore.reconcileHubReplayOrder(selectedRoom, replayOrder.ids);
  }

  useEffect(() => {
    let active = true;
    void initializeWasmProtocol().then((ready) => {
      if (!active) return;
      setWasmReady(ready);
      setWasmFailed(!ready);
      if (!ready) {
        shouldReconnectRef.current = false;
        setLinkRequested(false);
        setLinkState("error");
        setNotice(WASM_PROTOCOL_FAILURE_NOTICE);
        socketRef.current?.close();
        socketRef.current = null;
        closeDirectTransport();
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const dialog = roomDeletionDialogRef.current;
    if (!confirmRoomDeletion || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      roomDeletionOpenerRef.current?.focus();
      roomDeletionOpenerRef.current = null;
    };
  }, [confirmRoomDeletion]);

  useEffect(() => {
    if (deletingRoom || !focusDeletionStatusRef.current) return;
    focusDeletionStatusRef.current = false;
    deletionStatusRef.current?.focus();
  }, [deletingRoom, notice]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(ROOM_DELETION_CHANNEL);
    deletionChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { version?: unknown; type?: unknown; room?: unknown; sender?: unknown };
      if (message.version !== 1 || message.sender === tabIdRef.current || typeof message.room !== "string" || message.room !== currentRoomRef.current) return;
      if (message.type === "deleting") {
        deletionGenerationRef.current += 1;
        deletionEventsRef.current.set(message.room, "deleting");
        deletionInProgressRef.current = true;
        setDeletingRoom(true);
        stopRoomTransports();
        setNotice("Another open tab is clearing this room's local messages.");
        return;
      }
      if (message.type === "deleted") {
        deletionGenerationRef.current += 1;
        deletionEventsRef.current.set(message.room, "deleted");
        deletionInProgressRef.current = true;
        setDeletingRoom(true);
        stopRoomTransports();
        setMessages([]);
        messageKeysRef.current.clear();
        setConflictedHubMessageKeys((current) => new Set([...current].filter((key) => !key.startsWith(`${message.room}\u0000`))));
        setRoomDeletedLocally(true);
        setNotice("Saved messages for this room were deleted from this device in another tab. Hub-retained history may appear if you reconnect.");
        deletionInProgressRef.current = false;
        setDeletingRoom(false);
        return;
      }
      if (message.type === "cancelled") {
        const cancelledRoom = message.room as string;
        deletionGenerationRef.current += 1;
        deletionEventsRef.current.set(cancelledRoom, "cancelled");
        const cancelledGeneration = deletionGenerationRef.current;
        void Promise.all([conversationStore.loadMessages(cancelledRoom), conversationStore.isRoomMessagesDeleted(cancelledRoom)]).then(([stored, deleted]) => {
          if (currentRoomRef.current !== cancelledRoom || deletionGenerationRef.current !== cancelledGeneration || deletionEventsRef.current.get(cancelledRoom) !== "cancelled") return;
          setMessages(stored);
          messageKeysRef.current = new Set(stored.map((item) => `${item.packet.room}\u0000${item.packet.id}`));
          setRoomDeletedLocally(deleted);
          deletionInProgressRef.current = false;
          setDeletingRoom(false);
          setNotice("The other tab could not delete the conversation. Saved messages are shown again.");
        }).catch(() => {
          if (currentRoomRef.current !== cancelledRoom || deletionGenerationRef.current !== cancelledGeneration || deletionEventsRef.current.get(cancelledRoom) !== "cancelled") return;
          deletionInProgressRef.current = false;
          setDeletingRoom(false);
          setNotice("The other tab could not delete the conversation, and this tab could not reload its saved messages.");
        });
      }
    };
    return () => {
      deletionChannelRef.current = null;
      channel.close();
    };
  }, []);

  useEffect(() => {
    let active = true;
    conversationStore.loadIdentity().then((saved) => {
      if (!active) return;
      const next = saved ?? { sender: makeId(), senderName: "" };
      setIdentity(next);
      if (!callSignEditedRef.current) setDisplayName(next.senderName);
      setProfileSaved(Boolean(saved?.senderName.trim()));
      if (!saved) void conversationStore.saveIdentity(next).catch(() => setNotice("Local identity could not be saved on this device."));
      setStorageReady(true);
    }).catch(() => {
      if (active) {
        setNotice("Local storage is unavailable. Messages may not survive a reload.");
        setIdentity({ sender: makeId(), senderName: "" });
        setProfileSaved(false);
        setStorageReady(true);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void conversationStore.requestStoragePersistence().then((result) => {
      if (active) setStoragePersistence(result);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    hubSyncRef.current?.stop();
    hubSyncRef.current = null;
    closeDirectTransport();
    setSyncStatus({ state: "idle", detail: "" });
    setSignalInput("");
    setSendTransport("hub");
    if (!hasHubInboundFailure(hubInboundFailuresRef.current, room.trim())) {
      setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
    }
    if (room && !writeLocalSetting(ROOM_KEY, room)) {
      setNotice("Your room setting could not be saved. Re-enter it if you reload this page.");
    }
    setRoomDeletedLocally(false);
    const pendingHistory = historyRequestRef.current;
    if (pendingHistory) window.clearTimeout(pendingHistory.timeout);
    historyRequestRef.current = null;
    historyCursorRef.current = undefined;
    historyLimitRef.current = MAX_HISTORY_PAGE_MESSAGES;
    historyRestartedRef.current = false;
    joinedHistoryHubUrlRef.current = null;
    lastHubPeersRef.current = null;
    hubReplayOrderRef.current = null;
    setHistoryPagingState("unavailable");
    setHistoryPagingMessage("");
    setHistoryTruncated(false);
    setConversationReady(false);
    setLoadedRoom(null);
    setMessages([]);
    messageKeysRef.current.clear();
    let active = true;
    if (room.trim()) {
      const selectedRoom = room.trim();
      Promise.all([conversationStore.loadMessages(selectedRoom), conversationStore.isRoomMessagesDeleted(selectedRoom)]).then(([stored, deleted]) => { if (active) { setMessages(stored); messageKeysRef.current = new Set(stored.map((item) => `${selectedRoom}\u0000${item.packet.id}`)); for (const item of stored) if (item.failure === "message_conflict") conflictedHubMessageKeysRef.current.add(`${selectedRoom}\u0000${item.packet.id}`); setRoomDeletedLocally(deleted); setLoadedRoom(selectedRoom); setConversationReady(true); } }).catch(() => { if (active) { setMessages([]); messageKeysRef.current.clear(); setLoadedRoom(selectedRoom); setNotice("Could not read this conversation from local storage."); setConversationReady(true); } });
    } else {
      setMessages([]);
      messageKeysRef.current.clear();
      setRoomDeletedLocally(false);
      setLoadedRoom("");
      setConversationReady(true);
    }
    return () => { active = false; };
  }, [room]);

  useEffect(() => () => directRef.current?.close(), []);

  useEffect(() => {
    const capture = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      installEvent.preventDefault();
      setInstallPrompt(installEvent);
      setIsInstallable(true);
    };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", () => setIsInstallable(false));
    if ("serviceWorker" in navigator && import.meta.env.PROD) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);

  useEffect(() => {
    if (skipHistoryAutoScrollRef.current) {
      skipHistoryAutoScrollRef.current = false;
      return;
    }
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!linkRequested || !wasmReady || !storageReady || !conversationReady || !identity || !room.trim()) return;
    shouldReconnectRef.current = true;
    let cancelled = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (cancelled || !shouldReconnectRef.current) return;
      let target: URL;
      try {
        target = new URL(hubUrl.trim());
        if (target.protocol !== "ws:" && target.protocol !== "wss:") throw new Error("Use a ws:// or wss:// hub address.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Enter a valid hub address.");
        setLinkState("error");
        setLinkRequested(false);
        return;
      }
      setLinkState(attemptRef.current === 0 ? "connecting" : "retrying");
      const socket = new WebSocket(target.toString());
      socketRef.current = socket;
      socket.onopen = () => {
        if (cancelled) { socket.close(); return; }
        attemptRef.current = 0;
        setLinkState("linking");
        const joinPacket: ClientPacket = { version: PROTOCOL_VERSION, type: "join", room: room.trim(), sender: identity.sender, senderName: identity.senderName };
        if (!validateWithWasm("client", joinPacket)) {
          shouldReconnectRef.current = false;
          setLinkRequested(false);
          setLinkState("error");
          setNotice("The room request did not pass protocol checks and was not sent. Check your saved call sign and room code.");
          socket.close();
          return;
        }
        try { socket.send(JSON.stringify(joinPacket)); }
        catch { setNotice("Could not reach the hub. The radio will retry."); socket.close(); }
      };
      socket.onmessage = async (event) => {
        if (socketRef.current !== socket) return;
        const rawPacket = String(event.data);
        let packet: unknown;
        try { packet = JSON.parse(rawPacket); } catch { setNotice("The hub sent unreadable data. It was ignored."); return; }
        if (!validateJsonWithWasm("server", rawPacket) || !validateWithWasm("server", packet)) {
          noteInvalidSyncPacket(packet, hubSyncRef.current);
          setNotice("The hub sent an invalid or oversized packet. It was ignored.");
          return;
        }
        if (packet.type === "joined") {
          if (packet.room !== room.trim()) { setNotice("The hub confirmed a different room. Check the room code."); return; }
          const joinedHubUrl = socket.url;
          if (joinedHistoryHubUrlRef.current !== null && joinedHistoryHubUrlRef.current !== joinedHubUrl) {
            const pendingHistory = historyRequestRef.current;
            if (pendingHistory) window.clearTimeout(pendingHistory.timeout);
            historyRequestRef.current = null;
            historyCursorRef.current = undefined;
            historyLimitRef.current = MAX_HISTORY_PAGE_MESSAGES;
            historyRestartedRef.current = false;
            setHistoryPagingState("available");
            setHistoryPagingMessage("");
            setHistoryTruncated(Boolean(packet.historyTruncated));
          }
          joinedHistoryHubUrlRef.current = joinedHubUrl;
          lastHubPeersRef.current = packet.peers;
          hubReplayOrderRef.current = { socket, room: packet.room, ids: [] };
          setPeers(packet.peers);
          setLinkState("online");
          setHistoryTruncated((current) => current || Boolean(packet.historyTruncated));
          setHistoryPagingState((current) => current === "retry" || current === "unsupported" || current === "done" ? current : "available");
          if (packet.historyTruncated) setHistoryPagingMessage("Some retained room history is unavailable. You can still load older messages that remain on the hub.");
          setNotice(packet.historyTruncated
            ? "The hub could not replay the full room history. Older messages may be unavailable."
            : hasHubInboundFailure(hubInboundFailuresRef.current, room.trim()) ? HUB_REPLAY_FAILURE_NOTICE : "");
          for (const item of messagesRef.current) {
            const messageKey = `${item.packet.room}\u0000${item.packet.id}`;
            if (item.direction === "outgoing" && item.delivery === "queued" && (item.transport ?? "hub") === "hub" && !conflictedHubMessageKeysRef.current.has(messageKey)) {
              if (!validateWithWasm("message", item.packet)) { setNotice("A saved message did not pass protocol checks and was not sent."); continue; }
              try { socket.send(JSON.stringify(item.packet)); }
              catch { setNotice("Your queued messages are saved. The radio will retry."); socket.close(); break; }
            }
          }
          return;
        }
        if (packet.type === "sync_inventory_page" || packet.type === "sync_missing_request" || packet.type === "sync_page_complete") {
          const coordinator = hubSyncRef.current;
          if (!coordinator) return;
          const operation = hubInboundTailRef.current.catch(() => undefined).then(() => coordinator.receive(packet));
          hubInboundTailRef.current = operation.then(() => undefined, () => undefined);
          return;
        }
        if (packet.type === "presence") {
          const replayOrder = hubReplayOrderRef.current;
          if (replayOrder?.socket === socket && replayOrder.room === room.trim()) {
            const barrier = hubInboundTailRef.current.catch(() => undefined).then(() => {
              if (hubReplayOrderRef.current === replayOrder) hubReplayOrderRef.current = null;
              if (socketRef.current === socket && currentRoomRef.current === replayOrder.room) startHubSync(socket, replayOrder.room);
            });
            hubInboundTailRef.current = barrier.then(() => undefined, () => undefined);
          } else if (lastHubPeersRef.current !== null && packet.peers > lastHubPeersRef.current) {
            startHubSync(socket, room.trim());
          }
          lastHubPeersRef.current = packet.peers;
          setPeers(packet.peers);
          return;
        }
        if (packet.type === "ack") {
          const pending = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === room.trim() && item.direction === "outgoing" && (item.transport ?? "hub") === "hub");
          if (!pending) return;
          let saved = true;
          try { await conversationStore.updateDelivery(pending.packet.room, packet.id, "sent"); }
          catch { saved = false; }
          if (socketRef.current !== socket) return;
          setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === pending.packet.room ? { ...item, delivery: "sent" } : item));
          if (!saved) setNotice("The hub accepted your message, but its status could not be saved on this device. It may be retried after reload.");
          return;
        }
        if (packet.type === "error") {
          const connectionRoom = room.trim();
          const pendingHistory = historyRequestRef.current;
          const historyRateLimited = packet.code === "history_rate_limited"
            || (packet.code === "rate_limited" && packet.message.toLowerCase().includes("history"));
          if (pendingHistory?.socket === socket && pendingHistory.room === connectionRoom
            && (historyRateLimited || ["invalid_cursor", "history_packet_too_large", "history_page_too_large", "not_joined", "invalid_packet"].includes(packet.code))) {
            if (historyRateLimited) {
              failHistoryRequest(pendingHistory, "The hub rate-limited this history request. Wait briefly, then retry the same page.");
              return;
            }
            if (packet.code === "invalid_cursor") {
              window.clearTimeout(pendingHistory.timeout);
              historyRequestRef.current = null;
              if (!historyRestartedRef.current && pendingHistory.cursor !== null) {
                historyRestartedRef.current = true;
                historyCursorRef.current = null;
                setHistoryPagingState("available");
                setHistoryPagingMessage("The hub no longer recognizes this cursor. Restarting from its newest retained history.");
                requestOlderHistory(null);
              } else {
                failHistoryRequest(pendingHistory, "The hub rejected this history cursor. Retry from the newest retained history.");
              }
              return;
            }
            if (packet.code === "history_packet_too_large" || packet.code === "history_page_too_large") {
              window.clearTimeout(pendingHistory.timeout);
              historyRequestRef.current = null;
              historyCursorRef.current = pendingHistory.cursor;
              historyLimitRef.current = Math.max(1, Math.floor(historyLimitRef.current / 2));
              setHistoryPagingState("retry");
              setHistoryPagingMessage("This history page exceeded the hub limit. Retry the same cursor with a smaller page.");
              return;
            }
            if (packet.code === "invalid_packet") {
              window.clearTimeout(pendingHistory.timeout);
              historyRequestRef.current = null;
              setHistoryPagingState("unsupported");
              setHistoryPagingMessage("This hub does not support versioned history pages. Update the local hub to load older messages.");
              return;
            }
            failHistoryRequest(pendingHistory, "The hub session ended before history could load. Reconnect, then retry the same page.");
            return;
          }
          const guidance = packet.code === "capacity_reached" ? "Try a different room or reconnect later."
            : packet.code === "rate_limited" ? "Wait a moment before sending again."
              : packet.code === "storage_unavailable" ? "The message can be retried when hub storage is available."
                : packet.code === "message_conflict" ? "This message ID conflicts with saved content and was not accepted."
                  : "Review the room and message details.";
          if (packet.code === "rate_limited" && packet.id) {
            hubSyncRef.current?.noteMessageRateLimited("The hub rate-limited a sync message. This exchange is incomplete. Reconnect to restart from saved messages.");
          } else if (packet.code === "sync_rate_limited" || (packet.code === "rate_limited" && !historyRateLimited)) {
            hubSyncRef.current?.noteControlRateLimited("The hub rate-limited a synchronization control. This exchange is incomplete. Reconnect to restart from saved messages.");
          }
          if (packet.id) {
            const rejected = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === connectionRoom && item.direction === "outgoing");
            if (rejected) {
              const rejectedKey = `${rejected.packet.room}\u0000${rejected.packet.id}`;
              if (packet.code === "message_conflict" && (rejected.transport ?? "hub") === "hub") {
                conflictedHubMessageKeysRef.current.add(rejectedKey);
                setConflictedHubMessageKeys((current) => new Set(current).add(rejectedKey));
              }
              let saved = true;
              try { await conversationStore.updateDelivery(rejected.packet.room, packet.id, "failed", packet.code === "message_conflict" && (rejected.transport ?? "hub") === "hub" ? "message_conflict" : undefined); }
              catch { saved = false; }
              setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === rejected.packet.room
                ? { ...item, delivery: "failed", ...(packet.code === "message_conflict" && (rejected.transport ?? "hub") === "hub" ? { failure: "message_conflict" as const } : {}) }
                : item));
              if (!saved && socketRef.current === socket && currentRoomRef.current === rejected.packet.room) setNotice("The hub rejected your message, but its status could not be saved on this device.");
            }
          }
          if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
          setNotice(`${packet.message} ${guidance} (${packet.code})`);
          return;
        }
        if (packet.type === "history_page_complete") {
          const pending = historyRequestRef.current;
          if (!pending || pending.socket !== socket || pending.room !== packet.room || pending.requestId !== packet.requestId) return;
          const completion = packet as HistoryPageCompletePacket;
          const operation = hubInboundTailRef.current.catch(() => undefined).then(async () => {
            if (historyRequestRef.current !== pending || socketRef.current !== socket || currentRoomRef.current !== pending.room) return;
            if (hasHubInboundFailure(hubInboundFailuresRef.current, pending.room)) {
              failHistoryRequest(pending, "A streamed history message could not be saved. Retry this page; its cursor has not advanced.");
              return;
            }
            const persisted = await conversationStore.loadMessages(pending.room);
            const pageMessages: StoredMessage[] = [];
            for (const id of completion.messageIds) {
              const packetForId = pending.packets.get(id);
              const existing = persisted.find((item) => item.packet.id === id);
              const source = packetForId ?? existing?.packet;
              if (!source || source.room !== pending.room || source.id !== id || !validateWithWasm("message", source)) {
                failHistoryRequest(pending, "The history page was incomplete or invalid. Retry the same cursor; it has not advanced.");
                return;
              }
              if (existing && !sameMessagePacket(existing.packet, source)) {
                failHistoryRequest(pending, "A history message conflicts with saved content. The cursor was kept so the page can be reviewed again.");
                return;
              }
              pageMessages.push({
                packet: source,
                direction: source.sender === identity?.sender ? "outgoing" : "incoming",
                delivery: "sent",
                transport: "hub",
                ...(existing?.displayOrder === undefined ? {} : { displayOrder: existing.displayOrder }),
              });
            }
            const computedBytes = pageMessages.reduce((total, item) => total + compactPacketBytes(item.packet), 0);
            if (computedBytes !== completion.pageBytes) {
              failHistoryRequest(pending, "The history page size did not match the received messages. Retry the same cursor.");
              return;
            }
            try {
              const saved = await conversationStore.saveHubHistoryPage(pageMessages, pending.cursor, pending.requestStartOrder);
              if (!saved) {
                failHistoryRequest(pending, "This room was cleared on this device. Resume it before loading hub history again.");
                return;
              }
              const verified = await conversationStore.loadMessages(pending.room);
              if (!completion.messageIds.every((id) => {
                const expected = pageMessages.find((item) => item.packet.id === id)?.packet;
                const actual = verified.find((item) => item.packet.id === id)?.packet;
                return Boolean(expected && actual && sameMessagePacket(expected, actual));
              })) {
                failHistoryRequest(pending, "The saved history page could not be verified. Retry the same cursor.");
                return;
              }
              if (historyRequestRef.current !== pending || socketRef.current !== socket || currentRoomRef.current !== pending.room) return;
              skipHistoryAutoScrollRef.current = true;
              setMessages(verified);
              for (const id of completion.messageIds) messageKeysRef.current.add(`${pending.room}\u0000${id}`);
              historyCursorRef.current = completion.hasMore ? completion.nextCursor : pending.cursor;
              historyLimitRef.current = MAX_HISTORY_PAGE_MESSAGES;
              historyRestartedRef.current = false;
              window.clearTimeout(pending.timeout);
              historyRequestRef.current = null;
              setHistoryTruncated((current) => current || completion.historyTruncated);
              setHistoryPagingState(completion.hasMore ? "available" : "done");
              setHistoryPagingMessage(completion.historyTruncated
                ? "Some older room history has expired or was removed. The messages shown follow hub acceptance order."
                : completion.hasMore ? "History page saved. Load the next older page when ready." : "No more retained hub history is available.");
            } catch {
              failHistoryRequest(pending, "Could not save or verify this history page. Retry the same cursor; it has not advanced.");
            }
          });
          hubInboundTailRef.current = operation.then(() => undefined, () => undefined);
          return;
        }
        if (packet.type === "message") {
          if (packet.room !== room.trim()) return;
          const messageKey = `${packet.room}\u0000${packet.id}`;
          const connectionRoom = room.trim();
          const previous = hubInboundOperationsRef.current.get(messageKey) ?? Promise.resolve();
          const operation = Promise.all([hubInboundTailRef.current.catch(() => undefined), previous.catch(() => undefined)]).then(async () => {
            if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
            const pending = historyRequestRef.current;
            if (pending?.socket === socket && pending.room === connectionRoom) pending.packets.set(packet.id, packet);
            const persisted = await conversationStore.loadMessages(connectionRoom).catch(() => null);
            if (!persisted || socketRef.current !== socket || currentRoomRef.current !== connectionRoom) {
              if (!persisted && currentRoomRef.current === connectionRoom) {
                hubSyncRef.current?.rejectMessage(packet, "A requested sync message could not be read from storage. Reconnect to restart synchronization.");
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
              }
              return;
            }
            const existing = persisted.find((entry) => entry.packet.id === packet.id);
            if (existing) {
              if (!sameMessagePacket(existing.packet, packet)) {
                hubSyncRef.current?.rejectMessage(packet, "A requested sync message conflicted with saved content. Reconnect to restart synchronization.");
                setNotice("The hub replay used an ID that conflicts with saved message content. The saved message was kept and the replay was ignored.");
                return;
              }
              if (existing.transport !== "hub" || existing.delivery !== "sent") {
                try {
                  const saved = await conversationStore.saveMessage({ ...existing, transport: "hub", delivery: "sent" });
                  if (!saved) throw new Error("Room deletion blocked this replay.");
                } catch {
              hubSyncRef.current?.rejectMessage(packet, "A requested sync message could not be saved. Reconnect to restart synchronization.");
                  hubInboundFailuresRef.current.add(messageKey);
                  setNotice(HUB_REPLAY_FAILURE_NOTICE);
                  return;
                }
              }
              try {
                const reconciled = await reconcileHubReplayPacket(connectionRoom, socket, packet.id);
                if (!reconciled) return;
              } catch {
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
                return;
              }
              hubInboundFailuresRef.current.delete(messageKey);
              hubSyncRef.current?.observeAcceptedMessage(packet);
              messageKeysRef.current.add(messageKey);
              if (!hasHubInboundFailure(hubInboundFailuresRef.current, connectionRoom)) setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
              const refreshed = await conversationStore.loadMessages(connectionRoom);
              if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
              setMessages(refreshed);
              return;
            }
            const item: StoredMessage = { packet, direction: packet.sender === identity.sender ? "outgoing" : "incoming", delivery: "sent", transport: "hub" };
            try {
              const saved = await conversationStore.saveMessage(item);
              if (!saved) {
                if (currentRoomRef.current === connectionRoom) setNotice("This room was cleared on this device. Reconnect to resume the room; hub-retained history may replay.");
                return;
              }
            } catch {
              hubSyncRef.current?.rejectMessage(packet, "A requested sync message could not be saved. Reconnect to restart synchronization.");
              if (currentRoomRef.current === connectionRoom) {
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
              }
              return;
            }
            try {
              const reconciled = await reconcileHubReplayPacket(connectionRoom, socket, packet.id);
              if (!reconciled) return;
            } catch {
              if (currentRoomRef.current === connectionRoom) {
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
              }
              return;
            }
            if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
            hubInboundFailuresRef.current.delete(messageKey);
            hubSyncRef.current?.observeAcceptedMessage(packet);
            messageKeysRef.current.add(messageKey);
            if (!hasHubInboundFailure(hubInboundFailuresRef.current, connectionRoom)) setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
            const refreshed = await conversationStore.loadMessages(connectionRoom);
            if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
            setMessages(refreshed);
          });
          hubInboundOperationsRef.current.set(messageKey, operation);
          hubInboundTailRef.current = operation.then(() => undefined, () => undefined);
          void operation.finally(() => {
            if (hubInboundOperationsRef.current.get(messageKey) === operation) hubInboundOperationsRef.current.delete(messageKey);
          });
        }
      };
      socket.onerror = () => setNotice("The radio link reported a socket error. Retrying automatically.");
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (hubSyncRef.current) {
          hubSyncRef.current.stop();
          hubSyncRef.current = null;
          setSyncStatus({ state: "partial", detail: "The connection ended. Reconnect to restart message synchronization from fresh inventories." });
        }
        const pendingHistory = historyRequestRef.current;
        if (pendingHistory?.socket === socket) failHistoryRequest(pendingHistory, "The connection closed before this history page finished. Reconnect, then retry the same cursor.");
        if (cancelled || !shouldReconnectRef.current) return;
        setLinkState("retrying");
        attemptRef.current += 1;
        retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** Math.min(attemptRef.current, 5), 30000));
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      shouldReconnectRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      attemptRef.current = 0;
    };
  }, [linkRequested, wasmReady, storageReady, conversationReady, identity, room, hubUrl]);

  const sortedMessages = useMemo(() => loadedRoom === room.trim() ? [...messages].sort((a, b) => {
    const left = Number.isFinite(a.displayOrder) ? a.displayOrder! : Number.MAX_SAFE_INTEGER;
    const right = Number.isFinite(b.displayOrder) ? b.displayOrder! : Number.MAX_SAFE_INTEGER;
    return left - right;
  }) : [], [loadedRoom, messages, room]);
  const normalizedName = displayName.trim();
  const conversationLoaded = storageReady && conversationReady && loadedRoom === room.trim();
  const composerReady = conversationLoaded && !roomDeletedLocally;
  const diagnosticsCountsReady = Boolean(room.trim() && conversationLoaded && !deletingRoom);
  const diagnosticsRows = diagnosticsCountsReady ? messages.filter((item) => item.packet.room === room.trim()) : [];
  const diagnosticsSummary = buildDiagnosticsSummary({
    hubState: linkState,
    directState,
    protocolState: wasmFailed ? "unavailable" : wasmReady ? "ready" : "loading",
    storageState: storagePersistence,
    conversationReady: diagnosticsCountsReady,
    messageCounts: diagnosticsCountsReady ? {
      total: diagnosticsRows.length,
      queued: diagnosticsRows.filter((item) => item.delivery === "queued").length,
      sent: diagnosticsRows.filter((item) => item.delivery === "sent").length,
      failed: diagnosticsRows.filter((item) => item.delivery === "failed").length,
    } : null,
  });
  const diagnosticsText = formatDiagnosticsSummary(diagnosticsSummary);
  const showManualDiagnostics = manualDiagnosticsText === diagnosticsText;
  const diagnosticsSummaryChangedAfterCopyFailure = manualDiagnosticsText !== null && !showManualDiagnostics;
  const visibleDiagnosticsCopyStatus = diagnosticsSummaryChangedAfterCopyFailure ? "" : diagnosticsCopyStatus;

  useEffect(() => {
    if (!diagnosticsSummaryChangedAfterCopyFailure) return;
    setManualDiagnosticsText(null);
    setDiagnosticsCopyStatus("Diagnostics changed. Copy the updated summary if needed.");
  }, [diagnosticsSummaryChangedAfterCopyFailure, diagnosticsText]);
  const profileReady = Boolean(wasmReady && profileSaved && identity?.senderName.trim() && identity.senderName.trim() === normalizedName && validateWithWasm("identifier", identity.sender) && isValidCallSign(identity.senderName) && validateWithWasm("room", room.trim()));
  const canJoin = Boolean(profileReady && room.trim() && hubUrl.trim());
  const canSaveProfile = Boolean(wasmReady && identity && validateWithWasm("identifier", identity.sender) && isValidCallSign(normalizedName) && validateWithWasm("room", room.trim()) && (sendTransport === "direct" || hubUrl.trim()));
  const linkLabel = linkState === "online" ? "On frequency" : linkState === "linking" ? "Calling station" : linkState === "connecting" || linkState === "retrying" ? "Finding signal" : linkState === "error" ? "Check settings" : "Standby";

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deletionInProgressRef.current || deletingRoom) return;
    if (!wasmReady || !identity || !validateWithWasm("identifier", identity.sender) || !isValidCallSign(normalizedName) || !validateWithWasm("room", room.trim())) return;
    const nextIdentity = { ...identity, senderName: normalizedName };
    setIdentity(nextIdentity);
    let identitySaved = true;
    try { await conversationStore.saveIdentity(nextIdentity); }
    catch { identitySaved = false; }
    if (deletionInProgressRef.current || deletingRoom) return;
    setProfileSaved(identitySaved && Boolean(nextIdentity.senderName.trim()));
    const settingsSaved = writeLocalSetting(HUB_KEY, hubUrl.trim());
    if (sendTransport === "direct") {
      setLinkRequested(false);
      setLinkState("offline");
    } else {
      try {
        await resumeRoomForUserAction(room.trim());
        if (deletionInProgressRef.current || deletingRoom) return;
        setRoomDeletedLocally(false);
      } catch {
        setLinkRequested(false);
        setNotice("Could not resume this room after its local messages were cleared.");
        return;
      }
      setLinkRequested(true);
    }
    setNotice(!identitySaved ? "Your identity could not be saved. It may change if you reload this page." : !settingsSaved ? "Your station settings could not be saved. Re-enter them if you reload this page." : sendTransport === "direct" ? "Profile saved for direct peer setup. The hub remains disconnected." : "");
  }

  function makeDirectTransport(): DirectWebRtcTransport {
    const connectionRoom = room.trim();
    directRef.current?.close();
    directRef.current = null;
    const transport = new DirectWebRtcTransport();
    directRef.current = transport;
    directInFlightRef.current.clear();
    fingerprintConfirmedRef.current = false;
    setFingerprintConfirmed(false);
    setPeerFingerprint(null);
    transport.onStateChange = (state) => {
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
      setDirectState(state);
      if (state !== "connected") {
        if (directSyncRef.current) {
          directSyncRef.current.stop();
          directSyncRef.current = null;
          setSyncStatus({ state: "partial", detail: "The direct session ended. Reconnect and confirm the session fingerprint to restart synchronization." });
        }
        fingerprintConfirmedRef.current = false;
        directInFlightRef.current.clear();
        setFingerprintConfirmed(false);
      }
    };
    transport.onError = (error) => {
      if (directRef.current === transport && currentRoomRef.current === connectionRoom) setNotice(error.message);
    };
    directInboundTailRef.current = Promise.resolve();
    transport.onMessage = (data) => {
      const operation = directInboundTailRef.current.catch(() => undefined).then(() => processDirectData(transport, connectionRoom, data));
      directInboundTailRef.current = operation.then(() => undefined, () => undefined);
    };
    setDirectState("new");
    return transport;
  }

  async function processDirectData(transport: DirectWebRtcTransport, connectionRoom: string, data: unknown) {
    if (directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || typeof data !== "string") return;
    let packet: unknown;
    try { packet = JSON.parse(data); } catch { setNotice("The direct peer sent unreadable data. It was ignored."); return; }
    if (data.length > MAX_PROTOCOL_ENVELOPE_BYTES || (!validateJsonWithWasm("server", data) && !validateJsonWithWasm("message", data))) {
      noteInvalidSyncPacket(packet, directSyncRef.current);
      setNotice("The direct peer sent an invalid or oversized packet. It was ignored.");
      return;
    }
    if (validateWithWasm("server", packet) && packet.type === "ack") {
      const key = `${connectionRoom}\u0000${packet.id}`;
      if (!directInFlightRef.current.has(key)) return;
      const persisted = await conversationStore.loadMessages(connectionRoom).catch(() => null);
      if (!persisted || directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || !directInFlightRef.current.has(key)) return;
      const pending = persisted.find((item) => item.packet.id === packet.id && item.direction === "outgoing" && item.transport === "direct");
      if (!pending) return;
      directInFlightRef.current.delete(key);
      try {
        await conversationStore.updateDelivery(connectionRoom, packet.id, "sent");
        if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
        setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === connectionRoom ? { ...item, delivery: "sent", transport: "direct" } : item));
      } catch {
        if (currentRoomRef.current === connectionRoom) setNotice("The peer accepted your message, but its status could not be saved on this device.");
      }
      return;
    }
    if (validateWithWasm("server", packet)
      && (packet.type === "sync_inventory_page" || packet.type === "sync_missing_request" || packet.type === "sync_page_complete")) {
      await directSyncRef.current?.receive(packet);
      return;
    }
    if (validateWithWasm("server", packet) && packet.type === "error" && packet.code === "rate_limited" && packet.id) {
      directSyncRef.current?.noteMessageRateLimited("A peer rejected a sync message. This exchange is incomplete. Reconnect to restart from saved messages.");
      return;
    }
    if (!validateWithWasm("message", packet) || packet.room !== connectionRoom) return;
    const messageKey = `${packet.room}\u0000${packet.id}`;
    const previous = directInboundOperationsRef.current.get(messageKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current) return;
      const existing = await conversationStore.loadMessages(connectionRoom).catch(() => null);
      if (!existing || directRef.current !== transport || currentRoomRef.current !== connectionRoom) {
        if (!existing && currentRoomRef.current === connectionRoom) {
          directSyncRef.current?.rejectMessage(packet, "A requested sync message could not be checked in storage. Reconnect to restart synchronization.");
          setNotice("The direct message could not be checked against local storage, so it was not accepted.");
        }
        return;
      }
      const duplicate = existing.find((item) => item.packet.id === packet.id);
      if (duplicate) {
        if (!sameMessagePacket(duplicate.packet, packet)) {
          directSyncRef.current?.rejectMessage(packet, "A requested sync message conflicted with saved content. Reconnect to restart synchronization.");
          if (currentRoomRef.current === connectionRoom) setNotice("A conflicting direct message used an already saved message ID. It was ignored.");
          return;
        }
        directSyncRef.current?.observeAcceptedMessage(packet);
        messageKeysRef.current.add(messageKey);
        if (fingerprintConfirmedRef.current && transport.currentState === "connected") {
          const ack: AcknowledgmentPacket = { version: PROTOCOL_VERSION, type: "ack", id: packet.id };
          if (!validateWithWasm("server", ack)) return;
          try { transport.send(JSON.stringify(ack)); } catch { setNotice("The saved duplicate could not be acknowledged. It remains saved on this device."); }
        }
        return;
      }
      const item: StoredMessage = { packet, direction: "incoming", delivery: "sent", transport: "direct" };
      try {
        const saved = await conversationStore.saveMessage(item);
        if (!saved) {
          if (currentRoomRef.current === connectionRoom) setNotice("This room was cleared on this device. Reconnect to resume the room; hub-retained history may replay.");
          return;
        }
      } catch {
        directSyncRef.current?.rejectMessage(packet, "A requested sync message could not be saved. Reconnect to restart synchronization.");
        if (currentRoomRef.current === connectionRoom) setNotice("The direct message arrived, but could not be saved. No acknowledgment was sent.");
        return;
      }
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
      directSyncRef.current?.observeAcceptedMessage(packet);
      messageKeysRef.current.add(messageKey);
      setMessages((current) => current.some((entry) => entry.packet.room === packet.room && entry.packet.id === packet.id) ? current : [...current, item].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)));
      if (fingerprintConfirmedRef.current && transport.currentState === "connected") {
        const ack: AcknowledgmentPacket = { version: PROTOCOL_VERSION, type: "ack", id: packet.id };
        if (!validateWithWasm("server", ack)) return;
        try { transport.send(JSON.stringify(ack)); }
        catch { setNotice("The message was saved, but the peer acknowledgment could not be sent."); }
      }
    });
    directInboundOperationsRef.current.set(messageKey, operation);
    try { await operation; }
    finally { if (directInboundOperationsRef.current.get(messageKey) === operation) directInboundOperationsRef.current.delete(messageKey); }
  }

  async function createDirectOffer() {
    if (deletionInProgressRef.current || deletingRoom || !wasmReady) return;
    try { await resumeRoomForUserAction(room.trim()); }
    catch { setNotice("Could not resume this room after its local messages were cleared."); return; }
    if (deletionInProgressRef.current || deletingRoom) return;
    setRoomDeletedLocally(false);
    setDirectBusy(true);
    setLocalSignal("");
    const connectionRoom = room.trim();
    let transport: DirectWebRtcTransport | null = null;
    try {
      transport = makeDirectTransport();
      const signal = await transport.createOffer();
      if (directRef.current === transport && currentRoomRef.current === connectionRoom) setLocalSignal(signal);
    }
    catch (error) {
      if (!transport || directRef.current === transport) {
        setNotice(error instanceof Error ? error.message : "Could not create a direct offer.");
        closeDirectTransport();
      }
    }
    finally { setDirectBusy(false); }
  }

  async function acceptDirectOffer() {
    if (deletionInProgressRef.current || deletingRoom || !wasmReady) return;
    try { await resumeRoomForUserAction(room.trim()); }
    catch { setNotice("Could not resume this room after its local messages were cleared."); return; }
    if (deletionInProgressRef.current || deletingRoom) return;
    setRoomDeletedLocally(false);
    setDirectBusy(true);
    setLocalSignal("");
    const connectionRoom = room.trim();
    let transport: DirectWebRtcTransport | null = null;
    try {
      transport = makeDirectTransport();
      const answer = await transport.acceptOffer(signalInput);
      if (directRef.current === transport && currentRoomRef.current === connectionRoom) {
        setLocalSignal(answer);
        setPeerFingerprint(transport.peerFingerprint);
      }
    } catch (error) {
      if (!transport || directRef.current === transport) {
        setNotice(error instanceof Error ? error.message : "Could not accept the direct offer.");
        closeDirectTransport();
      }
    }
    finally { setDirectBusy(false); }
  }

  async function acceptDirectAnswer() {
    if (deletionInProgressRef.current || deletingRoom || !wasmReady) return;
    try { await resumeRoomForUserAction(room.trim()); }
    catch { setNotice("Could not resume this room after its local messages were cleared."); return; }
    if (deletionInProgressRef.current || deletingRoom) return;
    setRoomDeletedLocally(false);
    const transport = directRef.current;
    if (!transport) { setNotice("Create a direct offer before accepting an answer."); return; }
    const connectionRoom = room.trim();
    setDirectBusy(true);
    try {
      await transport.acceptAnswer(signalInput);
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
      setPeerFingerprint(transport.peerFingerprint);
      fingerprintConfirmedRef.current = false;
      setFingerprintConfirmed(false);
    } catch (error) {
      if (directRef.current === transport) {
        setNotice(error instanceof Error ? error.message : "Could not accept the direct answer.");
        closeDirectTransport();
      }
    }
    finally { setDirectBusy(false); }
  }

  function confirmFingerprint() {
    const received = peerFingerprint ? normalizeFingerprint(peerFingerprint) : null;
    const supplied = normalizeFingerprint(trustedFingerprint);
    if (!received || !supplied || received !== supplied) {
      fingerprintConfirmedRef.current = false;
      setFingerprintConfirmed(false);
      setNotice("Fingerprint does not match. Compare the complete fingerprint over your separate trusted channel.");
      return;
    }
    fingerprintConfirmedRef.current = true;
    setFingerprintConfirmed(true);
    if (directRef.current?.currentState === "connected") startDirectSync(directRef.current, currentRoomRef.current);
    setNotice("Fingerprint matches this DTLS session. It does not verify a lasting identity or a real-world person.");
    flushQueuedDirectMessages();
  }

  function sendDirectMessage(item: StoredMessage): boolean {
    if (!wasmReady || !validateWithWasm("message", item.packet)) {
      setNotice("The saved message did not pass protocol checks and was not sent.");
      return false;
    }
    const transport = directRef.current;
    const key = `${item.packet.room}\u0000${item.packet.id}`;
    if (!transport || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || currentRoomRef.current !== item.packet.room || directInFlightRef.current.has(key)) return false;
    try {
      directInFlightRef.current.add(key);
      transport.send(JSON.stringify(item.packet));
      return true;
    } catch {
      directInFlightRef.current.delete(key);
      setNotice("The message remains queued on this device because the direct link is unavailable.");
      return false;
    }
  }

  async function flushQueuedDirectMessages() {
    const transport = directRef.current;
    const flushRoom = currentRoomRef.current;
    if (!transport || transport.currentState !== "connected" || !fingerprintConfirmedRef.current) return;
    const savedMessages = await conversationStore.loadMessages(flushRoom).catch(() => null);
    if (!savedMessages || directRef.current !== transport || currentRoomRef.current !== flushRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current) return;
    for (const item of savedMessages) {
      if (item.direction === "outgoing" && item.delivery === "queued" && item.transport === "direct") sendDirectMessage(item);
    }
  }

  async function retryMessage(message: StoredMessage) {
    if (!wasmReady || !validateWithWasm("message", message.packet)) {
      setNotice("The saved message did not pass protocol checks and could not be retried.");
      return;
    }
    const messageKey = `${message.packet.room}\u0000${message.packet.id}`;
    if (retryingMessageKeysRef.current.has(messageKey)) return;
    retryingMessageKeysRef.current.add(messageKey);
    setRetryingMessageKeys(new Set(retryingMessageKeysRef.current));
    try {
      await conversationStore.updateDelivery(message.packet.room, message.packet.id, "queued", null);
    } catch {
      setNotice("Could not queue this message for retry on this device.");
      return;
    } finally {
      retryingMessageKeysRef.current.delete(messageKey);
      setRetryingMessageKeys(new Set(retryingMessageKeysRef.current));
    }
    conflictedHubMessageKeysRef.current.delete(messageKey);
    setConflictedHubMessageKeys((current) => {
      const next = new Set(current);
      next.delete(messageKey);
      return next;
    });
    setMessages((current) => current.map((item) => item.packet.id === message.packet.id && item.packet.room === message.packet.room ? { ...item, delivery: "queued", failure: undefined } : item));
    if (activeRoomRef.current === message.packet.room) {
      if (message.transport === "direct") {
        sendDirectMessage(message);
      } else if ((message.transport ?? "hub") === "hub" && linkState === "online" && socketRef.current?.readyState === WebSocket.OPEN) {
        if (!validateWithWasm("message", message.packet)) {
          setNotice("The saved message did not pass protocol checks and was not sent.");
          return;
        }
        try { socketRef.current.send(JSON.stringify(message.packet)); }
        catch {
          setNotice("The message is queued on this device. The radio will reconnect and retry it.");
          socketRef.current.close();
        }
      }
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (deletionInProgressRef.current || !wasmReady || !storageReady || !conversationReady || loadedRoom !== room.trim() || pendingSendRef.current || !profileReady || !identity || !body || !room.trim()) return;
    pendingSendRef.current = true;
    let finishPendingSend!: () => void;
    const pendingSendOperation = new Promise<void>((resolve) => { finishPendingSend = resolve; });
    pendingSendOperationRef.current = pendingSendOperation;
    try {
      const submittedDraft = draft;
      const messageRoom = room.trim();
      const packet: MessagePacket = {
        version: PROTOCOL_VERSION,
        type: "message",
        id: makeId(),
        room: messageRoom,
        sender: identity.sender,
        senderName: identity.senderName,
        createdAt: new Date().toISOString(),
        body,
      };
      if (!validateWithWasm("message", packet)) {
        setNotice("Check your saved call sign, room code, and message text. This message was not queued.");
        return;
      }
      const item: StoredMessage = { packet, direction: "outgoing", delivery: "queued", transport: sendTransport };
      messageKeysRef.current.add(`${packet.room}\u0000${packet.id}`);
      setMessages((current) => [...current, item]);
      try {
        const saved = await conversationStore.saveMessage(item);
        if (!saved) {
          messageKeysRef.current.delete(`${packet.room}\u0000${packet.id}`);
          setMessages((current) => current.filter((entry) => entry.packet.id !== packet.id || entry.packet.room !== packet.room));
          setNotice("This room was cleared on this device. Reconnect to resume the room; hub-retained history may replay.");
          return;
        }
      }
      catch {
        messageKeysRef.current.delete(`${packet.room}\u0000${packet.id}`);
        setMessages((current) => current.filter((entry) => entry.packet.id !== packet.id || entry.packet.room !== packet.room));
        if (activeRoomRef.current === messageRoom) setNotice("Could not save this message on this device. It has not been queued for delivery.");
        return;
      }
      if (activeRoomRef.current === messageRoom) {
        setDraft((current) => current === submittedDraft ? "" : current);
        if (sendTransport === "direct") {
          sendDirectMessage(item);
        } else if (sendTransport === "hub" && linkState === "online" && socketRef.current?.readyState === WebSocket.OPEN) {
          try { socketRef.current.send(JSON.stringify(packet)); }
          catch {
            setNotice("The message is saved on this device. The radio will reconnect and retry it.");
            socketRef.current.close();
          }
        }
      }
    } finally {
      pendingSendRef.current = false;
      if (pendingSendOperationRef.current === pendingSendOperation) pendingSendOperationRef.current = null;
      finishPendingSend();
    }
  }

  async function clearRoomConversation() {
    const selectedRoom = room.trim();
    if (!selectedRoom || !conversationReady || loadedRoom !== selectedRoom || deletionInProgressRef.current) return;
    deletionInProgressRef.current = true;
    deletionGenerationRef.current += 1;
    deletionEventsRef.current.set(selectedRoom, "deleting");
    focusDeletionStatusRef.current = true;
    setDeletingRoom(true);
    setConfirmRoomDeletion(false);
    stopRoomTransports();
    publishRoomDeletion("deleting", selectedRoom);
    let deletionMarkerStarted = false;
    try {
      await conversationStore.beginRoomDeletion(selectedRoom);
      deletionMarkerStarted = true;
      const roomOperations = [
        ...hubInboundOperationsRef.current.values(),
        ...directInboundOperationsRef.current.values(),
      ];
      const pendingSend = pendingSendOperationRef.current;
      await Promise.all([...roomOperations, ...(pendingSend ? [pendingSend] : [])].map((operation) => operation.catch(() => undefined)));
      await conversationStore.deleteRoomMessages(selectedRoom);
      if (currentRoomRef.current === selectedRoom) {
        setMessages([]);
        messageKeysRef.current.clear();
        setRoomDeletedLocally(true);
        for (const key of hubInboundFailuresRef.current) if (key.startsWith(`${selectedRoom}\u0000`)) hubInboundFailuresRef.current.delete(key);
        for (const key of conflictedHubMessageKeysRef.current) if (key.startsWith(`${selectedRoom}\u0000`)) conflictedHubMessageKeysRef.current.delete(key);
        setConflictedHubMessageKeys((current) => new Set([...current].filter((key) => !key.startsWith(`${selectedRoom}\u0000`))));
        setNotice("Saved and queued messages for this room were deleted from this device. Hub history was not deleted and may appear after you reconnect.");
      }
      publishRoomDeletion("deleted", selectedRoom);
      deletionEventsRef.current.set(selectedRoom, "deleted");
    } catch {
      let markerCleanupFailed = false;
      if (deletionMarkerStarted) {
        try { await conversationStore.cancelRoomDeletion(selectedRoom); }
        catch { markerCleanupFailed = true; }
      }
      if (markerCleanupFailed) {
        deletionEventsRef.current.set(selectedRoom, "deleting");
        if (currentRoomRef.current === selectedRoom) {
          setRoomDeletedLocally(true);
          setNotice("The conversation could not be deleted or unlocked. This room remains locked on this device. Retry deletion or reload the app to try again.");
        }
      } else {
        deletionEventsRef.current.set(selectedRoom, "cancelled");
        publishRoomDeletion("cancelled", selectedRoom);
        if (currentRoomRef.current === selectedRoom) setNotice("Could not delete the saved conversation. Your local messages were kept.");
      }
    } finally {
      deletionInProgressRef.current = false;
      setDeletingRoom(false);
    }
  }

  async function toggleLink() {
    if (deletionInProgressRef.current || deletingRoom || !wasmReady) return;
    if (linkRequested) {
      setLinkRequested(false);
      setLinkState("offline");
      setNotice("Radio switched to standby.");
    } else {
      try {
        await resumeRoomForUserAction(room.trim());
      } catch {
        setNotice("Could not resume this room after its local messages were cleared.");
        return;
      }
      if (deletionInProgressRef.current || deletingRoom) return;
      setRoomDeletedLocally(false);
      const settingsSaved = writeLocalSetting(HUB_KEY, hubUrl.trim());
      setLinkRequested(true);
      setNotice(settingsSaved ? "" : "Your station settings could not be saved. Re-enter them if you reload this page.");
    }
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
    setIsInstallable(false);
  }

  async function copyDiagnostics() {
    const text = diagnosticsText;
    setDiagnosticsCopyStatus("");
    setManualDiagnosticsText(null);
    if (!navigator.clipboard?.writeText) {
      setManualDiagnosticsText(text);
      setDiagnosticsCopyStatus("Clipboard access is unavailable. Copy the summary from the text box below.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setDiagnosticsCopyStatus("Diagnostics summary copied.");
    } catch {
      setManualDiagnosticsText(text);
      setDiagnosticsCopyStatus("Clipboard access failed. Copy the summary from the text box below.");
    }
  }

  const groups: { label: string; items: StoredMessage[] }[] = [];
  for (const item of sortedMessages) {
    const label = formatDate(item.packet.createdAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <main className="station-shell">
      <aside className="station-sidebar" aria-label="Station controls">
        <div className="brand-lockup">
          <div className="brand-mark"><SignalMark active={linkState === "online"} /></div>
          <div><p className="eyebrow">NearLink</p><p className="brand-caption">LOCAL STATION <span>·</span> NL-01</p></div>
        </div>

        <section className="control-panel">
          <div className="section-label"><span>01</span><h2>Station setup</h2></div>
          <form className="station-form" onSubmit={saveProfile}>
            <label htmlFor="display-name">Your call sign</label>
            <input id="display-name" autoComplete="nickname" maxLength={48} placeholder="e.g. Sam" value={displayName} onChange={(event) => { callSignEditedRef.current = true; setDisplayName(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />

            <label htmlFor="room-code">Room frequency</label>
            <input id="room-code" maxLength={64} placeholder="Enter a shared room code" value={room} disabled={deletingRoom} onChange={(event) => { setConversationReady(false); setRoom(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />

            <label htmlFor="hub-address">Hub address</label>
            <input id="hub-address" type="url" inputMode="url" spellCheck={false} placeholder="ws://192.168.1.20:8000/ws" value={hubUrl} disabled={deletingRoom} onChange={(event) => { setHubUrl(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />
            <p className="field-hint">Use your hub’s LAN address on another device.</p>

            <button className="primary-button" type="submit" disabled={deletingRoom || !canSaveProfile || (linkRequested && sendTransport === "hub")}>
              <span className="button-dot" />{sendTransport === "direct" ? "Save profile for direct link" : linkRequested ? "Station settings saved" : "Save and join room"}
            </button>
          </form>
        </section>

        <section className="direct-panel" aria-labelledby="direct-title">
          <div className="section-label"><span>02</span><h2 id="direct-title">Direct peer link</h2></div>
          <p className="direct-description">Create an offer on one device, exchange the complete JSON, then accept it on the other device. Compare the fingerprint in person or through an authenticated channel different from the SDP exchange. Otherwise, an intermediary could replace both the signaling data and fingerprint. This host-only connection may require both devices to share a reachable local network. No public STUN or TURN server is configured.</p>
          <div className="direct-actions">
            <button type="button" onClick={() => void createDirectOffer()} disabled={deletingRoom || !wasmReady || !conversationLoaded || !profileReady || directBusy}>Create offer</button>
            <button type="button" onClick={() => void acceptDirectOffer()} disabled={deletingRoom || !wasmReady || !conversationLoaded || !profileReady || directBusy || !signalInput.trim()}>Accept offer</button>
            <button type="button" onClick={() => void acceptDirectAnswer()} disabled={deletingRoom || !wasmReady || !conversationLoaded || !profileReady || directBusy || !signalInput.trim() || !directRef.current}>Accept answer</button>
          </div>
          <label htmlFor="direct-signal-input">Paste peer offer or answer JSON</label>
          <textarea id="direct-signal-input" value={signalInput} onChange={(event) => setSignalInput(event.target.value)} rows={3} spellCheck={false} />
          {localSignal && <>
            <label htmlFor="direct-signal-output">Your signaling JSON to share</label>
            <textarea id="direct-signal-output" value={localSignal} readOnly rows={3} spellCheck={false} />
          </>}
          <p className="direct-state" role="status" aria-live="polite">Direct channel: {directState}. {fingerprintConfirmed ? "Fingerprint confirmed for this session." : "Messages over this link require fingerprint confirmation."}</p>
          {peerFingerprint && <>
            <label htmlFor="peer-fingerprint">Remote SDP DTLS fingerprint</label>
            <output id="peer-fingerprint" className="fingerprint-value">{peerFingerprint}</output>
            <label htmlFor="trusted-fingerprint">Fingerprint compared in person or through the separate authenticated channel</label>
            <input id="trusted-fingerprint" value={trustedFingerprint} onChange={(event) => { setTrustedFingerprint(event.target.value); fingerprintConfirmedRef.current = false; setFingerprintConfirmed(false); }} autoComplete="off" spellCheck={false} />
            <button type="button" className="fingerprint-confirm" onClick={confirmFingerprint} disabled={directState !== "connected"}>Compare fingerprints</button>
            <p className="fingerprint-limit">A match verifies only this DTLS session. It does not prove a lasting device identity or the real-world person you are speaking with.</p>
          </>}
          <button type="button" className="direct-close" onClick={closeDirectTransport} disabled={!directRef.current}>Close direct link</button>
        </section>

        <section className="frequency-card" aria-label="Local range indicator">
          <div className="frequency-head"><span>LOCAL RANGE</span><span className="frequency-index">0{linkState === "online" ? 4 : linkState === "linking" ? 2 : 1}</span></div>
          <div className={`range-visual ${linkState === "online" ? "range-live" : ""}`} aria-hidden="true">
            <span className="range-ring ring-one" /><span className="range-ring ring-two" /><span className="range-ring ring-three" />
            <span className="range-core"><SignalMark active={linkState === "online"} /></span>
          </div>
          <div className="range-caption"><strong>{linkState === "online" ? "IN RANGE" : "SCANNING"}</strong><span>{linkState === "online" ? `${peers} ${peers === 1 ? "station" : "stations"} nearby` : "Hub connection required"}</span></div>
          <div className="range-scale"><span>LOCAL</span><i /><i /><i /><i className={linkState === "online" ? "lit" : ""} /><span>HUB</span></div>
        </section>

        <div className="sidebar-bottom">
          <button type="button" className={`link-toggle ${linkRequested ? "is-on" : ""}`} onClick={toggleLink} disabled={deletingRoom || !canJoin}>
            <span className="toggle-state"><i /></span><span>{linkRequested ? "Disconnect radio" : "Connect radio"}</span>
          </button>
          {isInstallable && <button type="button" className="install-button" onClick={() => void installApp()}>Install NearLink</button>}
          <p className="local-note"><span>◈</span> Stored on this device<br />Room codes route messages, they do not verify identity.</p>
        </div>
      </aside>

      <section className="conversation-panel" aria-label="Room conversation">
        <header className="conversation-header">
          <div className="room-ident">
            <div className="room-symbol" aria-hidden="true">⌁</div>
            <div><p className="eyebrow">CURRENT FREQUENCY</p><h1>{room.trim() || "No room selected"}</h1></div>
          </div>
          <div className="header-right">
            <div className={`connection-status status-${linkState}`} role="status" aria-live="polite"><span /><div><strong>{linkLabel}</strong><small>{linkState === "online" ? `${peers} connected` : linkState === "retrying" ? "Reconnecting" : linkState === "offline" ? "Local messages ready" : "Stand by"}</small></div></div>
            <SignalMark active={linkState === "online"} />
          </div>
          <button type="button" className="clear-room-button" disabled={!room.trim() || !conversationReady || deletingRoom} onClick={(event) => { roomDeletionOpenerRef.current = event.currentTarget; setConfirmRoomDeletion(true); }}>Clear this device's saved conversation</button>
        </header>

        {syncStatus.state !== "idle" && <p className={`sync-status sync-${syncStatus.state}`} role="status" aria-live="polite">Message sync: {syncStatus.detail}</p>}

        <details className="diagnostics-panel">
          <summary>Connection diagnostics</summary>
          <p>Share these connection states and counts when asking for support. Message content and station details are not included.</p>
          <dl className="diagnostics-grid">
            <div><dt>Hub</dt><dd>{diagnosticsSummary.hub}</dd></div>
            <div><dt>Direct peer</dt><dd>{diagnosticsSummary.direct}</dd></div>
            <div><dt>Protocol checks</dt><dd>{diagnosticsSummary.protocol}</dd></div>
            <div><dt>Browser storage</dt><dd>{diagnosticsSummary.storage}</dd></div>
            {diagnosticsSummary.conversation.counts ? <>
              <div><dt>Messages</dt><dd>{diagnosticsSummary.conversation.counts.total}</dd></div>
              <div><dt>Queued</dt><dd>{diagnosticsSummary.conversation.counts.queued}</dd></div>
              <div><dt>Sent</dt><dd>{diagnosticsSummary.conversation.counts.sent}</dd></div>
              <div><dt>Failed</dt><dd>{diagnosticsSummary.conversation.counts.failed}</dd></div>
            </> : <div className="diagnostics-unavailable"><dt>Message counts</dt><dd>Unavailable while the selected conversation loads or changes</dd></div>}
          </dl>
          <button type="button" className="diagnostics-copy" onClick={() => void copyDiagnostics()}>Copy diagnostics summary</button>
          {visibleDiagnosticsCopyStatus && <p className="diagnostics-copy-status" role="status" aria-live="polite">{visibleDiagnosticsCopyStatus}</p>}
          {showManualDiagnostics && <div className="diagnostics-manual-copy">
            <label htmlFor="diagnostics-manual-text">Copy this summary manually</label>
            <textarea id="diagnostics-manual-text" rows={7} readOnly value={manualDiagnosticsText ?? ""} />
          </div>}
        </details>

        <dialog ref={roomDeletionDialogRef} aria-labelledby="delete-room-title" aria-describedby="delete-room-description" className="delete-room-confirmation" onCancel={() => setConfirmRoomDeletion(false)}>
          <h2 id="delete-room-title">Clear saved messages for {room.trim()}?</h2>
          <p id="delete-room-description">This deletes saved and queued messages for this room only on this device. Your identity and settings stay saved. The hub's retained history is not affected and may appear again after you reconnect.</p>
          <button type="button" disabled={deletingRoom} onClick={() => setConfirmRoomDeletion(false)}>Keep messages</button>
          <button type="button" disabled={deletingRoom} onClick={() => void clearRoomConversation()}>{deletingRoom ? "Clearing messages…" : "Delete local messages"}</button>
        </dialog>

        {wasmFailed && <div className="notice-banner" role="alert"><span aria-hidden="true">!</span>{WASM_PROTOCOL_FAILURE_NOTICE}</div>}
        <div className="notice-banner" role="status" aria-live="polite"><span aria-hidden="true">!</span>{storagePersistence === "checking"
          ? "Checking this browser's storage retention setting."
          : storagePersistence === "granted"
            ? "The browser reports that NearLink storage is persistent. This may reduce automatic clearing, but it does not guarantee retention. Messages may still be lost through user action, device loss, or browser behavior. This is not a backup."
            : "This browser cannot assure that saved messages will be retained. Messages may still be lost through user action, device loss, or browser behavior. This is not a backup."}</div>
        <div ref={messageScrollRef} className="message-scroll" role="log" aria-label={`Messages in ${room.trim() || "the selected room"}`} aria-live="polite" aria-relevant="additions" tabIndex={0}>
          {notice && <div ref={deletionStatusRef} className="notice-banner" role="status" tabIndex={-1}><span>!</span>{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button></div>}
          {historyPagingState !== "unavailable" && <section className="history-controls" aria-label="Older room history">
            {historyPagingState === "loading" ? <p role="status" aria-live="polite" aria-busy="true">Loading older messages…</p>
              : historyPagingState === "done" ? <p role="status" aria-live="polite">No more retained hub history is available.</p>
                : historyPagingState === "unsupported" ? <p role="status" aria-live="polite">This hub does not support older history pages. Update the local hub to load older messages.</p>
                  : <button type="button" onClick={() => requestOlderHistory()} disabled={linkState !== "online" || deletingRoom}>
                    {historyPagingState === "retry" ? "Retry loading older messages" : "Load older messages"}
                  </button>}
            {historyPagingMessage && historyPagingState !== "loading" && historyPagingState !== "done" && <p role="status" aria-live="polite">{historyPagingMessage}</p>}
            {historyTruncated && <p className="history-retention-gap" role="status" aria-live="polite">Some older room history is unavailable because the hub reported a retention gap.</p>}
          </section>}
          {sortedMessages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><SignalMark active={false} /></div>
              <p className="eyebrow">OPEN CHANNEL</p>
              <h2>Quiet on this frequency.</h2>
              <p>Join a room to meet nearby stations. Messages sent while offline wait here until your radio reconnects.</p>
              <div className="empty-coordinates"><span>LOCAL ROOM</span><i /><span>READY WHEN YOU ARE</span></div>
            </div>
          ) : groups.map((group, index) => (
            <section className="message-day" key={`${group.label}-${index}`}>
              <div className="day-divider"><span>{group.label}</span><i /></div>
              {group.items.map(({ packet, direction, delivery, transport, failure }) => (
                <article key={`${packet.room}:${packet.id}`} className={`message-row ${direction === "outgoing" ? "message-outgoing" : "message-incoming"}`}>
                  <div className="message-avatar" aria-hidden="true">{(packet.senderName || "?").slice(0, 1).toUpperCase()}</div>
                  <div className="message-content">
                    <div className="message-meta"><strong>{direction === "outgoing" ? "You" : packet.senderName || "Unknown station"}</strong><time dateTime={packet.createdAt}>{formatTime(packet.createdAt)}</time></div>
                    <div className="message-bubble">{packet.body}</div>
                    {direction === "outgoing" && <div className={`delivery-state ${delivery}`}>
                      <span className="delivery-glyph">{delivery === "sent" ? "✓" : delivery === "failed" ? "!" : "◷"}</span>
                      {delivery === "sent" ? (transport === "direct" ? "Accepted by peer device" : "Accepted by hub") : delivery === "failed" ? failure === "message_conflict" || conflictedHubMessageKeys.has(`${packet.room}\u0000${packet.id}`) ? "This ID conflicts with saved content. Compose a new message to send with a new ID." : <>Not accepted <button type="button" className="retry-button" disabled={retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`)} aria-busy={retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`)} onClick={() => void retryMessage({ packet, direction, delivery, transport })}>{retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`) ? "Retrying…" : "Retry"}</button></> : "Queued on this device"}
                    </div>}
                  </div>
                </article>
              ))}
            </section>
          ))}
          <div ref={messageEndRef} />
        </div>

        <footer className="composer-wrap">
          <form className="composer" aria-busy={!composerReady} onSubmit={sendMessage}>
            <label className="sr-only" htmlFor="message-draft">Write a message</label>
            <textarea id="message-draft" rows={1} maxLength={4000} placeholder={!composerReady ? "Loading saved messages…" : room.trim() ? "Write a message to this room…" : "Choose a room to start a message"} value={draft} disabled={!composerReady || !room.trim() || deletingRoom} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            <div className="composer-tools"><label className="transport-choice">Send via <select aria-label="Message transport" value={sendTransport} onChange={(event) => setSendTransport(event.target.value as "hub" | "direct")}><option value="hub">Local hub</option><option value="direct">Direct peer</option></select></label><span><kbd>↵</kbd> send <span className="tool-divider">·</span> <kbd>⇧ ↵</kbd> new line</span><span className="char-count">{draft.length}/4000</span><button type="submit" className="send-button" disabled={deletingRoom || !composerReady || !profileReady || !draft.trim() || !room.trim()} aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 12h14.5m0 0-6-6m6 6-6 6" /></svg></button></div>
          </form>
          <div className="composer-foot"><span role="status" aria-live="polite"><i className={sendTransport === "direct" ? (directState === "connected" && fingerprintConfirmed ? "foot-live" : "") : linkState === "online" ? "foot-live" : ""} />{!composerReady ? "Loading saved messages" : sendTransport === "direct" ? directState === "connected" && fingerprintConfirmed ? "Session fingerprint compared" : "Direct messages remain queued until session confirmation" : linkState === "online" ? "Connected to local hub" : "Messages save locally until a hub is connected"}</span><span>NEARLINK <b>·</b> LOCAL FIRST</span></div>
        </footer>
      </section>
    </main>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export default App;
