import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { isMessagePacket, isProtocolRoom, isServerPacket, PROTOCOL_VERSION, type AcknowledgmentPacket, type ClientPacket, type MessagePacket } from "@nearlink/protocol";
import { loadIdentity, loadMessages, saveIdentity, saveMessage, updateDelivery, type LocalIdentity, type StoredMessage } from "./lib/storage";
import { DirectWebRtcTransport, type TransportState } from "./lib/webrtc";

type LinkState = "offline" | "connecting" | "linking" | "online" | "retrying" | "error";
const DEFAULT_HUB = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname || "localhost"}:8000/ws`;
const HUB_KEY = "nearlink.hub";
const ROOM_KEY = "nearlink.room";
const HUB_REPLAY_FAILURE_NOTICE = "A hub message could not be saved or checked on this device. It was not accepted and can be retried after reconnecting.";

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
  return isMessagePacket({
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

function hasHubInboundFailure(failures: Set<string>, room: string): boolean {
  const prefix = `${room}\u0000`;
  return [...failures].some((key) => key.startsWith(prefix));
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
  const [sendTransport, setSendTransport] = useState<"hub" | "direct">("hub");
  const socketRef = useRef<WebSocket | null>(null);
  const directRef = useRef<DirectWebRtcTransport | null>(null);
  const messagesRef = useRef(messages);
  const messageKeysRef = useRef(new Set<string>());
  const conflictedHubMessageKeysRef = useRef(new Set<string>());
  const retryingMessageKeysRef = useRef(new Set<string>());
  const activeRoomRef = useRef(room.trim());
  const pendingSendRef = useRef(false);
  const shouldReconnectRef = useRef(false);
  const attemptRef = useRef(0);
  const currentRoomRef = useRef(room.trim());
  const fingerprintConfirmedRef = useRef(fingerprintConfirmed);
  const directInFlightRef = useRef(new Set<string>());
  const directInboundOperationsRef = useRef(new Map<string, Promise<void>>());
  const hubInboundOperationsRef = useRef(new Map<string, Promise<void>>());
  const hubInboundFailuresRef = useRef(new Set<string>());
  const messageEndRef = useRef<HTMLDivElement>(null);

  messagesRef.current = messages;
  activeRoomRef.current = room.trim();
  currentRoomRef.current = room.trim();
  fingerprintConfirmedRef.current = fingerprintConfirmed;

  function closeDirectTransport() {
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

  useEffect(() => {
    let active = true;
    loadIdentity().then((saved) => {
      if (!active) return;
      const next = saved ?? { sender: makeId(), senderName: "" };
      setIdentity(next);
      setDisplayName(next.senderName);
      setProfileSaved(Boolean(saved?.senderName.trim()));
      if (!saved) void saveIdentity(next).catch(() => setNotice("Local identity could not be saved on this device."));
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
    closeDirectTransport();
    setSignalInput("");
    setSendTransport("hub");
    if (!hasHubInboundFailure(hubInboundFailuresRef.current, room.trim())) {
      setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
    }
    if (room && !writeLocalSetting(ROOM_KEY, room)) {
      setNotice("Your room setting could not be saved. Re-enter it if you reload this page.");
    }
    setConversationReady(false);
    setLoadedRoom(null);
    setMessages([]);
    messageKeysRef.current.clear();
    let active = true;
    if (room.trim()) {
      loadMessages(room.trim()).then((stored) => { if (active) { setMessages(stored); messageKeysRef.current = new Set(stored.map((item) => `${item.packet.room}\u0000${item.packet.id}`)); for (const item of stored) if (item.failure === "message_conflict") conflictedHubMessageKeysRef.current.add(`${item.packet.room}\u0000${item.packet.id}`); setLoadedRoom(room.trim()); setConversationReady(true); } }).catch(() => { if (active) { setMessages([]); messageKeysRef.current.clear(); setLoadedRoom(room.trim()); setNotice("Could not read this conversation from local storage."); setConversationReady(true); } });
    } else {
      setMessages([]);
      messageKeysRef.current.clear();
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
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!linkRequested || !storageReady || !conversationReady || !identity || !room.trim()) return;
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
        try { socket.send(JSON.stringify(joinPacket)); }
        catch { setNotice("Could not reach the hub. The radio will retry."); socket.close(); }
      };
      socket.onmessage = async (event) => {
        if (socketRef.current !== socket) return;
        let packet: unknown;
        try { packet = JSON.parse(String(event.data)); } catch { setNotice("The hub sent unreadable data. It was ignored."); return; }
        if (!isServerPacket(packet)) { setNotice("The hub sent an invalid packet. It was ignored."); return; }
        if (packet.type === "joined") {
          if (packet.room !== room.trim()) { setNotice("The hub confirmed a different room. Check the room code."); return; }
          setPeers(packet.peers);
          setLinkState("online");
          setNotice(packet.historyTruncated
            ? "The hub could not replay the full room history. Older messages may be unavailable."
            : hasHubInboundFailure(hubInboundFailuresRef.current, room.trim()) ? HUB_REPLAY_FAILURE_NOTICE : "");
          for (const item of messagesRef.current) {
            const messageKey = `${item.packet.room}\u0000${item.packet.id}`;
            if (item.direction === "outgoing" && item.delivery === "queued" && (item.transport ?? "hub") === "hub" && !conflictedHubMessageKeysRef.current.has(messageKey)) {
              try { socket.send(JSON.stringify(item.packet)); }
              catch { setNotice("Your queued messages are saved. The radio will retry."); socket.close(); break; }
            }
          }
          return;
        }
        if (packet.type === "presence") { setPeers(packet.peers); return; }
        if (packet.type === "ack") {
          const pending = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === room.trim() && item.direction === "outgoing" && (item.transport ?? "hub") === "hub");
          if (!pending) return;
          let saved = true;
          try { await updateDelivery(pending.packet.room, packet.id, "sent"); }
          catch { saved = false; }
          if (socketRef.current !== socket) return;
          setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === pending.packet.room ? { ...item, delivery: "sent" } : item));
          if (!saved) setNotice("The hub accepted your message, but its status could not be saved on this device. It may be retried after reload.");
          return;
        }
        if (packet.type === "error") {
          const connectionRoom = room.trim();
          const guidance = packet.code === "capacity_reached" ? "Try a different room or reconnect later."
            : packet.code === "rate_limited" ? "Wait a moment before sending again."
              : packet.code === "storage_unavailable" ? "The message can be retried when hub storage is available."
                : packet.code === "message_conflict" ? "This message ID conflicts with saved content and was not accepted."
                  : "Review the room and message details.";
          if (packet.id) {
            const rejected = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === connectionRoom && item.direction === "outgoing");
            if (rejected) {
              const rejectedKey = `${rejected.packet.room}\u0000${rejected.packet.id}`;
              if (packet.code === "message_conflict" && (rejected.transport ?? "hub") === "hub") {
                conflictedHubMessageKeysRef.current.add(rejectedKey);
                setConflictedHubMessageKeys((current) => new Set(current).add(rejectedKey));
              }
              let saved = true;
              try { await updateDelivery(rejected.packet.room, packet.id, "failed", packet.code === "message_conflict" && (rejected.transport ?? "hub") === "hub" ? "message_conflict" : undefined); }
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
        if (packet.type === "message") {
          if (packet.room !== room.trim()) return;
          const messageKey = `${packet.room}\u0000${packet.id}`;
          const connectionRoom = room.trim();
          const previous = hubInboundOperationsRef.current.get(messageKey) ?? Promise.resolve();
          const operation = previous.catch(() => undefined).then(async () => {
            if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
            const persisted = await loadMessages(connectionRoom).catch(() => null);
            if (!persisted || socketRef.current !== socket || currentRoomRef.current !== connectionRoom) {
              if (!persisted && currentRoomRef.current === connectionRoom) {
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
              }
              return;
            }
            const existing = persisted.find((entry) => entry.packet.id === packet.id);
            if (existing) {
              if (!sameMessagePacket(existing.packet, packet)) {
                setNotice("The hub replay used an ID that conflicts with saved message content. The saved message was kept and the replay was ignored.");
                return;
              }
              hubInboundFailuresRef.current.delete(messageKey);
              messageKeysRef.current.add(messageKey);
              if (!hasHubInboundFailure(hubInboundFailuresRef.current, connectionRoom)) setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
              setMessages((current) => current.some((entry) => entry.packet.room === packet.room && entry.packet.id === packet.id)
                ? current
                : [...current, existing].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)));
              return;
            }
            const item: StoredMessage = { packet, direction: packet.sender === identity.sender ? "outgoing" : "incoming", delivery: "sent", transport: "hub" };
            try {
              await saveMessage(item);
            } catch {
              if (currentRoomRef.current === connectionRoom) {
                hubInboundFailuresRef.current.add(messageKey);
                setNotice(HUB_REPLAY_FAILURE_NOTICE);
              }
              return;
            }
            if (socketRef.current !== socket || currentRoomRef.current !== connectionRoom) return;
            hubInboundFailuresRef.current.delete(messageKey);
            messageKeysRef.current.add(messageKey);
            if (!hasHubInboundFailure(hubInboundFailuresRef.current, connectionRoom)) setNotice((current) => current === HUB_REPLAY_FAILURE_NOTICE ? "" : current);
            setMessages((current) => current.some((entry) => entry.packet.room === packet.room && entry.packet.id === packet.id)
              ? current
              : [...current, item].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)));
          });
          hubInboundOperationsRef.current.set(messageKey, operation);
          void operation.finally(() => {
            if (hubInboundOperationsRef.current.get(messageKey) === operation) hubInboundOperationsRef.current.delete(messageKey);
          });
        }
      };
      socket.onerror = () => setNotice("The radio link reported a socket error. Retrying automatically.");
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
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
  }, [linkRequested, storageReady, conversationReady, identity, room, hubUrl]);

  const sortedMessages = useMemo(() => loadedRoom === room.trim() ? [...messages].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)) : [], [loadedRoom, messages, room]);
  const normalizedName = displayName.trim();
  const composerReady = storageReady && conversationReady && loadedRoom === room.trim();
  const profileReady = Boolean(profileSaved && identity?.senderName.trim() && identity.senderName.trim() === normalizedName && isValidCallSign(identity.senderName) && isProtocolRoom(room.trim()));
  const canJoin = Boolean(profileReady && room.trim() && hubUrl.trim());
  const canSaveProfile = Boolean(identity && isValidCallSign(normalizedName) && isProtocolRoom(room.trim()) && (sendTransport === "direct" || hubUrl.trim()));
  const linkLabel = linkState === "online" ? "On frequency" : linkState === "linking" ? "Calling station" : linkState === "connecting" || linkState === "retrying" ? "Finding signal" : linkState === "error" ? "Check settings" : "Standby";

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity || !isValidCallSign(normalizedName) || !isProtocolRoom(room.trim())) return;
    const nextIdentity = { ...identity, senderName: normalizedName };
    setIdentity(nextIdentity);
    let identitySaved = true;
    try { await saveIdentity(nextIdentity); }
    catch { identitySaved = false; }
    setProfileSaved(identitySaved && Boolean(nextIdentity.senderName.trim()));
    const settingsSaved = writeLocalSetting(HUB_KEY, hubUrl.trim());
    if (sendTransport === "direct") {
      setLinkRequested(false);
      setLinkState("offline");
    } else {
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
        fingerprintConfirmedRef.current = false;
        directInFlightRef.current.clear();
        setFingerprintConfirmed(false);
      }
    };
    transport.onError = (error) => {
      if (directRef.current === transport && currentRoomRef.current === connectionRoom) setNotice(error.message);
    };
    transport.onMessage = (data) => { void processDirectData(transport, connectionRoom, data); };
    setDirectState("new");
    return transport;
  }

  async function processDirectData(transport: DirectWebRtcTransport, connectionRoom: string, data: unknown) {
    if (directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || typeof data !== "string") return;
    let packet: unknown;
    try { packet = JSON.parse(data); } catch { setNotice("The direct peer sent unreadable data. It was ignored."); return; }
    if (isServerPacket(packet) && packet.type === "ack") {
      const key = `${connectionRoom}\u0000${packet.id}`;
      if (!directInFlightRef.current.has(key)) return;
      const persisted = await loadMessages(connectionRoom).catch(() => null);
      if (!persisted || directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current || !directInFlightRef.current.has(key)) return;
      const pending = persisted.find((item) => item.packet.id === packet.id && item.direction === "outgoing" && item.transport === "direct");
      if (!pending) return;
      directInFlightRef.current.delete(key);
      try {
        await updateDelivery(connectionRoom, packet.id, "sent");
        if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
        setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === connectionRoom ? { ...item, delivery: "sent", transport: "direct" } : item));
      } catch {
        if (currentRoomRef.current === connectionRoom) setNotice("The peer accepted your message, but its status could not be saved on this device.");
      }
      return;
    }
    if (!isMessagePacket(packet) || packet.room !== connectionRoom) return;
    const messageKey = `${packet.room}\u0000${packet.id}`;
    const previous = directInboundOperationsRef.current.get(messageKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current) return;
      const existing = await loadMessages(connectionRoom).catch(() => null);
      if (!existing || directRef.current !== transport || currentRoomRef.current !== connectionRoom) {
        if (!existing && currentRoomRef.current === connectionRoom) setNotice("The direct message could not be checked against local storage, so it was not accepted.");
        return;
      }
      const duplicate = existing.find((item) => item.packet.id === packet.id);
      if (duplicate) {
        if (!sameMessagePacket(duplicate.packet, packet)) {
          if (currentRoomRef.current === connectionRoom) setNotice("A conflicting direct message used an already saved message ID. It was ignored.");
          return;
        }
        messageKeysRef.current.add(messageKey);
        if (fingerprintConfirmedRef.current && transport.currentState === "connected") {
          const ack: AcknowledgmentPacket = { version: PROTOCOL_VERSION, type: "ack", id: packet.id };
          try { transport.send(JSON.stringify(ack)); } catch { setNotice("The saved duplicate could not be acknowledged. It remains saved on this device."); }
        }
        return;
      }
      const item: StoredMessage = { packet, direction: "incoming", delivery: "sent", transport: "direct" };
      try {
        await saveMessage(item);
      } catch {
        if (currentRoomRef.current === connectionRoom) setNotice("The direct message arrived, but could not be saved. No acknowledgment was sent.");
        return;
      }
      if (directRef.current !== transport || currentRoomRef.current !== connectionRoom) return;
      messageKeysRef.current.add(messageKey);
      setMessages((current) => current.some((entry) => entry.packet.room === packet.room && entry.packet.id === packet.id) ? current : [...current, item].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)));
      if (fingerprintConfirmedRef.current && transport.currentState === "connected") {
        const ack: AcknowledgmentPacket = { version: PROTOCOL_VERSION, type: "ack", id: packet.id };
        try { transport.send(JSON.stringify(ack)); }
        catch { setNotice("The message was saved, but the peer acknowledgment could not be sent."); }
      }
    });
    directInboundOperationsRef.current.set(messageKey, operation);
    try { await operation; }
    finally { if (directInboundOperationsRef.current.get(messageKey) === operation) directInboundOperationsRef.current.delete(messageKey); }
  }

  async function createDirectOffer() {
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
    setNotice("Fingerprint matches this DTLS session. It does not verify a lasting identity or a real-world person.");
    flushQueuedDirectMessages();
  }

  function sendDirectMessage(item: StoredMessage): boolean {
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
    const savedMessages = await loadMessages(flushRoom).catch(() => null);
    if (!savedMessages || directRef.current !== transport || currentRoomRef.current !== flushRoom || transport.currentState !== "connected" || !fingerprintConfirmedRef.current) return;
    for (const item of savedMessages) {
      if (item.direction === "outgoing" && item.delivery === "queued" && item.transport === "direct") sendDirectMessage(item);
    }
  }

  async function retryMessage(message: StoredMessage) {
    const messageKey = `${message.packet.room}\u0000${message.packet.id}`;
    if (retryingMessageKeysRef.current.has(messageKey)) return;
    retryingMessageKeysRef.current.add(messageKey);
    setRetryingMessageKeys(new Set(retryingMessageKeysRef.current));
    try {
      await updateDelivery(message.packet.room, message.packet.id, "queued", null);
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
    if (!storageReady || !conversationReady || loadedRoom !== room.trim() || pendingSendRef.current || !profileReady || !identity || !body || !room.trim()) return;
    pendingSendRef.current = true;
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
    if (!isMessagePacket(packet)) {
      setNotice("Check your saved call sign, room code, and message text. This message was not queued.");
      pendingSendRef.current = false;
      return;
    }
    const item: StoredMessage = { packet, direction: "outgoing", delivery: "queued", transport: sendTransport };
    messageKeysRef.current.add(`${packet.room}\u0000${packet.id}`);
    setMessages((current) => [...current, item]);
    try { await saveMessage(item); }
    catch {
      messageKeysRef.current.delete(`${packet.room}\u0000${packet.id}`);
      setMessages((current) => current.filter((entry) => entry.packet.id !== packet.id || entry.packet.room !== packet.room));
      if (activeRoomRef.current === messageRoom) setNotice("Could not save this message on this device. It has not been queued for delivery.");
      pendingSendRef.current = false;
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
    pendingSendRef.current = false;
  }

  function toggleLink() {
    if (linkRequested) {
      setLinkRequested(false);
      setLinkState("offline");
      setNotice("Radio switched to standby.");
    } else {
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
            <input id="display-name" autoComplete="nickname" maxLength={48} placeholder="e.g. Sam" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />

            <label htmlFor="room-code">Room frequency</label>
            <input id="room-code" maxLength={64} placeholder="Enter a shared room code" value={room} onChange={(event) => { setConversationReady(false); setRoom(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />

            <label htmlFor="hub-address">Hub address</label>
            <input id="hub-address" type="url" inputMode="url" spellCheck={false} placeholder="ws://192.168.1.20:8000/ws" value={hubUrl} onChange={(event) => { setHubUrl(event.target.value); setLinkRequested(false); setLinkState("offline"); }} />
            <p className="field-hint">Use your hub’s LAN address on another device.</p>

            <button className="primary-button" type="submit" disabled={!canSaveProfile || (linkRequested && sendTransport === "hub")}>
              <span className="button-dot" />{sendTransport === "direct" ? "Save profile for direct link" : linkRequested ? "Station settings saved" : "Save and join room"}
            </button>
          </form>
        </section>

        <section className="direct-panel" aria-labelledby="direct-title">
          <div className="section-label"><span>02</span><h2 id="direct-title">Direct peer link</h2></div>
          <p className="direct-description">Create an offer on one device, exchange the complete JSON, then accept it on the other device. Compare the fingerprint in person or through an authenticated channel different from the SDP exchange. Otherwise, an intermediary could replace both the signaling data and fingerprint. This host-only connection may require both devices to share a reachable local network. No public STUN or TURN server is configured.</p>
          <div className="direct-actions">
            <button type="button" onClick={() => void createDirectOffer()} disabled={!composerReady || !profileReady || directBusy}>Create offer</button>
            <button type="button" onClick={() => void acceptDirectOffer()} disabled={!composerReady || !profileReady || directBusy || !signalInput.trim()}>Accept offer</button>
            <button type="button" onClick={() => void acceptDirectAnswer()} disabled={!composerReady || !profileReady || directBusy || !signalInput.trim() || !directRef.current}>Accept answer</button>
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
          <button type="button" className={`link-toggle ${linkRequested ? "is-on" : ""}`} onClick={toggleLink} disabled={!canJoin}>
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
        </header>

        <div className="message-scroll" role="log" aria-label={`Messages in ${room.trim() || "the selected room"}`} aria-live="polite" aria-relevant="additions" tabIndex={0}>
          {notice && <div className="notice-banner" role="status"><span>!</span>{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button></div>}
          {sortedMessages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><SignalMark active={false} /></div>
              <p className="eyebrow">OPEN CHANNEL</p>
              <h2>Quiet on this frequency.</h2>
              <p>Join a room to meet nearby stations. Messages sent while offline wait here until your radio reconnects.</p>
              <div className="empty-coordinates"><span>LOCAL ROOM</span><i /><span>READY WHEN YOU ARE</span></div>
            </div>
          ) : groups.map((group) => (
            <section className="message-day" key={group.label}>
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
            <textarea id="message-draft" rows={1} maxLength={4000} placeholder={!composerReady ? "Loading saved messages…" : room.trim() ? "Write a message to this room…" : "Choose a room to start a message"} value={draft} disabled={!composerReady || !room.trim()} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            <div className="composer-tools"><label className="transport-choice">Send via <select aria-label="Message transport" value={sendTransport} onChange={(event) => setSendTransport(event.target.value as "hub" | "direct")}><option value="hub">Local hub</option><option value="direct">Direct peer</option></select></label><span><kbd>↵</kbd> send <span className="tool-divider">·</span> <kbd>⇧ ↵</kbd> new line</span><span className="char-count">{draft.length}/4000</span><button type="submit" className="send-button" disabled={!composerReady || !profileReady || !draft.trim() || !room.trim()} aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 12h14.5m0 0-6-6m6 6-6 6" /></svg></button></div>
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
