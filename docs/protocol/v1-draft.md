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

History-capable hubs may also return `not_joined`, `invalid_cursor`,
`history_packet_too_large`, or `history_page_too_large`. These are content-free
errors. A client may rejoin before retrying `not_joined`; it should restart
history from a current joined replay boundary after `invalid_cursor`. The size
errors require a smaller page or a fresh replay if the stored history cannot
be represented within protocol bounds.

The initial hub limits a room to 32 active clients, the process to 64 rooms or 256 active connections, and each connection to 120 messages per minute. These limits are implementation settings, not negotiated protocol capabilities.

## Optional retained-history paging

The initial join and its `joined` response remain unchanged. A hub may continue
to send its bounded initial replay as ordinary `message` packets after
`joined`. Clients that need older retained history can send the optional
`history_request` extension after joining a room. Clients should use it only
with hubs that support this extension; an older v1 hub may reject an unknown
packet. Clients can then keep using the initial `joined` replay.

A request has this shape:

```json
{"version":1,"type":"history_request","requestId":"history-1","room":"room-code","cursor":"oldest-message-id","limit":100}
```

`requestId` is a client-generated protocol identifier used to correlate the
request and completion packet. `cursor` is either `null` or a message
identifier. `null` starts at the newest retained edge. To fetch messages older
than the initial join replay, the client supplies the oldest message ID from
that replay. The hub resolves that ID within the requested room and continues
strictly before it in persisted acceptance order. A cursor is never a SQLite
sequence number. It is an opaque room-scoped continuation value represented by
a validated message ID.

Each requested page is sent as ordinary `message` packets in descending
acceptance order, newest to oldest, followed by exactly one
`history_page_complete` packet. A completion looks like this:

```json
{"version":1,"type":"history_page_complete","requestId":"history-1","room":"room-code","messageIds":["message-100","message-99"],"pageBytes":420,"nextCursor":"message-99","hasMore":true,"historyTruncated":false}
```

`messageIds` lists the IDs of exactly the history messages in this page, in
the same order as their `message` packets. It lets a client identify page
contents when live messages interleave on the connection. The client persists
and verifies every listed ID before requesting the next page. When
`hasMore` is true, the page must contain at least one message and `nextCursor`
must equal its last, oldest message ID. When `hasMore` is false,
`nextCursor` must be `null`. `requestId` is a correlation value and does not
promise cached or snapshot-stable retries. Retries may include already seen
messages; clients deduplicate them by `(room, id)`.

`historyTruncated` reports that retention removed or otherwise made older
history unavailable when the page is evaluated, including gaps that predate
the request. It is independent of
`hasMore`: a page can have more retained messages and still have an older
retention gap, or it can be the final page without a gap. The existing optional
`joined.historyTruncated` continues to report truncation in the initial replay.

Requests may ask for 1 to 100 messages. A page contains at most 100 messages
and at most 512 KiB of combined compact UTF-8 JSON message envelopes, measured
without the completion packet. Every protocol packet has a compact serialized
envelope limit of 18 KiB. Message bodies also retain their 16 KiB UTF-8 limit;
JSON escaping counts toward the 18 KiB envelope limit, so an escaped body that
would exceed it is rejected. The local hub's 32 KiB WebSocket frame ceiling is
only a transport limit and does not increase the protocol envelope limit.

Clients use the ordered IDs from each completion to preserve the hub's
deterministic acceptance order in their local conversation. For the older
pages fetched before the initial replay, clients prepend each page in reverse
page order. Timestamps remain display hints and must not be used to construct
the history cursor or override the page order.

## Validation

Implementations must reject unsupported versions, unknown message types, malformed identifiers, invalid timestamps, and payloads over configured size limits. Room codes and display names are not proof of identity.
