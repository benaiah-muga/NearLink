# Cryptography design review packet

Status: independent design review entry point. No MLS library, provider, cipher
suite, or target has been selected. This packet does not approve an
implementation, establish a security property, or change NearLink's current
security claims.

## Review boundary

Review the proposed first MLS deployment profile and its application policy
before any product cryptography work. The concrete design baseline is in the
[initial MLS deployment profile](initial-mls-deployment-profile.md), with
detailed credential, authorization, delivery, persistence, and abuse-case
rules in the [identity and authorization profile](identity-and-authorization-profile.md).
The [MLS architecture investigation](mls-architecture.md) records protocol
context, candidate evidence, and adoption gates. The
[threat model](threat-model.md) describes current trust boundaries and limits.
The [OpenMLS compatibility spike](../../research/openmls-compat-spike/README.md)
and [dependency policy](../dependency-policy.md) are evidence about isolated
research and dependency handling, not product approval.

Reviewers are asked to approve, reject, or request changes to the candidate-
neutral design and its stated assumptions. This review does not select a
candidate, approve its feasibility, authorize product integration, certify
RFC conformance, or constitute a third-party audit of shipped code. NearLink's
current hub path remains plaintext; MLS, verified identity, and the proposed
delivery and persistence behavior are not implemented. No end-to-end
encryption or emergency-grade reliability claim is supported.

This packet requests a second, targeted independent design review. The
candidate-neutral baseline and identity policy record a prior review whose
scope covered RFC interpretation, identity and owner policy, removal behavior,
delivery acknowledgments, checkpoint ordering, limits, and cross-document
consistency. That review's findings were addressed and re-reviewed. This
request focuses on the current candidate evidence, unresolved O-01 through
O-11, whether those decisions can be implemented consistently, and whether
the design is ready to enter isolated feasibility research. It does not
reopen a finding without new evidence, and it does not close any feasibility,
selection, physical-device, or external audit gate.

## Scope and trust boundaries

The proposed first profile is one device per user, direct groups of two, and
optional local-hub groups capped at 16 devices including the owner. There is
no centralized Authentication Service and no required cloud service. It
proposes MLS per RFC 9420 with one serialized MLS message format and semantics
over hub and direct transports. The 16-member cap and proposed text/frame
budgets are feasibility targets, not measured product limits.

The design places trust in endpoint software, random generation, device key
custody, browser or native persistence, and the user's out-of-band comparison
of full device fingerprints. The identity binding identifies a device key,
not a civil identity. The optional hub is an untrusted Delivery Service for
confidentiality and identity. It may observe metadata, withhold or reorder
traffic, or fail; the proposal adds ordering and consistency rules but does
not make the hub an identity authority. MLS does not protect plaintext on a
compromised endpoint, provide availability, undo copied content, or restore
lost owner authority. Current WebRTC fingerprint comparison identifies only
one session certificate and is not the proposed durable identity system.

Detailed sources: [threat model trust boundaries](threat-model.md#trust-boundaries),
[profile scope and trust](initial-mls-deployment-profile.md#scope-and-trust),
and [MLS threat assumptions](mls-architecture.md#threat-assumptions-and-limits).

## Candidate evidence and status

Candidate facts below are the dated research snapshot recorded in the
[architecture investigation](mls-architecture.md#nl-45-feasibility-decision-2026-10-15).
They must be revalidated against upstream before any later selection decision.
Neither candidate is selected.

| Candidate evidence | Exact reviewed revision | Status and blockers recorded |
| --- | --- | --- |
| `mls-rs` release 0.56.0 | Tag commit `8f1b43f447a792ff9307f1c2c7f54da63914870e`; separately observed main commit `44a4097d0b852e48ad7e822e63cb22e0ac36f232` on 2026-10-15 | Possible future research candidate. Web Crypto provider is experimental for cipher suites 2, 5, and 7; browser support for NearLink's targets and atomic IndexedDB state changes are unproven; exact dependency and license review is incomplete; upstream says no full third-party audit. Moving main is not a release candidate. |
| OpenMLS 0.9.0 | Release tag `openmls-v0.9.0`, commit `3a3e35de3feeca8f6605143c464d5452ae584d43` | Research spike only. Upstream labels `wasm32-unknown-unknown` unsupported and its WASM package experimental; its Rust 1.91.0 minimum exceeds product Rust 1.84.1; synchronous storage does not establish safe asynchronous IndexedDB transactions; the dated lock snapshot includes RustSec findings and an active unmaintained dependency warning requiring disposition. |

The OpenMLS spike proves only a narrow native group flow and a WASM compile.
It uses OpenMLS RustCrypto and basic credentials, tests reload only within an
in-memory provider in one process, and has no browser execution,
browser-to-native interoperability, NearLink identity policy, durable storage,
or independent cryptographic review. These facts do not select OpenMLS or
waive its upstream target classification. See the
[spike README](../../research/openmls-compat-spike/README.md) for its exact
scope and dated dependency evidence, and the
[dependency policy](../dependency-policy.md) for research isolation and audit
exception handling.

The current hard-gate outcome is that neither evaluated candidate passes.
Do not infer selection readiness from compilation, native tests, an RFC claim,
license metadata, or activity on a moving branch. Candidate scorecard and
selection rule are in [MLS architecture, candidate library selection](mls-architecture.md#candidate-library-selection).

## Proposed controls for review

The reviewer should assess these interdependent rules in the profile and
identity document:

- **Identity and admission:** versioned device credential binding; reciprocal
  out-of-band comparison of full fingerprints; distinct identity and
  invitation QR flows; admission of the exact, public, one-use KeyPackage
  reference that was confirmed. Canonical encoding, fingerprint input, and
  credential details remain open.
- **Group authority:** one owner; only owner-created Commits; exactly one
  approved action per Commit; member-authored Update proposals can only be
  committed by the owner after the required checks. No external Commit, owner
  transfer, self-removal, or implicit recovery authority.
- **Delivery and ordering:** same MLS bytes across transports; optional local
  hub sequence and hash chain; Welcome bootstrap barrier and authenticated
  checkpoint; direct owner serialization; explicit gap, replay, duplicate,
  rollback, and conflict handling. Hub ACK means durable hub append. Recipient
  ACK means the specified MLS state and cursor were durably accepted, not that
  a person read the message.
- **Persistence and limits:** state, epoch/cursor, deduplication record, and
  ACK intent advance as one recoverable transaction under a serialized group
  writer. Crash, restart, replay, concurrency, and storage loss must fail
  closed. Proposed payload, envelope, page, and group caps need measurement on
  the exact candidate and targets.
- **Recovery and compromise:** no owner election or recovery; owner loss stops
  membership changes. Suspected owner compromise freezes and abandons the
  group after fresh verification. Removal cannot erase previously copied
  plaintext or stop an offline removed device from holding stale state.

The detailed source of truth is the profile's [decision register](initial-mls-deployment-profile.md#decision-register)
and identity document's [delivery and persistence rules](identity-and-authorization-profile.md#delivery-ordering-and-offline-behavior).
The proposed rules remain subject to review and feasibility evidence.

## Open decisions and required disposition

The design reviewer should explicitly disposition each open item, or state
what evidence is needed and who owns it. A blank or unknown item is not a pass.

| Profile decision | Review question or evidence required |
| --- | --- |
| O-01: library, revision, provider, cipher suite, dependencies | Is the candidate scorecard complete at exact versions and source commits, with independent approval? At present, no candidate clears it. |
| O-02: browser, native targets, interoperability | Which named browser and native targets are in scope, and where is execution and independent implementation exchange evidence for the same profile and suite? |
| O-03: storage, key protection, eviction | What design proves atomic MLS transitions with IndexedDB and each native store, including failure injection, key handling, and storage loss? |
| O-04: identity encoding and lifecycle | Which binding fields, canonicalization and fingerprint rules, expiry, and rotation interval are accepted, with cross-language vectors and UX review? |
| O-05: hub retention and Welcome checkpoint | Are sequencing, checkpoint authentication, rollback handling, recovery UX, and partition behavior acceptable and implementable? |
| O-06: receipt and retry | What are the exact authenticated ACK, persistence, retry, and application receipt semantics across restart? |
| O-07: third-party audit | What exact shipped integration and release artifact will be in scope, and how will findings and remediation be evidenced? This remains external and is not this design review. |
| O-08: physical two-device acceptance | Who will run offline LAN and direct tests on two independent devices? Current repository evidence does not satisfy this gate. |
| O-09: group and frame budgets | Do measured exact-candidate sizes, target performance, and transport/storage tests meet proposed limits? If not, what reviewed change updates all dependent limits? |
| O-10: member Update and owner Commit | Does the exact API expose authenticated proposal sender and leaf binding so authorization is checked before state mutation? |
| O-11: Welcome bootstrap barrier | Can both transports enforce the exact sequence/hash, checkpoint, durable promotion, ACK, and no-gap rules stated in the profile? |

These identifiers and required evidence are defined in the profile's
[decision register](initial-mls-deployment-profile.md#decision-register).
External audit and two-device acceptance cannot be closed by approving the
design document.

## Preconditions before product integration

Product integration must remain out of scope until the design review is
complete, a candidate is selected under the architecture hard gates, and all
of the following have reviewable evidence:

1. An independent design reviewer approves the candidate-neutral profile,
   resolves contradictions, and dispositions O-01 through O-06 and O-09
   through O-11. Any changed policy returns through review.
2. An isolated, non-product research prototype gathers the exact evidence
   needed by the scorecard: named browser and native targets,
   cross-implementation interoperability, identity and owner policy
   enforcement before mutation, exact KeyPackage admission, size limits, and
   the hub and direct delivery rules. This research occurs before selection
   and must not add the candidate to product dependency graphs.
3. One exact candidate release and source revision, provider, cipher suite,
   feature graph, and complete dependency lock are selected only after every
   hard scorecard row passes. Revalidate upstream support, MSRV, advisories,
   licenses, maintenance, and security reporting; independently review the
   resulting evidence and any bounded exception.
4. A platform-specific persistence design demonstrates atomic state/cursor/
   deduplication/ACK handling, serialized writers, and crash, replay,
   concurrency, migration, and storage-loss behavior. Independent review
   covers the adapter and failure evidence.
5. Product scope accepts owner-loss behavior, trust UX, and recovery limits.
   Two-device offline LAN and direct acceptance must be run on two independent
   devices before those behaviors are represented as validated.

The isolated spike is not a prerequisite that can pass these gates by itself,
and it must remain outside product dependency graphs until selection and
integration review authorize otherwise. The full pre-integration gates are in
[MLS architecture](mls-architecture.md#implementation-and-release-gates) and
the [identity profile's proposed test gates](identity-and-authorization-profile.md#proposed-test-gates-before-product-integration).

## Preconditions before a third-party implementation audit

An implementation audit is a later, separate external gate. It can be scoped
only after an implementation exists and reviewers can identify the precise
system under audit. At minimum, freeze and provide:

- the approved design and recorded dispositions, exact source commit, release
  build configuration, target matrix, toolchain, selected library/provider/
  suite revisions, and all dependency lockfiles;
- the protocol and identity test vectors, interoperability results, policy
  enforcement tests, size and resource-bound evidence, and documented
  deviations from the approved profile;
- the complete persistence adapter and schema, migrations, key storage and
  deletion behavior, concurrency model, and crash/replay/failure-injection
  results for each target;
- the hub and direct transport adapters, ordering and checkpoint behavior,
  ACK semantics, threat model, residual risks, and reproducible build and
  verification instructions.

The auditor must independently review the shipped integration and release
configuration, findings must be remediated or explicitly dispositioned, and
the audited artifact must match the release artifact. Audit scope, report,
findings, remediation, and residual risk must be recorded. A design review,
compatibility spike, dependency scan, or repository test run is not that audit.
No public security claim follows until the external audit and remaining
release gates are complete. See [external validation and release gates](identity-and-authorization-profile.md#external-validation-and-release-gates).
