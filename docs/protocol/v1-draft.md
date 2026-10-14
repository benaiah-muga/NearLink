# NearLink protocol draft, version 1

This document defines the first JSON envelope used by the local WebSocket proof of concept. It is a draft and is not a security protocol.

## Message envelope

The TypeScript interfaces are maintained in `packages/protocol/src/index.ts`.
Clients first send a join packet:

```json
{"version":1,"type":"join","room":"room-code","sender":"local-id","senderName":"Display name"}
```

The hub responds with `joined` and `presence` packets. A message uses this shape:

```json
{"version":1,"type":"message","id":"stable-unique-id","room":"room-code","sender":"local-id","senderName":"Display name","createdAt":"2026-01-01T12:00:00.000Z","body":"Plain text"}
```

The client creates a stable message identifier before sending. Retries must reuse that identifier. Clients deduplicate by `(room, id)`. Timestamps are presentation hints and do not establish authoritative ordering.

## Acknowledgment

The hub returns an `ack` packet containing the message identifier after it has accepted the message for relay. This means hub acceptance only. It does not prove that a recipient stored or read the message.

## Validation

Implementations must reject unsupported versions, unknown message types, malformed identifiers, invalid timestamps, and payloads over configured size limits. Room codes and display names are not proof of identity.
