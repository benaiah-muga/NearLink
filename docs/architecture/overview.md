# Architecture overview

NearLink uses a browser client and an optional local coordination hub. The browser owns user identity, conversation history, and the interface. The hub provides WebSocket room coordination and relays protocol envelopes. The hub is not required by the long-term architecture, but the first local messaging slice uses it.

## Initial boundaries

- React components use a typed application service and do not access browser storage directly.
- The protocol envelope is transport-independent.
- The WebSocket adapter owns connection lifecycle, not conversation state.
- The local hub does not own client identity secrets.
- Browser persistence is replaceable behind a storage interface.

## Current limitations

The initial slice uses a room code as a convenience for joining a shared local conversation. It is not an authentication credential. Messages pass through the hub as readable JSON. WebRTC, Rust/WASM, cryptographic identity, and multi-device synchronization are future work and must not be implied by the current UI.
