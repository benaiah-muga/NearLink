# NearLink protocol draft, version 1

This document defines the first JSON envelope used by the local WebSocket proof of concept. It is a draft and is not a security protocol.

## Message envelope

The TypeScript interfaces are maintained in `packages/protocol/src/index.ts`.
Clients first send a join packet:

```json
{"version":1,"type":"join","room":"room-code","sender":"local-id","senderName":"Display name"}
```

The hub responds with `joined` and `presence` packets. A bounded-history hub may
include `historyTruncated: true` in `joined` when retained room history does not
cover the full available history. Clients should explain that older messages
may be missing. The field is optional so earlier v1 clients can ignore it. A
message uses this shape:

```json
{"version":1,"type":"message","id":"stable-unique-id","room":"room-code","sender":"local-id","senderName":"Display name","createdAt":"2026-01-01T12:00:00.000Z","body":"Plain text"}
```

The client creates a stable message identifier before sending. Retries must reuse that identifier. Clients deduplicate by `(room, id)`. Timestamps are presentation hints and do not establish authoritative ordering.

Identifiers use 1 to 128 ASCII letters, digits, periods, underscores, colons, or hyphens. Room codes use 1 to 64 ASCII letters, digits, underscores, or hyphens. Display names are limited to 64 characters. Message bodies are limited to 16 KiB of UTF-8 data by the local hub. Implementations validate timezone-aware ISO timestamps.

## Acknowledgment

The hub returns an `ack` packet containing the message identifier after it has accepted the message for relay. This means hub acceptance only. It does not prove that a recipient stored or read the message.

An `error` packet may include the rejected message identifier when the hub can safely identify it. `message_conflict` means the same `(room, id)` already names a different packet and must not be retried with a changed payload. `storage_unavailable` means the hub could not durably accept the message; clients should retain it and retry with the same identifier. Clients should mark rejected messages as failed and offer a retry where appropriate. A retry keeps the same message identifier.

The initial hub limits a room to 32 active clients, the process to 64 rooms or 256 active connections, and each connection to 120 messages per minute. These limits are implementation settings, not negotiated protocol capabilities.

## Validation

Implementations must reject unsupported versions, unknown message types, malformed identifiers, invalid timestamps, and payloads over configured size limits. Room codes and display names are not proof of identity.
