import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { isServerPacket, PROTOCOL_VERSION, type ClientPacket, type MessagePacket } from "@nearlink/protocol";
import { loadIdentity, loadMessages, saveIdentity, saveMessage, updateDelivery, type LocalIdentity, type StoredMessage } from "./lib/storage";

type LinkState = "offline" | "connecting" | "linking" | "online" | "retrying" | "error";
const DEFAULT_HUB = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname || "localhost"}:8000/ws`;
const HUB_KEY = "nearlink.hub";
const ROOM_KEY = "nearlink.room";

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
  const socketRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef(messages);
  const messageKeysRef = useRef(new Set<string>());
  const retryingMessageKeysRef = useRef(new Set<string>());
  const activeRoomRef = useRef(room.trim());
  const pendingSendRef = useRef(false);
  const shouldReconnectRef = useRef(false);
  const attemptRef = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);

  messagesRef.current = messages;
  activeRoomRef.current = room.trim();

  useEffect(() => {
    let active = true;
    loadIdentity().then((saved) => {
      if (!active) return;
      const next = saved ?? { sender: makeId(), senderName: "" };
      setIdentity(next);
      setDisplayName(next.senderName);
      if (!saved) void saveIdentity(next).catch(() => setNotice("Local identity could not be saved on this device."));
      setStorageReady(true);
    }).catch(() => {
      if (active) {
        setNotice("Local storage is unavailable. Messages may not survive a reload.");
        setIdentity({ sender: makeId(), senderName: "" });
        setStorageReady(true);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (room && !writeLocalSetting(ROOM_KEY, room)) {
      setNotice("Your room setting could not be saved. Re-enter it if you reload this page.");
    }
    setConversationReady(false);
    setLoadedRoom(null);
    setMessages([]);
    messageKeysRef.current.clear();
    let active = true;
    if (room.trim()) {
      loadMessages(room.trim()).then((stored) => { if (active) { setMessages(stored); messageKeysRef.current = new Set(stored.map((item) => `${item.packet.room}\u0000${item.packet.id}`)); setLoadedRoom(room.trim()); setConversationReady(true); } }).catch(() => { if (active) { setMessages([]); messageKeysRef.current.clear(); setLoadedRoom(room.trim()); setNotice("Could not read this conversation from local storage."); setConversationReady(true); } });
    } else {
      setMessages([]);
      messageKeysRef.current.clear();
      setLoadedRoom("");
      setConversationReady(true);
    }
    return () => { active = false; };
  }, [room]);

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
          setNotice("");
          for (const item of messagesRef.current) {
            if (item.direction === "outgoing" && item.delivery === "queued") {
              try { socket.send(JSON.stringify(item.packet)); }
              catch { setNotice("Your queued messages are saved. The radio will retry."); socket.close(); break; }
            }
          }
          return;
        }
        if (packet.type === "presence") { setPeers(packet.peers); return; }
        if (packet.type === "ack") {
          const pending = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === room.trim() && item.direction === "outgoing");
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
          const guidance = packet.code === "capacity_reached" ? "Try a different room or reconnect later." : packet.code === "rate_limited" ? "Wait a moment before sending again." : "Review the room and message details.";
          if (packet.id) {
            const rejected = messagesRef.current.find((item) => item.packet.id === packet.id && item.packet.room === room.trim() && item.direction === "outgoing");
            if (rejected) {
              let saved = true;
              try { await updateDelivery(rejected.packet.room, packet.id, "failed"); }
              catch { saved = false; }
              if (socketRef.current !== socket) return;
              setMessages((current) => current.map((item) => item.packet.id === packet.id && item.packet.room === rejected.packet.room ? { ...item, delivery: "failed" } : item));
              if (!saved) setNotice("The hub rejected your message, but its status could not be saved on this device.");
            }
          }
          setNotice(`${packet.message} ${guidance} (${packet.code})`);
          return;
        }
        if (packet.type === "message") {
          if (packet.room !== room.trim()) return;
          const messageKey = `${packet.room}\u0000${packet.id}`;
          if (messageKeysRef.current.has(messageKey)) return;
          messageKeysRef.current.add(messageKey);
          const item: StoredMessage = { packet, direction: packet.sender === identity.sender ? "outgoing" : "incoming", delivery: "sent" };
          setMessages((current) => [...current, item].sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt)));
          void saveMessage(item).catch(() => setNotice("Message received, but could not be saved on this device."));
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
  const canJoin = Boolean(identity && normalizedName && room.trim() && hubUrl.trim());
  const linkLabel = linkState === "online" ? "On frequency" : linkState === "linking" ? "Calling station" : linkState === "connecting" || linkState === "retrying" ? "Finding signal" : linkState === "error" ? "Check settings" : "Standby";

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity || !normalizedName || !room.trim()) return;
    const nextIdentity = { ...identity, senderName: normalizedName };
    setIdentity(nextIdentity);
    let identitySaved = true;
    try { await saveIdentity(nextIdentity); }
    catch { identitySaved = false; }
    const settingsSaved = writeLocalSetting(HUB_KEY, hubUrl.trim());
    setLinkRequested(true);
    setNotice(!identitySaved ? "Your identity could not be saved. It may change if you reload this page." : !settingsSaved ? "Your station settings could not be saved. Re-enter them if you reload this page." : "");
  }

  async function retryMessage(message: StoredMessage) {
    const messageKey = `${message.packet.room}\u0000${message.packet.id}`;
    if (retryingMessageKeysRef.current.has(messageKey)) return;
    retryingMessageKeysRef.current.add(messageKey);
    setRetryingMessageKeys(new Set(retryingMessageKeysRef.current));
    try {
      await updateDelivery(message.packet.room, message.packet.id, "queued");
    } catch {
      setNotice("Could not queue this message for retry on this device.");
      return;
    } finally {
      retryingMessageKeysRef.current.delete(messageKey);
      setRetryingMessageKeys(new Set(retryingMessageKeysRef.current));
    }
    setMessages((current) => current.map((item) => item.packet.id === message.packet.id && item.packet.room === message.packet.room ? { ...item, delivery: "queued" } : item));
    if (activeRoomRef.current === message.packet.room && linkState === "online" && socketRef.current?.readyState === WebSocket.OPEN) {
      try { socketRef.current.send(JSON.stringify(message.packet)); }
      catch {
        setNotice("The message is queued on this device. The radio will reconnect and retry it.");
        socketRef.current.close();
      }
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!storageReady || !conversationReady || loadedRoom !== room.trim() || pendingSendRef.current || !identity || !body || !room.trim()) return;
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
    const item: StoredMessage = { packet, direction: "outgoing", delivery: "queued" };
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
      if (linkState === "online" && socketRef.current?.readyState === WebSocket.OPEN) {
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

            <button className="primary-button" type="submit" disabled={!canJoin || linkRequested}>
              <span className="button-dot" />{linkRequested ? "Station settings saved" : "Save and join room"}
            </button>
          </form>
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
              {group.items.map(({ packet, direction, delivery }) => (
                <article key={`${packet.room}:${packet.id}`} className={`message-row ${direction === "outgoing" ? "message-outgoing" : "message-incoming"}`}>
                  <div className="message-avatar" aria-hidden="true">{(packet.senderName || "?").slice(0, 1).toUpperCase()}</div>
                  <div className="message-content">
                    <div className="message-meta"><strong>{direction === "outgoing" ? "You" : packet.senderName || "Unknown station"}</strong><time dateTime={packet.createdAt}>{formatTime(packet.createdAt)}</time></div>
                    <div className="message-bubble">{packet.body}</div>
                    {direction === "outgoing" && <div className={`delivery-state ${delivery}`}>
                      <span className="delivery-glyph">{delivery === "sent" ? "✓" : delivery === "failed" ? "!" : "◷"}</span>
                      {delivery === "sent" ? "Accepted by hub" : delivery === "failed" ? <>Not accepted <button type="button" className="retry-button" disabled={retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`)} aria-busy={retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`)} onClick={() => void retryMessage({ packet, direction, delivery })}>{retryingMessageKeys.has(`${packet.room}\u0000${packet.id}`) ? "Retrying…" : "Retry"}</button></> : "Queued on this device"}
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
            <div className="composer-tools"><span><kbd>↵</kbd> send <span className="tool-divider">·</span> <kbd>⇧ ↵</kbd> new line</span><span className="char-count">{draft.length}/4000</span><button type="submit" className="send-button" disabled={!composerReady || !draft.trim() || !room.trim()} aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 12h14.5m0 0-6-6m6 6-6 6" /></svg></button></div>
          </form>
          <div className="composer-foot"><span role="status" aria-live="polite"><i className={linkState === "online" ? "foot-live" : ""} />{!composerReady ? "Loading saved messages" : linkState === "online" ? "Connected to local hub" : "Messages save locally until a hub is connected"}</span><span>NEARLINK <b>·</b> LOCAL FIRST</span></div>
        </footer>
      </section>
    </main>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export default App;
