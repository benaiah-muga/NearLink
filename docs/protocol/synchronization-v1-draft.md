# Message reconciliation primitive, draft

Status: local Rust implementation slice. This document does not define a
network synchronization protocol or a security protocol.

## Current API

`crates/protocol-core/src/sync.rs` exposes an in-memory `MessageIndex` created
for one validated room and operating on protocol v1 message packets. It
validates each packet with the shared Rust validator before retaining it. The
index keys messages by their opaque v1 message ID within that room. Callers
must preserve the protocol requirement that IDs remain stable across retries.

`insert` returns `Inserted` for a new packet and `Duplicate` when the complete
JSON value matches the packet already stored under that ID. A different packet
with the same ID and room returns `MessageConflict`; the existing packet
remains unchanged. Errors contain no message bodies or identifiers.

To reconcile with a peer, retain one consistent snapshot of the peer's known
IDs. Pass that same snapshot to each `page_missing_from` call and continue from
the exclusive `next_cursor`. If the known-ID snapshot changes, restart from
the first page. Results are sorted by opaque ID only for deterministic
pagination. Message timestamps are not used to infer authoritative order.
`has_more` tells the caller whether another missing packet exists after the
page under the same snapshot.

The current implementation enforces these limits per `MessageIndex` or call:

| Resource | Limit |
| --- | ---: |
| Retained messages | 4,096 |
| Retained compact JSON packet bytes | 16 MiB |
| Compact JSON bytes per message | 18 KiB |
| Known IDs per page request | 4,096 |
| Messages per returned page | 128 |
| Compact JSON bytes per returned page | 512 KiB |
| JSON values inspected in one input packet | 512 |
| Nesting depth inspected in one input packet | 32 |
| Combined UTF-8 bytes in strings and object keys | 18 KiB |

The 18 KiB envelope ceiling includes protocol metadata in addition to the
existing 16 KiB UTF-8 body limit. These are implementation bounds, not
negotiated network capabilities. They bound data retained by the index,
returned in pages, and inspected during input traversal. The API accepts an
already allocated JSON value, so callers must also bound input bytes while
parsing or constructing that value.

## Boundaries and remaining work

`crates/protocol-wasm` exposes the structural validators and reconciliation
operations through JSON-string functions and a `WasmMessageIndex` class. The
facade checks JSON byte lengths before parsing, returns stable content-free
error codes, and uses the same shared protocol vectors as the native core
tests. `npm run test:wasm` builds the wasm-bindgen artifact and exercises it in
Chromium. The browser app builds and loads this binding before enabling
messaging. Hub packets and direct-peer packets pass through the Rust structural
validators at their inbound boundaries, and outbound messages and join packets
are checked before sending. If the module cannot initialize, connection, send,
and peer actions remain disabled. The binding does not supply authentication,
encryption, persistence, or synchronization behavior.

The core has no persistent index, resumable peer cursor, synchronization
packet type, or wire compatibility contract. The caller is responsible for
storing synchronization progress and exchanging IDs and pages. The current
message format does not authenticate the peer or bind an inventory to a
trusted identity. A malicious peer can omit messages from its inventory,
provide misleading IDs, or send conflicting packets. This primitive does not
encrypt, authenticate, or prove completeness.

Before the application relies on this behavior across devices, define a
versioned transport-independent synchronization exchange, persist progress
safely, bind accepted data to the selected identity and security design, and
connect the tested binding to the application. Retain the existing rule that
timestamps are presentation hints and that exactly-once delivery is not
promised.
