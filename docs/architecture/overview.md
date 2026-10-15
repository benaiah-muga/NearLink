# Architecture overview

NearLink currently uses a browser client and an optional local coordination hub. The browser stores a locally generated sender ID, display name, and conversation history. It can exchange messages through the hub over WebSockets or through a manually signaled WebRTC DataChannel. The hub provides room coordination and bounded SQLite room-history replay. The hub is not required by the long-term architecture, but the local group messaging path uses it.

## Initial boundaries

- The application layer consumes the `ConversationStore` port for identity, conversation history, delivery state, deletion, hub replay, and browser persistence requests. The current `browserConversationStore` adapter delegates to IndexedDB-backed storage helpers. A native storage adapter has not been implemented.
- The protocol envelope is transport-independent.
- WebSocket and WebRTC adapters own connection lifecycle, not conversation state.
- The local hub does not own client identity secrets. It does receive and store plaintext hub messages.
- Browser persistence is replaceable behind the `ConversationStore` interface.

## Current limitations

Room codes are convenience values for joining a shared local conversation, not authentication credentials. Hub messages pass through the service as readable JSON and are retained in bounded local history. Hub acknowledgment means hub acceptance, not recipient delivery. WebRTC uses a manually exchanged offer and answer and requires a fingerprint comparison over a separate trusted channel before the app allows sends. The fingerprint identifies only the current DTLS connection, not a lasting device or human identity. The application has no MLS or other reviewed application-level E2EE protocol, cryptographic identity, multi-device identity, or native application. The browser loads generated Rust/WASM bindings before enabling messaging. Rust/WASM validates packet structure at hub and direct-peer boundaries and owns bounded inventory sequence acceptance, the frozen missing-ID plan and batching, request replay/conflict, requested-message matching, and staged completion correlation and validation. TypeScript keeps WASM handles and peer scheduling/async continuation. It performs bounded IndexedDB reads and durable message acceptance, validates loaded durable rows, and asks Rust/WASM to compare exact IDs and packets against tracked state. TypeScript computes partial/final status and presents it, and sends packets over hub or direct transports while owning timers and rate budgets. Rust exchange state is in-memory and ephemeral. The Rust `MessageIndex` is also in-memory and neither it nor sync state is the browser's persistent source of truth. These limits must not be implied by the UI.
