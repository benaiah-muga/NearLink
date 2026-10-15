# Identity and authorization profile proposal

Status: proposal pending independent security review

This document proposes a conservative identity, group authorization, delivery,
and storage profile for NearLink. It is a design artifact, not an implementation
description or security assessment. Decisions below must be checked against the
selected MLS library, supported platforms, and a complete threat model before
implementation.

## Current implementation status

None of the identity or group-security behavior proposed here is implemented.
The current web client and local hub exchange plaintext message packets. A
joining client chooses its own room, sender identifier, and display name. The
hub checks that later packets use the sender identifier claimed at join, but
does not authenticate that identifier or authorize room membership. Room codes
are routing values. The hub stores bounded plaintext history in SQLite. Current
WebRTC DTLS fingerprints identify a connection certificate for one session,
not a durable device identity. The Rust synchronization primitives validate
message structure and reconcile bounded identifiers, but do not authenticate
senders or persist MLS state.

Continue to describe current hub messaging as plaintext and current peer names
as unverified. This proposal does not support claims of end-to-end encryption,
verified identity, emergency reliability, or secure recovery.

## Design goals and limits

- Operate without an internet service or mandatory cloud identity provider.
- Use MLS as the candidate group key management and message protection
  protocol, subject to a separate library and target selection gate.
- Treat each installation as a device identity. Do not claim that a device
  identity proves a person's civil identity.
- Require an explicit user trust action before showing a device as verified.
- Make the room code a routing hint only.
- Fail closed on unknown credentials, changed keys, invalid group policy, and
  conflicting group state.
- Keep hub and direct transports independent of the identity and MLS state
  machine.
- Accept loss of the owner device as a group membership-management outage.
  Do not add an implicit recovery authority or cloud dependency.

The design cannot protect plaintext on a compromised endpoint, make an
unavailable device available, erase content already read by a former member,
or ensure delivery through a malicious or offline hub.

## Identity and credential model

### Device identity

Each installation creates a random, opaque device identifier and a local
cryptographic identity. The stable identifier is distinct from the editable
display name. Display names, room codes, network addresses, and user-entered
sender strings are never evidence of identity.

The MLS credential binding is proposed to include:

- Profile version.
- Opaque NearLink device identifier.
- Opaque local account label, if the product retains one. It has no external
  authority and must not be presented as a real-world identity.
- MLS credential type and public signature key.
- Credential sequence number and optional validity interval, if expiry is
  adopted.

The exact encoding, credential type, signature algorithms, lifetime, and
canonicalization rules remain subject to library compatibility and independent
review. Do not implement a custom signing or key agreement protocol. A
credential is valid only when its MLS signature checks and the application
policy accepts its binding and succession from any previously trusted key.

### Verification and changed credentials

The initial state for every discovered device is `unverified`. A user can
verify a device by scanning its NearLink QR code in person or by comparing its
full credential fingerprint through another trusted channel. The QR contains
public identity-binding data and public key material only. It must not contain
private keys, group secrets, recovery secrets, or a one-time KeyPackage.

The fingerprint is calculated over a versioned, domain-separated canonical
encoding after the encoding has been independently reviewed. Keep the full
fingerprint available for comparison even if the interface also displays a
short form. A successful comparison means `verified device`; it does not mean
verified person.

If the binding or signature key changes, the prior verification is cleared and
the UI shows `changed key`. The user must compare the new fingerprint before
trusting it. Invalid credentials are rejected and shown as `invalid`; they do
not silently become ordinary unverified peers. Editing a display name does
not change the credential or its verification state.

MLS requires applications to validate credential identity bindings and
reference identifiers when new credentials enter a group. See [RFC 9420,
Section 5.3](https://www.rfc-editor.org/rfc/rfc9420.html#section-5.3). The
trust action described here is an application policy proposal, not a behavior
provided automatically by MLS.

### Initial single-device scope

The current product scope is one device per user. This profile does not define
account-wide identity, device linking, or synchronization of one user's
identity across multiple devices. Each installation has its own device
identity. Supporting multiple devices for one user requires a later profile
revision and independent review.

## Group authorization

### Owner-controlled policy

The first group policy is owner-controlled:

1. The device that creates the MLS group is its sole owner.
2. Only the current owner may create any MLS Commit in this profile. Members
   other than the owner may send application messages, but may not commit an
   Add, Remove, Update, external commit, or any other group-state change.
3. The owner may create a Commit only after explicitly approving one policy
   action: adding one verified device, removing one non-owner device, or
   rotating the owner's own credential with an old-key-authorized successor.
   Batching several membership actions into one Commit is not allowed by the
   initial profile.
4. Owner self-removal, owner replacement, external commits, and group-policy
   changes are prohibited. The policy version and owner device identifier are
   fixed for the lifetime of the group. Owner key rotation preserves the owner
   device identifier only through the authorized credential succession rule.
5. Every member validates the Commit's authenticated committer against the
   owner credential pinned in the current group policy, validates the exact
   permitted action, and rejects all other Commits before advancing state.
   Unknown or invalid policy state is rejected and surfaced for recovery.
6. A group has one owner in this profile. There is no implicit owner election,
   administrator role, or room-code based admission.

This owner invariant must be represented in authenticated group state and
enforced by every client, including clients processing replayed or externally
provided MLS messages. The exact policy encoding and selected MLS API are
implementation gates. Before implementation, a prototype and independent
review must demonstrate rejection of non-owner Commits, external commits,
owner self-removal, unauthorized credential updates, policy changes, malformed
or stale Commits, and Commits with unrelated or batched proposals. If the
selected library cannot expose enough authenticated Commit data to enforce
these rules before state advancement, it is unsuitable for this profile. No
product implementation may treat an owner name or sender string as sufficient
authorization.

### Admission binds verification to the exact KeyPackage

Out-of-band comparison must cover the exact MLS KeyPackage that the owner
admits, not only a long-lived device fingerprint. The proposed invite QR
contains the credential binding, its full fingerprint, the serialized
KeyPackage, and the MLS KeyPackage reference computed according to RFC 9420.
The invitee shows the same full fingerprint and KeyPackage reference for the
owner to compare through the trusted channel. The owner validates the
KeyPackage, verifies that its credential key matches the OOB-verified binding,
checks that the KeyPackage has not been used or superseded, and admits that
exact object. The accepted Commit and Welcome must correspond to that admitted
KeyPackage. A regenerated, expired, already-used, or otherwise changed package
requires a new OOB comparison. QR data contains public material only, and
KeyPackages are treated as one-use material according to the protocol.

If the chosen library or application flow cannot bind the OOB-confirmed
KeyPackage reference to the exact Add and corresponding Welcome, admission is
blocked until the profile is revised and reviewed. This avoids treating a
credential fingerprint comparison as approval of an arbitrary later package.

### Owner loss and group continuation

If the owner device is lost, destroyed, unavailable indefinitely, or its
credential is revoked, remaining members may continue exchanging application
messages under the current group epoch if their MLS state remains valid. They
cannot add or remove members, transfer ownership, or recover the lost owner's
identity under this profile. Membership changes are frozen. An offline owner
cannot receive a revocation request; the group continues at its last shared
epoch until the owner returns or members abandon it and create a new group.

To continue with membership changes, remaining members create a new group and
re-verify and re-invite the desired devices. The old group remains separate;
there is no silent transfer of its history or owner role. This is a deliberate
availability limitation. An owner succession or recovery process requires a
new independently reviewed profile and must define proof of authority without
making the hub an implicit trust root.

## Credential rotation, revocation, and recovery

### Routine rotation

A device key rotation creates a new credential sequence. Where the old key is
available, it authorizes its successor. The application checks the transition,
shows a changed-key notice, and requires a fresh out-of-band comparison before
preserving the user's verified-device status. A new credential does not inherit
the old fingerprint pin automatically. Exact rotation timing and credential
expiry are unresolved pending library and usability review.

### Lost or compromised device revocation

The group owner removes the affected device with an MLS membership change.
Revocation takes effect for a member only when it has accepted the removal
Commit and advanced to the resulting epoch. The removed device does not receive
new epoch secrets through that Commit and cannot create valid application
messages for the new epoch. An offline device cannot be revoked at a distance
until an authorized owner creates the removal Commit, and it may still send
messages for an old epoch while disconnected. On receiving the removal Commit,
remaining members reject messages from earlier epochs, including valid old
epoch messages that were delayed in transit. Such delayed messages are marked
unavailable and are not decrypted or displayed after the new epoch is
accepted. This is an intentional loss policy to avoid displaying a message
from a state that predates the accepted membership change. A member may already
have copied old plaintext or old-epoch secrets. Revocation cannot undo that
access or retract delivered messages.

If the owner device itself is lost or compromised, the owner cannot be
replaced under this profile. Remaining members may continue the existing group
without membership changes or create a new group and re-invite members after
verification.

### Recovery

There is no account recovery, server recovery, automatic key escrow, or
transferable recovery phrase in the initial profile. Loss of all copies of a
device's private identity and MLS state means that device identity and any
locally held history may be unrecoverable. The user creates a new device
identity and contacts verify and invite it as a new member. The new device does
not inherit old identity pins or group membership automatically.

An encrypted export or recovery phrase could improve recoverability but would
create another high-value secret and a new trust path. It is explicitly out of
scope until key derivation, backup protection, restoration, revocation, and
multi-device behavior receive independent review.

RFC 9420 discusses credential expiry and revocation operational concerns in
[Section 5.3.2](https://www.rfc-editor.org/rfc/rfc9420.html#section-5.3.2).
The protocol does not supply NearLink's recovery policy.

## Delivery ordering and offline behavior

MLS group state has a linear sequence of epochs. Members need a common order
for Commits. RFC 9750 distinguishes strongly consistent delivery, where the
Delivery Service selects a single Commit order, from eventually consistent
delivery, where clients must reconcile messages and may observe conflicting
Commits. See [RFC 9750, Section 5.2](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.2).

### Delivery Service role

The optional local hub acts as the MLS Delivery Service (DS): it routes and
stores bounded MLS envelopes, distributes published one-use KeyPackages and
corresponding Welcome messages, and sequences envelopes within the scope below.
It is not the Authentication Service (AS), does not certify identity
bindings, and cannot authorize group membership. Clients validate credentials
and the owner policy. The hub can observe routing identifiers, timing, sizes,
and connection metadata, and can suppress, delay, replay, or equivocate about
delivery. It cannot be treated as a trusted source of identity or group state.

### Initial local-hub profile

The proposed first MLS delivery adapter uses one local hub as the ordering
service for a group. This service is authoritative for order only while the
clients accept its consistent log; it is not a cryptographic trust root.

- The hub receives MLS envelopes and assigns a monotonically increasing
  per-MLS-group sequence to every accepted MLS envelope, including proposals,
  Commits, application messages, and Welcomes. Sequence values start at 1 and
  never reset for a group identifier.
- It stores the envelope and sequence durably before acknowledging or
  broadcasting it.
- It broadcasts the same sequence order to all connected group members.
- Every history page includes the group identifier, sequence, canonical
  envelope hash, previous sequence hash, and a retention/truncation marker.
  The hash chain is over the canonical sequence and envelope bytes.
- Clients persist the highest contiguous sequence and hash. They accept only
  the next sequence with the expected previous hash. An identical duplicate
  sequence and hash is idempotent. A repeated sequence with a different hash,
  a lower sequence than the persisted high-water mark, or a broken hash chain
  is treated as hub equivocation or rollback and freezes the group.
- A missing sequence pauses group-state changes and triggers bounded history
  repair. If retention has removed a required sequence, the hub returns an
  explicit truncation result; clients do not skip the gap or continue the
  existing MLS group from an incomplete transcript.
- A client does not treat a locally created Commit as authoritative until it
  receives the ordered Commit back from the delivery path.
- On conflicting commits or an unrecoverable sequence gap, the client pauses
  the group and exposes a recovery state. It does not choose a fork silently.

Because this proposed sequence covers application messages as well as state
changes, pruning any envelope needed by a disconnected member can prevent that
member from resuming the existing group, even when the missing item was not a
Commit. The member may need to create a new group and be verified and invited
again. This is an intentional fail-closed availability and retention cost of
the proposal. Retention limits and the user-facing recovery path require
explicit product approval before implementation.

The sequence is scoped to the immutable random MLS group identifier, not to a
room code, sender, connection, or hub URL. Duplicate submissions of the same
canonical envelope retain their original sequence; they do not allocate a new
sequence. Multiple concurrent hubs for one group, sequence reset, rollback of
the hub database, and switching hubs without a verified checkpoint are
unsupported. A hub restart must preserve the sequence and hash-chain state. If
the hub loses that state or a client detects rollback, the current group is
frozen. Recovery requires trusted members to compare the latest group epoch
authenticator and sequence/hash checkpoint through an authenticated channel.
If they cannot establish one common checkpoint, they create a new group and
re-verify and re-invite members. A new or reset hub cannot silently restart the
old group identifier at sequence 1.

Hub hash chains make inconsistent views detectable when clients compare
checkpoints; they do not stop a hub from presenting one internally consistent
but stale view to a client with no prior checkpoint. A new client must obtain
the current group checkpoint from a trusted existing member through the
authenticated invite flow. Checkpoint comparison is required after a suspected
rollback or hub change. No claim is made that a hub can prove completeness of
history by itself.

This gives a local hub an ordering role, not authority to create members,
authenticate identities, or learn MLS secrets. The hub can still observe
routing metadata, suppress delivery, or make a group unavailable. The design
must later specify behavior for multiple hub processes, hub database rollback,
and a client reconnecting to a different hub. No cloud service is required.

### Direct peer transport

Direct transport uses the same MLS envelopes and group state as hub delivery.
It does not add a second identity or encryption protocol. In the initial
direct adapter, a group has exactly two members and only its owner may create
Commits. The owner serializes all Commits through one durable per-group state
actor and permits only one unacknowledged Commit at a time. The owner sends the
same Commit bytes again on retry; it never creates a replacement Commit for
the same pending transition. The other member accepts only the next Commit
from the pinned owner and sends an authenticated application-level
acknowledgment identifying the accepted Commit and resulting epoch. The owner
does not create another Commit until that acknowledgment arrives. Duplicate
Commit delivery is idempotent. Both endpoints pause application sends while a
Commit is pending so that messages do not cross an uncertain epoch transition.
When the owner removes the other member, the resulting group has no other
member who can acknowledge. The owner commits and persists that removal
locally, does not wait for an acknowledgment from the removed device, and
requires a fresh OOB-verified admission before adding a replacement.

If the owner is offline, neither member creates a new Commit. If a Commit is
pending when the connection drops, both endpoints resume by retransmitting or
requesting that exact Commit and its associated Welcome, if any. A member that
observes a sequence/epoch gap requests the missing envelope from the owner and
does not apply later Commits. Application messages use MLS per-sender
generations: duplicates are discarded, bounded out-of-order messages are
buffered, and an unresolved generation gap is surfaced as missing rather than
silently skipped. The two senders' application streams need not be globally
ordered relative to each other.

If two different owner-authenticated Commits for the same prior epoch are
observed, if the persisted state actor detects concurrent writers, or if the
members cannot agree on the accepted Commit and epoch authenticator, the group
is frozen. There is no automatic tie-break or rollback to a fork. Members
compare the latest epoch authenticator and pending Commit through an
authenticated channel. If they cannot prove one common state, the recovery is
to create a new group, verify and invite devices again, and leave the divergent
group unusable. Owner-only commits reduce conflicts but do not eliminate
concurrent-tab, state-restore, or malicious-owner equivocation risks.

This initial direct rule supports two members only. Direct multi-member groups,
offline membership changes, mesh sequencing, and automatic fork resolution are
not specified for implementation.

Application messages may be queued locally while disconnected, but the
product must not label them transmitted, delivered, or read until the
corresponding event is actually observed. A message encrypted under an older
epoch that arrives after a member has accepted a newer Commit is rejected and
not displayed. Before a new Commit is accepted, valid messages from the current
epoch may be delivered according to the transport order. Queue persistence and
resending must preserve the original MLS ciphertext and message identity; the
client must not re-encrypt old plaintext under a new epoch without treating it
as a new message. No eventual or exactly-once delivery guarantee is made.

## Persistence and privacy boundaries

### Browser endpoint

The proposed browser storage boundary is:

- IndexedDB stores the local device identity metadata, public credentials,
  verification pins, MLS group state, processed-envelope identifiers, group
  epoch and sequence cursors, and encrypted MLS envelopes.
- Decrypted message content is local endpoint data. If cached for conversation
  history, it remains on that endpoint and is not uploaded to the hub.
- Private key material and MLS secrets are never placed in application logs,
  analytics, diagnostic exports, or user-visible QR payloads.
- Storage writes that advance MLS state must be coordinated atomically with
  the associated sequence cursor and processed-envelope deduplication state.
  Interrupted writes must not leave the app believing it advanced when the
  persisted group state did not advance.

Browser storage may be cleared, evicted, copied, or read by compromised
same-origin code. A non-extractable Web Crypto key does not prevent malicious
same-origin code from asking the application to use it. Browser storage is not
a backup or a secure hardware vault. These limits must be shown in user-facing
recovery guidance.

### Local hub

After an MLS integration, the hub may store bounded MLS ciphertext envelopes,
opaque group routing identifiers, per-group sequence metadata, and retention
metadata needed for delivery. It must not store plaintext message bodies,
private identity keys, MLS group secrets, recovery secrets, or an identity
directory that silently becomes an authority. Logs must not include message
content, credentials, secrets, or unnecessary personal identifiers.

The existing hub currently stores plaintext packets. This proposed boundary
requires a protocol and database migration before any product security claim.

### Atomicity requirement

The MLS library and storage adapter must support a reviewed transaction model
for applying a message or Commit, persisting the new MLS state, advancing the
delivery cursor, and recording deduplication state. If one atomic transaction
cannot cover these operations, the implementation must define a recoverable
write-ahead or staged-commit protocol and prove crash recovery. Do not assume a
synchronous library storage interface can be safely bridged to asynchronous
IndexedDB transactions.

## Library and platform constraints

The repository's current Rust toolchain is 1.84.1. OpenMLS v0.9.0 sets
`rust-version = "1.91.0"` in its manifest. Its v0.9.0 README lists
`wasm32-unknown-unknown` as built in CI but unsupported and untested. See the
[OpenMLS v0.9.0 manifest](https://github.com/openmls/openmls/blob/openmls-v0.9.0/Cargo.toml)
and [target support table](https://github.com/openmls/openmls/blob/openmls-v0.9.0/README.md).

The mls-rs 0.56.0 README lists its Web Crypto provider for cipher suites 2, 5,
and 7 as experimental, X.509 support as unsupported for that provider, and
states that the library has not received a full third-party security audit.
See the [mls-rs 0.56.0 README](https://github.com/awslabs/mls-rs/blob/0.56.0/mls-rs/README.md).

These facts are constraints for candidate evaluation, not a library selection.
The current isolated compatibility work is a research spike only. No MLS
library or provider is selected by this proposal.

## Proposed test gates before product integration

These tests are requirements for a future implementation. They have not been
implemented by this document.

### Identity and trust

- New devices start unverified; changing display names does not change device
  identity or verification.
- Exact out-of-band comparison can mark a device verified; an altered key or
  binding clears that state and requires a new comparison.
- Invalid credentials, unsupported profile versions, malformed canonical
  encodings, and invalid succession chains are rejected.
- A room code, sender string, display name, IP address, or hub response cannot
  mark a device verified.
- Reload preserves valid public trust pins and rejects corrupted or ambiguous
  records without downgrading changed keys to trusted.

### Group authorization and lifecycle

- Only the owner can add or remove a device; non-owner membership Commits are
  rejected by every client.
- An owner-approved addition validates the credential and accepts only the
  exact OOB-confirmed KeyPackage reference and matching Welcome for the
  accepted Commit. A substituted, replayed, regenerated, or stale KeyPackage
  is rejected.
- Non-owner Commits, external commits, owner self-removal, policy changes,
  unauthorized Updates, and batched membership actions are rejected before
  state advances.
- Removed members cannot create a valid new-epoch application message for
  remaining clients.
- Valid old-epoch messages delayed until after a removal Commit are rejected
  and not displayed. Offline revocation is not represented as complete until
  the owner creates the Commit.
- Owner loss freezes membership changes and does not trigger automatic owner
  election or recovery.
- New-group recovery requires explicit credential verification and invites.

### Ordering, partitions, and storage

- Hub clients observe one durable ordered sequence across sender echo, replay,
  reconnect, and history repair. Sequence values are scoped to the MLS group
  identifier, cover all MLS envelopes, and never reset.
- Duplicated envelopes are idempotent; missing sequence numbers pause group
  changes; conflicting same-epoch Commits never silently advance state.
- A hub history rollback, broken hash chain, or different envelope at an
  already seen sequence freezes the group. Checkpoint comparison detects
  inconsistent views; a new client requires a current checkpoint from a
  trusted existing member.
- In direct two-member mode, only the owner creates one Commit at a time, waits
  for an authenticated acknowledgment before the next Commit, retransmits the
  identical pending Commit after disconnect, and freezes on conflicting
  Commits or irreconcilable epoch state. No automatic fork winner is selected.
- Per-sender application generations handle duplicate and bounded out-of-order
  messages. An unresolved gap is reported as missing, not skipped.
- Crash injection at each state-write boundary either recovers the previous
  valid state or the fully committed next state, never a mixed state.
- Hub persistence contains no plaintext message body, private key, or MLS
  secret. Diagnostics contain no message body or secret.
- Storage loss does not silently recreate the old identity or claim history
  recovery.

Tests do not substitute for separate interoperability validation, independent
security review, platform testing, or a third-party audit of a shipped
integration.

## External validation and release gates

The following are open gates and have not been completed by this proposal:

- Physical validation with at least two independent devices, including local
  hub delivery, direct delivery, disconnection, reconnection, and lost-owner
  behavior on the named supported platforms.
- Independent security review of this profile and its eventual implementation.
- A third-party security audit of the shipped MLS integration, credential
  handling, persistence adapter, and release configuration. The audit scope,
  findings, fixes, and residual risks must be recorded before any public
  security claim.
- Cross-implementation MLS interoperability for the selected exact library,
  provider, cipher suite, credential profile, and supported targets.

Passing automated tests or a simulator does not satisfy physical device
validation or the third-party audit gate.

## Open decisions and required review

Before implementation, independent reviewers must approve the canonical
credential binding and fingerprint, group policy encoding, owner authorization
checks, credential lifetime and rotation rules, direct-transport recovery,
MLS state transaction model, endpoint key handling, and exact library/provider
profile. Product decisions remain open for account semantics, multiple-device
management, expiry interval, whether message queues send old-epoch messages
after reconnection, and any future owner succession or encrypted recovery.

Until those reviews and the full implementation gates pass, current NearLink
behavior and security claims remain as documented in the
[`threat model`](threat-model.md) and [`MLS investigation`](mls-architecture.md).
