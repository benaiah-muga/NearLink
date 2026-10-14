# NearLink synchronization v1 draft

Status: proposed bounded reconciliation over existing room transports

This draft adds message-ID exchange to the existing v1 message envelope. It
does not change message serialization or claim identity, confidentiality,
completeness, exactly-once delivery, or emergency reliability. Hub rooms and
direct WebRTC sessions use the same control packets. A transport loss restarts
the exchange from a fresh inventory; persisted message IDs make repeated
delivery idempotent.

## Limits

- One exchange is scoped to one validated room and one sender ID.
- A local inventory contains at most 4,096 message IDs. When a larger local
inventory is observed, the sender exchanges the bounded prefix and sets
`limitReached` on its final inventory page. The receiver must display an
incomplete result and must not say that the conversation is fully synchronized.
- An inventory or missing-message batch carries 1 to 100 IDs, except the empty
inventory uses one empty page.
- IDs in each page are unique and sorted by their opaque string value. IDs and
cursors are never interpreted as time or sequence values.
- Every control packet and ordinary message packet is bounded by the existing
18 KiB compact UTF-8 protocol envelope limit.
- A receiver keeps at most 64 request records per exchange. Start
  a fresh exchange if more request batches are needed.
- Exchanges are restarted after disconnect, room change, storage failure, or
invalid session data. Receivers deduplicate persisted messages by `(room, id)`.

## Packets

All packets use protocol version 1 and contain a valid `room`.

### `sync_inventory_page`

```json
{
  "version": 1,
  "type": "sync_inventory_page",
  "room": "room1",
  "syncId": "opaque-session-id",
  "sender": "device-a",
  "cursor": null,
  "messageIds": ["id-a", "id-b"],
  "nextCursor": "id-b",
  "hasMore": false,
  "limitReached": false
}
```

The sender creates a frozen, sorted inventory at the beginning of an exchange
and sends pages in order. The first page has a null `cursor`; each following
page uses the preceding page's `nextCursor`. `nextCursor` is the last ID in
the current page, or null for the empty inventory. `hasMore` indicates that
another page follows in the same inventory. `limitReached` is only true on a
final page and says that the local inventory contained more than 4,096 IDs.
Receivers reject gaps, duplicate IDs, page cursor mismatches, changed pages for
the same `(sender, syncId, cursor)`, and pages that exceed the session bounds.

### `sync_missing_request`

```json
{
  "version": 1,
  "type": "sync_missing_request",
  "room": "room1",
  "syncId": "target-inventory-session",
  "requestId": "opaque-request-id",
  "sender": "device-a",
  "targetSender": "device-b",
  "messageIds": ["id-c", "id-d"]
}
```

The requester sends sorted unique IDs from the target's completed inventory
that are absent from its own local inventory. Each packet has at most 100 IDs.
The target responds only when `targetSender` is its local sender ID and
`syncId` identifies the target's active inventory. A request can be repeated
after a restart; exact duplicate requests are idempotent.

### `sync_page_complete`

```json
{
  "version": 1,
  "type": "sync_page_complete",
  "room": "room1",
  "syncId": "target-inventory-session",
  "requestId": "opaque-request-id",
  "sender": "device-b",
  "targetSender": "device-a",
  "messageIds": ["id-c"]
}
```

The target emits each available requested item as its ordinary v1 `message`
packet, in request ID order, followed by one completion packet. Completion
lists exactly the ordinary message packets emitted for this request; it may
be a subset if a message was removed after inventory creation. The receiver
persists and verifies those messages before considering the request handled.
If the message set does not match the pending request or a save fails, the
receiver stops that exchange and reports incomplete synchronization. A fresh
exchange can retry without advancing a durable cursor.

## Transport and storage behavior

Control packets are relayed only to other clients in the joined room. They
are not stored as chat messages or included in hub history. The hub validates
that `sender` matches the sender ID from that WebSocket's join and applies a
separate bounded rate limit. It does not authenticate the identity or contents
claimed by a room participant.

The browser uses the same synchronization state machine for WebSocket relay
and the currently connected direct WebRTC peer. It sends only persisted
messages whose current delivery state is accepted. Incoming messages pass
through existing Rust/WASM packet validation and are committed through the
existing IndexedDB deletion and deduplication rules before page completion is
accepted. Live packets and synchronization packets can overlap; exact
duplicates are harmless, conflicting content for one ID stops the exchange.

Inventory and active batch state are ephemeral. On reconnect or reload, the
client begins a fresh exchange. This is safe because accepted message rows
remain the local source of truth and message insertion is idempotent. A failed
page does not delete or reorder already saved messages. A history exchange
can be partial when a peer is offline, a participant has more than 4,096
messages, a message has been removed locally, or storage rejects a write.

## Security and product limits

Message IDs, room values, and sender IDs are not cryptographic identity. A
hub participant can lie about an inventory, fabricate or suppress messages,
observe routing metadata, and cause an incomplete or misleading exchange. A
direct DTLS fingerprint comparison identifies only that current connection
session. No inventory page proves provenance or completeness. Hub messages
remain plaintext. This protocol does not provide E2EE, conflict-free
concurrent editing, secure membership, or emergency-grade reliability.
