# NearLink threat model

Status: implementation-specific working model, not a security certification

## Scope and current architecture

The browser client stores identities and conversation records in IndexedDB. It
can connect to an optional FastAPI WebSocket hub or exchange messages over a
direct WebRTC DataChannel after users manually exchange signaling JSON. The
hub stores bounded room history in SQLite. The hub and WebSocket application
messages are plaintext. WebRTC protects a DataChannel with DTLS, but the app
does not have a reviewed application messaging encryption protocol or durable
cryptographic identity system. Users may compare the current DTLS fingerprint
through a separate trusted channel. This confirms a connection fingerprint
only, not a person or lasting device identity.

This model covers the implemented text messaging paths. It does not cover
attachments, voice, calls, MLS, native applications, or mesh routing because
those features are not implemented.

## Assets

- Message contents and local conversation history.
- Display names, room identifiers, and transport metadata.
- Local device identity values and outgoing queue state.
- Hub room history and active connection state.
- Availability and correctness of messages and acknowledgments.

## Trust boundaries

- Browser application code and browser storage on each endpoint.
- The local network, including other clients and access point operators.
- The optional hub process and its SQLite database, backup, and host filesystem.
- The out-of-band channel used to compare a WebRTC fingerprint.
- The user operating each endpoint.

## Threats and current limits

### Hub path

- A participant or network operator can observe, alter, replay, delay, reorder,
  or drop hub traffic. `ws://` has no transport encryption. `wss://` depends on
  correct TLS termination but still does not provide application-level E2EE.
- The hub operator can read message content and retained history. Filesystem
  access to the hub database also exposes stored message plaintext.
- Room identifiers are routing values, not authentication or authorization.
  A user who knows a room identifier may join it and send messages.
- Hub history is bounded and may be truncated by retention, quota, database
  recovery, or local filesystem loss. A hub acknowledgment means the local hub
  accepted a message into its database. It does not mean a recipient received
  or read it.
- A malicious or compromised hub may fabricate, suppress, delay, or replay
  messages. Current message validation and deduplication do not authenticate
  sender identity.

### Direct WebRTC path

- Signaling JSON exchanged through an untrusted channel may be replaced. A
  separate authenticated fingerprint comparison is required before the app
  permits direct sends. If the comparison channel is compromised, an
  intermediary may impersonate the peer.
- A fingerprint match identifies the remote DTLS certificate for that session
  only. It does not prove a civil identity, persist across sessions, or bind a
  credential to the displayed call sign.
- DTLS protects the connected data channel in transit, but message contents
  exist as plaintext in both endpoint applications and browser storage. There
  is no reviewed application-level E2EE, identity lifecycle, group key
  management, or cryptographic recovery.
- The current host-candidate-only configuration can fail across networks that
  do not provide a directly reachable path. No availability guarantee exists.

### Endpoints and availability

- A compromised endpoint, malicious application update, browser extension,
  malware, or person with access to an unlocked device may read or alter
  plaintext and local records.
- Browser storage can be cleared, evicted, corrupted, or unavailable. Local
  persistence is not a backup or recovery service.
- Resource exhaustion, malformed packets, network partitions, device sleep,
  and process termination can prevent delivery or delay synchronization.
- A recipient can copy, screenshot, or disclose any message they can read.

## Security claims and safe use

NearLink is an early development project and is unsuitable for sensitive
communication or emergency coordination. Do not describe the hub path as
confidential or the direct fingerprint check as verified identity. Do not
claim end-to-end encrypted messaging or emergency-grade reliability.

Before security claims, NearLink needs a selected and pinned established
protocol, identity and membership design, independent implementation review,
robust persistence and migration behavior, platform validation, and a third
party security audit of the shipped integration. See
[`mls-architecture.md`](mls-architecture.md) for the candidate evaluation and
release gates.
