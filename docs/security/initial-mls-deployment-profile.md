# Initial MLS deployment profile and decision register

Status: candidate-neutral design baseline, proposed for independent review

This document consolidates NearLink's initial MLS deployment decisions. It is
an audit input, not an implementation description, protocol conformance result,
security assessment, or product security claim. The profile deliberately does
not select a library, crypto provider, cipher suite, or platform storage API.
See the [identity and authorization profile](identity-and-authorization-profile.md)
for detailed policy and abuse cases, and the
[MLS implementation investigation](mls-architecture.md) for candidate research
and compatibility evidence.

## Current implementation and claim boundary

NearLink currently transports plaintext message packets. It does not implement
MLS, verified device identity, owner authorization, durable cryptographic state,
or the delivery and acknowledgement rules below. The existing message ACK is
not proof that a recipient decrypted or persisted a message. Do not describe
current messaging as end-to-end encrypted or suitable for sensitive or
emergency communication.

The decisions here are proposed application policy around RFC 9420 MLS and the
roles described in RFC 9750. They require independent design review before
implementation. A selected implementation must still pass library, provider,
interoperability, browser and native feasibility, storage, and external audit
gates.

## Proposed initial deployment profile

### Scope and trust

- One device identity per user. A device identity does not establish a civil
  identity. Account-wide identity, device linking, and multi-device users are
  out of scope.
- A direct peer group has exactly two members. A local-hub group has at most 16
  devices including its owner. This proposed cap requires target performance,
  storage, and interoperability validation before implementation.
- A group may use one optional local hub as its Delivery Service. Core
  communication must not require a cloud service.
- NearLink has no centralized Authentication Service. Clients validate the
  MLS credential binding and require exact out-of-band (OOB) comparison of the
  full, versioned device fingerprint before treating that device as verified.
  The owner and invitee each verify the other's device fingerprint out of band
  before admission. A room code, display name, address, invitation QR, or hub
  response cannot substitute for reciprocal verification. Verification means
  verified device key, not verified person.
- Use MLS wire format and state transitions without a NearLink-specific
  cryptographic envelope. Transport adapters carry the same serialized MLS
  message bytes. Hub and direct transports must not change MLS semantics.
- The group creator is the sole owner. Only that owner may create a Commit.
  Each Commit authorizes exactly one approved action: add one mutually
  OOB-verified member, remove one non-owner member, or apply one credential
  Update. A member's Update proposal must be authenticated by that member and
  replaces only that member's leaf. The owner includes the proposal in the
  sole authorized Commit after the required OOB verification. The non-owner
  does not create a Commit. Owner rotation uses an owner-authenticated Update
  proposal included in the owner's Commit. No batching, external Commit,
  non-owner Commit, owner self-removal, owner transfer, or policy-changing
  Commit is allowed. [RFC 9420, Section 12.1.2](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.1.2)
  defines Update as replacing the sender's leaf, so an owner cannot originate
  another member's Update proposal.
- A suspected compromised or lost non-owner credential is removed by an
  owner-created Remove Commit. If old-key possession or integrity is in doubt,
  do not use successor rotation; require a new credential, reciprocal OOB
  verification, and a fresh Add after removal. An offline device remains able
  to use stale local state until its surviving peers apply the removal Commit.
- Routine non-owner credential rotation is allowed only when the old
  credential authorizes its successor and both owner and member complete fresh
  reciprocal OOB comparison. Rotation timing and expiry remain open. If the old
  key is unavailable, treat the credential as lost and remove/re-add instead.
- There is no automatic owner election or owner recovery. If the owner is
  permanently lost, remaining members may continue at their last accepted
  epoch, but membership changes stop. Continuing with membership changes
  requires a newly verified group and fresh invitations.
- A compromised owner credential retains the owner's protocol authority until
  members stop accepting that group. The profile cannot distinguish a
  legitimate owner Commit from one created by an attacker holding the key.
  On suspected owner compromise, members freeze group state changes and
  membership, stop trusting new owner-authorized admissions, and establish a
  new group only after fresh OOB verification. The hub cannot revoke an owner
  or restore trust.

### Credential encoding and OOB verification

The credential binding must contain an explicit profile version, opaque device
identifier, MLS credential type and public signature key, plus only those
additional fields required by the selected library. Editable names and room
codes are excluded from identity evidence. An identity-verification QR carries
only stable public identity binding and credential key material. It is distinct
from an invitation QR. Public QR material must not contain private keys, group
secrets, or recovery secrets.

Recommend RFC 8785 JSON Canonicalization Scheme for a small application-owned
identity-binding object if the chosen MLS API requires an application encoding.
That is a recommendation, not a final encoding decision. RFC 8785 does not
replace MLS protocol serialization, establish the trustworthiness of fields,
or make a signature valid. The exact fields, canonicalization implementation,
domain separation, fingerprint input, duplicate-key handling, Unicode policy,
and cross-language behavior require test vectors and independent review. If
RFC 8785 is used, the profile must reject non-canonical input or canonicalize
before hashing and signing in one unambiguous documented way.

The owner and invitee each compare the other's identity-verification QR or full
fingerprint through a trusted channel. Separately, the invitation QR carries
the invitee's public, one-use MLS KeyPackage, its reference, and the invitee's
credential fingerprint. The owner confirms that the package key matches the
mutually verified invitee credential and admits that exact package. The
invitation QR is not an identity-verification QR, does not verify the owner,
and cannot replace reciprocal identity comparison. A regenerated, substituted,
stale, expired, or used KeyPackage requires fresh package confirmation and
verification as needed. No private material is placed in either QR.

### Authorization and state ordering

Every client verifies the authenticated Commit author against the owner in
authenticated group policy and verifies the exact single permitted action
before advancing MLS state. If a library cannot expose enough authenticated
Commit information to enforce this before mutation, it does not meet the
profile. Invalid, unknown, conflicting, or stale policy state fails closed.

For local-hub groups, a single local hub assigns a durable, monotonically
increasing sequence per immutable MLS group identifier to every MLS envelope,
including proposals, Commits, application messages, and Welcomes. It appends
before acknowledging or broadcasting, preserves the same order for all
connected members, and returns explicit gaps or retention truncation. Clients
persist the contiguous sequence and hash-chain checkpoint. A gap pauses group
state changes. A conflicting sequence, chain break, rollback, or conflicting
Commit freezes the group. A local hub orders and forwards; it is not an
identity authority and does not learn MLS secrets. Multiple active hubs and
silent hub switching are unsupported.

The hub distributes the exact serialized, invitee-addressed Welcome as an
opaque ordered log entry to all existing group members as well as to the
designated invitee. Only that invitee passes the Welcome bytes to MLS Welcome
processing. Existing members verify the expected sequence, previous hash, and
exact envelope hash, then persist only the delivery cursor; they never pass the
Welcome to MLS group-state processing and do not mutate MLS state because of
the Welcome entry. An identical sequence/hash duplicate is an idempotent
transport no-op. The same sequence with different bytes or hash freezes the
group as equivocation. A missing sequence pauses group-state changes and
triggers bounded history repair; no client skips the Welcome entry. Identical
Welcome bytes must not be assigned a new sequence.

The Welcome's GroupSecrets are protected for the designated invitee's
KeyPackage. Existing members receive its opaque bytes and can observe that an
invitation occurred, along with routing, size, and timing metadata. This does
not hide membership activity or metadata from the hub or existing members.

A newly invited member computes and checks the exact Welcome envelope hash and
uses the Welcome bytes to create pending MLS join state. The hub-assigned
Welcome sequence/hash is provisional, not a trusted transport cursor. The
invitee does not replay pre-join history. It then receives the checkpoint from
the OOB-verified owner in an MLS-authenticated application message. The
checkpoint payload contains the immutable group identifier, epoch, epoch
authenticator, and the exact Welcome sequence/hash. The checkpoint envelope
has its own next sequence and hash. The invitee checks group and epoch against
the pending MLS state and requires the checkpoint payload's Welcome cursor to
match the exact provisional Welcome sequence/hash. Only after this
authentication succeeds does one durable transaction promote the pending join
state and Welcome cursor, process the checkpoint, and persist the checkpoint
envelope's own assigned sequence/hash as the active contiguous cursor. It then
requests history strictly after that cursor and verifies each next sequence
and previous hash. It never fetches or replays an unauthenticated pre-join
prefix. A mismatch freezes the pending join, is not acknowledged, and does not
trigger history fetch; the owner must retry the identical checkpoint or the
group must be abandoned and recreated after fresh OOB verification. Existing
members resume from their own persisted checkpoint after reconnect or hub
change. A hub cannot supply a lower checkpoint as rollback repair. This
bootstrap requires the selected MLS API to expose the required group state for
comparison.

Admission has a strict bootstrap barrier. From ordering the Add Commit until
the invitee accepts the checkpoint, no MLS envelope may be transmitted except
the ordered Welcome entry and the first application checkpoint envelope. This
also blocks proposals, including a non-owner's authenticated Update proposal.
Proposal creation may be queued locally, but transmission waits until after
checkpoint acceptance. After the invitee processes Welcome, the owner sends
the authenticated checkpoint as the first application envelope in that new
epoch. The hub orders it immediately after the Welcome/Add transition. Its
payload names the provisional Welcome entry sequence/hash, not the checkpoint
envelope's own cursor. The invitee rejects any different predecessor and only
then promotes the Welcome cursor and persists the checkpoint envelope's own
sequence and hash as active state before requesting later history. It does not
fetch pre-join history.
After checkpoint acceptance, the invitee may send the necessary authenticated
delivery ACK. Application sends and queued proposals may resume after the
checkpoint is accepted; no later Commit is created until the invitee's ACK
confirms that it durably processed the checkpoint and saved its group state
and cursor. The owner retransmits the identical checkpoint if needed. A
missing checkpoint or ACK keeps Commits blocked; the group must not advance to
a later epoch. This barrier ensures the invitee can decrypt the checkpoint
before any subsequent MLS envelope.

For direct two-member groups, the owner serializes Commits through one durable
per-group state actor and has at most one unacknowledged Commit. It retransmits
identical pending bytes after disconnect and does not create the next Commit
until the other member's authenticated acceptance ACK arrives. A gap pauses
later state changes. Conflicting Commits or irreconcilable epoch state freeze
the group. The recipient ACK follows durable acceptance of the Commit and its
resulting state. A removal Commit has no remaining recipient to ACK; the owner
persists it and requires fresh OOB admission before replacing the removed
member.

For the initial direct admission, the Add Commit and Welcome establish the
new epoch. From the Add Commit until checkpoint acceptance, neither client
transmits any MLS envelope except the Welcome and the owner's first MLS
application checkpoint; proposals may be created locally but remain queued.
The owner sends the authenticated group ID, epoch, and epoch authenticator
checkpoint as the first MLS application envelope after Welcome. The invitee
processes and persists that checkpoint before sending its authenticated ACK.
The owner blocks subsequent Commits until that ACK is durable and retransmits
identical checkpoint bytes on retry. Both clients
pause application sends between the Add Commit and checkpoint acceptance.
Direct mode uses its persisted per-group generation and processed-envelope
record instead of a hub sequence/hash cursor. A lost checkpoint or ACK leaves
the group paused at that epoch; it cannot skip to another Commit.

For removals generally, a Remove Commit advances surviving members when they
process and durably persist it. The removed member is excluded from the
resulting epoch, receives no new epoch secret, does not process the Commit as
a resulting-group member, and sends no ACK for removal. An offline removed
device can retain stale state and send old-epoch messages until notified;
survivors that advanced reject those messages. Previously copied plaintext
and secrets cannot be revoked.

Hub acknowledgements and recipient acknowledgements have separate meanings:

- A hub ACK means only that the hub durably accepted an envelope into its
  ordered log. It says nothing about forwarding, recipient receipt, decryption,
  persistence, display, or reading.
- A recipient ACK is a distinct MLS-authenticated application-level message
  identifying the accepted envelope or Commit and resulting epoch. For a
  Commit, it is emitted only after the recipient durably persists the new
  group state and replay cursor. It does not mean a human read the content.
- Direct delivery has no hub ACK. Its acceptance ACK follows the same durable
  recipient rule. Existing product ACK packets do not satisfy these proposed
  semantics.

Application message delivery is not exactly once. Duplicate envelopes are
idempotently recognized; message identity, sender generation, and persistence
rules control duplicate display. No delivery or availability guarantee is
implied by an ACK.

### Conservative initial payload and frame budgets

These are proposed maximums for a future text-only MLS profile. They are
resource limits to validate, not measured compatibility claims:

| Item | Proposed maximum |
| --- | ---: |
| UTF-8 application plaintext body | 8 KiB |
| Serialized MLS envelope, including protocol framing | 18 KiB measured feasibility target |
| Envelopes in a history or delivery page | 16 |
| Combined serialized envelope bytes in a page | 288 KiB |
| Attachments and arbitrary large application data | Not supported |

Each transport must enforce the same per-envelope limit before allocation or
MLS parsing. Measure the largest valid application message, KeyPackage,
Welcome, proposal, and Commit at the exact candidate version, provider, cipher
suite, credential profile, and transport encoding on every proposed target.
Record encoded sizes and headroom in reproducible tests. The 18 KiB cap is an
explicit measured feasibility target, not a claim that current or candidate
MLS serialization fits. If a required object exceeds it, stop selection and
open a reviewed change request that updates client, hub, queue, history, and
denial-of-service budgets together. Do not silently enlarge the limit.
Boundary, malformed-input, allocation, queue, and history tests are required
before implementation.

The proposed 16-device local-hub group cap is also a measured feasibility
target. Load and storage tests must include owner changes, KeyPackage and
Welcome handling, history catch-up, and concurrent application senders at the
cap. A higher cap requires change control and independent review.

### Credential rotation, removal, and compromise

Routine credential rotation requires the old credential to authorize its
successor. The rotating member creates an authenticated MLS Update proposal
that replaces its own leaf. For non-owner rotation, the group owner includes
that proposal in the sole Commit after verifying the member's new fingerprint
out of band; the owner and member complete reciprocal OOB comparison. Every
current member must freshly verify the new fingerprint before accepting the
Commit. A non-owner never creates a Commit. Owner rotation uses an
owner-authenticated Update proposal included in the owner's Commit. Rotation
does not silently preserve a verification pin. Rotation interval and expiry
remain open policy choices.
If the old key is unavailable or compromise is suspected, do not use
succession: the owner removes the old non-owner credential, then the
replacement receives a new identity, completes mutual OOB verification with
the owner, and is added through a separate Commit. Removal and addition are
never batched.

An offline removed device retains stale prior-epoch state until it receives
notice. Removal takes effect in a surviving member's state when that member
processes and durably persists the Remove Commit, advancing the surviving
group to the new epoch. The removed device is excluded from that epoch, does
not receive the new epoch secret, and does not acknowledge removal. Its
old-epoch messages are rejected by surviving members that have advanced.
Already copied plaintext or secrets cannot be revoked.

If the owner is unavailable or its device is lost without suspected
compromise, remaining members may continue at the last shared epoch, but
cannot change membership. If owner compromise is suspected, the holder of that
key still has valid owner authority under this profile. Clients cannot
distinguish an attacker holding the key from the owner. Members freeze state
changes and admissions, stop trusting the group, and establish a new group
only after fresh OOB checks. The hub cannot revoke the owner or restore prior
group trust.

### Atomic persistence, crash, replay, and concurrency

Applying an MLS envelope and advancing its delivery cursor is one logical
transaction. Persist together the resulting group state, accepted epoch,
contiguous hub sequence or direct generation cursor, processed-envelope
deduplication record, and any recipient ACK intent. A Commit must never be
acknowledged as accepted before all required state is durable. A message must
not be displayed as accepted before its MLS replay state and local record are
durably consistent.

The storage design must choose one of two reviewed patterns: one atomic
transaction covering protocol state and related records, or a write-ahead /
staged-commit scheme with explicit recovery states. It must demonstrate after
crash at every write boundary either the prior complete state or the next
complete state, never a mixed state. Replayed envelopes must be idempotent;
replays below a persisted cursor must not rewind state. Conflicting content for
an already accepted sequence or message identity freezes or rejects without
overwriting prior data.

Concurrent tabs or processes must be serialized by an exclusive per-group
writer, storage transaction, or compare-and-swap generation check. A stale
writer must fail before publishing an ACK or sending a dependent Commit. On
startup, the implementation reconciles pending intents against durable MLS
state and transport cursors before resuming. Browser storage may be evicted or
cleared; this is loss of local state, not a signal to recreate identity or
silently rejoin. No recovery copy or cloud escrow is included.

The storage API and its atomicity are feasibility gates. In particular,
synchronous MLS storage APIs must not be bridged to asynchronous IndexedDB by
assuming an IndexedDB transaction stays active across unrelated awaits.

## Decision register

"Proposed baseline" means the design direction is fixed for this review and
must not be silently changed during implementation. It does not mean the
decision is independently approved or technically feasible. "Open gate" means
evidence is required before implementation or a security claim.

| ID | Decision | Status | Required evidence or owner |
| --- | --- | --- | --- |
| P-01 | One device per user; direct groups contain two members; hub groups contain at most 16 devices including owner | Proposed baseline | Product scope revision and measured load, storage, and interoperability tests at the cap |
| P-02 | One optional local hub, no centralized AS or cloud dependency | Proposed baseline | Independent review of credential trust and hub abuse cases |
| P-03 | Reciprocal full-fingerprint OOB comparison for owner and invitee; exact public one-use KeyPackage reference separately confirmed for admission | Proposed baseline | Canonical encoding vectors, distinct QR flows, UX review, library API proof |
| P-04 | One group owner creates one approved action per Commit; a rotating member authors its authenticated Update proposal, which only the owner may Commit | Proposed baseline | Prove proposal authorship, OOB gating, and owner-only Commit enforcement in selected library |
| P-05 | Unavailable owner freezes membership; suspected compromised owner freezes and abandons group; no election, transfer, or recovery | Proposed baseline | Product acceptance and recovery UX review |
| P-06 | One durable local hub sequence and hash chain; direct owner serialization | Proposed baseline | Partition, rollback, replay, concurrency and restore tests |
| P-07 | Hub ACK means durable hub append; recipient ACK means durable MLS acceptance | Proposed baseline | Wire type separation and end-to-end protocol tests |
| P-08 | Same MLS envelope and protocol semantics across transports | Proposed baseline | Adapter conformance and cross-implementation vectors |
| P-09 | Text-only budgets of 8 KiB body, 18 KiB measured envelope target, 16 envelopes and 288 KiB per page | Proposed baseline | Reproducible exact-candidate size measurements; change control across all limits if infeasible |
| P-10 | Atomic MLS state, cursor, deduplication, and ACK intent with serialized group writers | Proposed baseline | Crash/replay/concurrent-tab proof for every platform adapter |
| O-01 | MLS library, exact revision, provider, cipher suite, and dependencies | Open gate | Complete candidate scorecard and independent review |
| O-02 | Browser WASM, supported browsers, native targets, and interoperability | Open gate | Named-target execution and independent implementation exchange |
| O-03 | MLS storage provider fit, IndexedDB/native atomicity, key protection, eviction behavior | Open gate | Prototype, failure injection, and platform security review |
| O-04 | Exact identity binding fields, canonical JSON choice, fingerprint construction, expiry and rotation interval | Open gate | RFC 8785 assessment, test vectors, usability and security review |
| O-05 | Hub retention, authenticated checkpoint bootstrap, rollback recovery and checkpoint exchange UX | Open gate | Product decision and adversarial implementation tests |
| O-06 | Recipient ACK persistence and retry lifecycle; application-message receipt policy | Open gate | Protocol state machine and replay/restart tests |
| O-07 | Third-party security audit of shipped integration and release artifact | External gate | Independent qualified auditor, findings and remediation evidence |
| O-08 | Physical two-device offline LAN and direct acceptance | External gate | Two independent devices; currently only one device is available |
| O-09 | Group cap and payload/frame budgets fit exact candidate, browser/native targets, and transports | Open gate | Reproducible size and load evidence; reviewed change control for any limit change |
| O-10 | Selected MLS library supports authenticated member-authored Update proposal and owner inclusion only after OOB verification | Open gate | Exact-version test proves sender/leaf binding, proposal authentication, owner authorization, replay rejection, and failure before state advancement |
| O-11 | Bootstrap barrier and ordered Welcome handling are implementable on hub and direct transports | Open gate | Tests prove only invitee processes Welcome; Welcome sequence/hash stays provisional until owner-authenticated checkpoint matches it; one transaction then promotes join state and cursor; no pre-join history is fetched; mismatched checkpoint predecessor is rejected without promotion or fetch; existing members verify bytes/hash/sequence and advance only transport cursor; duplicate/conflict/gap rules hold; from Add Commit through checkpoint acceptance no MLS envelope except Welcome and first checkpoint is transmitted; proposals may be queued locally but not sent; only after acceptance may the invitee send its authenticated delivery ACK; checkpoint is first post-Welcome app envelope; invitee persists checkpoint envelope's own cursor; later Commits wait for durable ACK; retries are identical; and loss cannot create a checkpoint/epoch gap |

## Standards basis and interpretation

- [RFC 9420, Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420.html)
  defines MLS group key establishment, epochs, credentials, messages, and
  protocol serialization. It does not define NearLink's device trust UX,
  owner role, local-hub ordering, durable storage, or availability guarantee.
- [RFC 9750, MLS Architecture](https://www.rfc-editor.org/rfc/rfc9750.html)
  describes Authentication Service and Delivery Service roles and deployment
  consistency models. NearLink's no-centralized-AS choice and one-local-hub
  sequencing are application deployment policy, not properties guaranteed by
  RFC 9750.
- [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
  is a candidate encoding aid for application-owned identity-binding data.
  It is not an MLS encoding requirement and cannot by itself establish
  identity, authorization, or correct signature verification.

The RFC references anchor design vocabulary and protocol boundaries. They do
not validate the proposed profile. Exact RFC conformance, credential binding,
canonicalization, serialization, limits, state transitions, and transport
ordering remain to be checked against the chosen implementation and independent
test vectors.

## Review and release gates

Before product cryptography, an independent reviewer must approve this profile,
resolve any contradictions, and review an exact-library prototype for policy
enforcement, serialization limits, crash safety, replay handling, and supported
targets. A separate independent review must assess the eventual integrated
implementation. Obtain a third-party audit of the shipped cryptographic
integration and release configuration before any public secure-messaging
claim. Record audit scope, findings, remediation, and residual risks.

Physical two-device offline LAN and direct tests remain outstanding because
only one device is currently available. Simulated or same-host browser tests
do not satisfy that gate. None of these gates are satisfied by this document.
