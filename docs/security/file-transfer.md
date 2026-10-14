# File transfer design gate

Status: requirements and deferral record, not an implemented protocol

## Decision

NearLink does not currently transfer attachments. Do not add file transfer to
the product messaging paths until an established application-level encryption
and identity profile is selected, implemented, and reviewed. WebRTC DTLS does
not protect hub-routed uploads, stored hub history, or files after endpoint
storage. Per-transport encryption would produce different security behavior
and is not an acceptable substitute for a shared messaging security layer.

This document records the minimum design and test work required before a
future implementation. It does not imply that these requirements have passed
review.

## Proposed transfer model

- A transfer belongs to one authenticated conversation and uses the same
  end-to-end protected message layer as text messages.
- Transfer metadata and chunks are separate protocol records. Metadata contains
  a version, random transfer ID, declared byte length, fixed chunk size, chunk
  count, whole-file SHA-256 digest, a display filename, and a declared media
  type. Metadata must be authenticated and encrypted by the selected message
  protocol.
- Each chunk includes the transfer ID, zero-based index, and bytes. Chunk
  records are authenticated by the established messaging layer. Do not invent
  a custom encryption or MAC scheme for file chunks.
- A receiver accepts chunks in any order, stores them as bounded temporary
  records, and treats a byte-identical duplicate index as idempotent. A
  conflicting duplicate index fails and quarantines that transfer.
- A file becomes visible only after all chunks are present, the declared total
  size and chunk count match, and the reconstructed SHA-256 digest matches the
  authenticated metadata. Write to a temporary file and finalize atomically
  where the platform permits.
- Names are display hints only. Strip path separators and control characters,
  prevent path traversal, never auto-open received content, and do not trust
  the declared MIME type to describe bytes accurately.

## Provisional resource limits

These are starting values for an interoperability spike, not release budgets.
The supported devices must be benchmarked before freezing them.

| Limit | Proposed initial value | Required behavior |
| --- | ---: | --- |
| Maximum file size | 25 MiB | Reject before reserving full storage if the platform cannot honor the quota. |
| Chunk payload | 64 KiB | Enforce one exact size for all non-final chunks. |
| Maximum chunk count | 400 | Reject inconsistent or oversized metadata before allocating records. |
| Concurrent inbound transfers | 2 per conversation | Reject or defer additional starts with an actionable status. |
| Temporary storage per conversation | 50 MiB | Refuse new transfers before exceeding the budget. |
| Partial transfer lifetime | 24 hours | Expire and delete incomplete records; explain that resume state was removed. |

The final values must consider IndexedDB quota behavior, browser eviction,
mobile memory and storage, reconnect traffic, and hub message size limits.
Avoid holding the full file and all chunks in memory at once. Backpressure must
pause production when the transport or receiver cannot accept more data.
In particular, the current hub caps WebSocket frames at 32 KiB and protocol v1
caps a message body at 16 KiB. A 64 KiB chunk cannot be sent through the current
message envelope; JSON and base64 framing would increase its wire size further.
A future design must choose and review a versioned binary or chunk framing
format with transport-specific limits before using this provisional chunk
size.

## Restart and integrity behavior

- Persist transfer metadata and chunks atomically enough to resume after page
  reload without presenting an incomplete file as complete.
- An interruption keeps valid chunks until expiry or explicit user deletion.
  Resume requests must identify missing chunk indexes and be bounded by the
  same message authentication and resource limits.
- A duplicate transfer ID with identical authenticated metadata resumes the
  existing transfer. The same ID with different metadata is rejected.
- Invalid indexes, inconsistent lengths, excessive counts, malformed UTF-8
  metadata, invalid names, digest mismatch, and quota errors are explicit
  failures. Do not silently skip invalid chunks.
- The sender's completion status must distinguish queued, accepted by the
  transport or hub, persisted by the recipient, and file verification
  completed. None of these means the user opened the file.

## Required validation before implementation approval

1. Select and pin the shared application-level encryption and identity
   profile. Define hub and direct-path behavior under the same security rules.
2. Review filename encoding, MIME handling, digest binding, transfer IDs,
   authorization, cancellation, expiry, and deletion behavior.
3. Test missing, duplicated, reordered, conflicting, truncated, oversized,
   malformed, corrupted, expired, and interrupted transfer records.
4. Test quota exhaustion, browser restart, device sleep, reconnect, and
   cancellation at every persistence boundary.
5. Measure CPU, memory, storage, throughput, and battery on representative
   supported devices before changing the provisional limits.
6. Obtain independent review of parsing, persistence, quota handling, and
   interaction with the selected cryptographic state machine.

Until these gates pass, keep attachments unavailable and record them as a
deferred feature. The current application handles text only.
