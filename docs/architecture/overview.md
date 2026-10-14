# Architecture overview

NearLink currently uses a browser client and an optional local coordination hub. The browser stores a locally generated sender ID, display name, and conversation history. It can exchange messages through the hub over WebSockets or through a manually signaled WebRTC DataChannel. The hub provides room coordination and bounded SQLite room-history replay. The hub is not required by the long-term architecture, but the local group messaging path uses it.

## Initial boundaries

- React components currently call browser storage helpers from the application layer. A service boundary remains a desired refactor, not a completed boundary.
- The protocol envelope is transport-independent.
- WebSocket and WebRTC adapters own connection lifecycle, not conversation state.
- The local hub does not own client identity secrets. It does receive and store plaintext hub messages.
- Browser persistence is replaceable behind a storage interface.

## Current limitations

Room codes are convenience values for joining a shared local conversation, not authentication credentials. Hub messages pass through the service as readable JSON and are retained in bounded local history. Hub acknowledgment means hub acceptance, not recipient delivery. WebRTC uses a manually exchanged offer and answer and requires a fingerprint comparison over a separate trusted channel before the app allows sends. The fingerprint identifies only the current DTLS connection, not a lasting device or human identity. The application has no MLS or other reviewed application-level E2EE protocol, cryptographic identity, multi-device identity, or native application. The browser loads generated Rust/WASM bindings before enabling messaging. Rust/WASM validates packet structure at hub and direct-peer boundaries, accepts bounded inventory sequences, validates and tracks bounded request/completion relationships, selects missing message IDs, and plans bounded request batches. TypeScript retains pending-exchange bookkeeping, loads accepted-message snapshots from IndexedDB, sends packets over hub or direct transports, verifies saved messages before accepting completion, enforces synchronization rate budgets, and presents status. The Rust `MessageIndex` remains an in-memory reconciliation primitive and is not the browser's persistent source of truth. These limits must not be implied by the UI.
