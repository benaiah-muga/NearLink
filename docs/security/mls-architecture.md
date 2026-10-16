# MLS implementation investigation

Status: candidate research and compatibility evidence, no implementation
candidate selected and no security claim approved

Research snapshot: 2026-10-15. Repository support statements below were checked
against `mls-rs` commit `d4c5b19f4bbf8a931face27fc9e30f2db33ce83e` and OpenMLS
release tag `openmls-v0.9.0` (commit `3a3e35de3feeca8f6605143c464d5452ae584d43`).
No MLS dependency or version has been selected.

## NL-45 feasibility decision, 2026-10-15

No evaluated candidate clears the current hard selection gates. This is a
decision to defer library selection and product integration, not a rejection of
MLS or a change to the candidate-neutral deployment profile.

The highest `mls-rs` Git tag observed on 2026-10-15 remains `0.56.0` at
`8f1b43f447a792ff9307f1c2c7f54da63914870e`. The default branch had moved to
`44a4097d0b852e48ad7e822e63cb22e0ac36f232`, committed on 2026-10-15. The
candidate assessment is pinned to the tagged `0.56.0` source; the moving main
branch is evidence of ongoing maintenance, not a release candidate. The 0.56.0
README and current main README both continue to label the Web Crypto provider
experimental for cipher suites 2, 5, and 7, and state that the library has not
received a full third-party security audit. The README advertises WASM builds
and configurable storage traits, but does not establish support for NearLink's
named browsers, a production browser crypto provider, or atomic IndexedDB
state transitions. Its storage examples are in-memory and SQLite. The exact
0.56.0 dependency license inventory and compatibility review have not been
completed for NearLink.

OpenMLS v0.9.0 remains unsuitable for selection against the current profile:
the exact release README calls `wasm32-unknown-unknown` unsupported even though
CI builds it, and the workspace minimum Rust version is 1.91.0 versus the
product's pinned 1.84.1. The separate spike toolchain demonstrates that a
compile can be attempted, but does not change the upstream support classification
or prove browser execution. Separately, upstream issue #1983 reports a panic in
`external_commit_builder` on this target for revisions after PR #1972, after a
call to `SystemTime::now()`. The issue does not establish whether the affected
code is present in the pinned v0.9.0 tag. The profile does not permit external
commits, so the reported path is not evidence of a defect in the proposed
admission flow; it does reinforce that a WASM compile alone cannot establish
usable browser behavior. OpenMLS's storage provider methods are synchronous,
while NearLink's browser persistence uses asynchronous IndexedDB. An adapter
must prove crash safe, atomic group state changes before this mismatch can be
accepted.

The isolated OpenMLS lockfile audit snapshot from 2026-10-15 includes
`RUSTSEC-2026-0330` and `RUSTSEC-2026-0331` for `libcrux-kem` 0.0.9. The
Rust 1.91 `cargo tree --target all -i libcrux-kem@0.0.9` check found no active
path for the selected RustCrypto provider, but the package remains in the full
lockfile and must be resolved or independently dispositioned before selection.
The same active graph includes the informational unmaintained
`proc-macro-error2` warning. Cargo metadata records declared license expressions
for the 198 resolved spike packages; this is only an inventory, not a license
compatibility decision. The OpenMLS workflow does not rerun RustSec, so that
audit is a dated snapshot. The repository security workflow now scans the
isolated `mls-rs` lockfile without advisory exceptions. It covers the complete
lockfile; target-specific active dependency graphs still require separate
review.

Assessment: `mls-rs` is the more plausible next research candidate because its
README advertises WASM builds and configurable storage, but its experimental
Web Crypto provider, missing NearLink browser evidence, unproven IndexedDB
atomicity, incomplete dependency and license review, and lack of a full
third-party audit fail the hard gates. OpenMLS has documented target and MSRV
gaps in addition to the storage and dependency findings. Neither candidate
should be used in product flows, and no alternate candidate among those
reviewed here clears the same gates. Do not weaken the criteria or infer
readiness from native tests, compilation, conformance statements, or
moving-branch activity.

Revalidation sources: [OpenMLS v0.9.0 supported target table](https://github.com/openmls/openmls/blob/openmls-v0.9.0/README.md),
[OpenMLS v0.9.0 workspace manifest](https://github.com/openmls/openmls/blob/openmls-v0.9.0/Cargo.toml),
[OpenMLS issue #1983](https://github.com/openmls/openmls/issues/1983),
[mls-rs 0.56.0 README](https://github.com/awslabs/mls-rs/blob/0.56.0/mls-rs/README.md),
[mls-rs current main README at 44a4097](https://github.com/awslabs/mls-rs/blob/44a4097d0b852e48ad7e822e63cb22e0ac36f232/mls-rs/README.md),
and [mls-rs 0.56.0 tag commit](https://github.com/awslabs/mls-rs/tree/8f1b43f447a792ff9307f1c2c7f54da63914870e).

## NL-60 upstream revalidation, 2026-10-16

This revalidation adds exact upstream metadata and screens one browser-oriented
alternative. It does not select a candidate or change the hard gates. The
result remains that no reviewed candidate is ready for product integration.

The exact `mls-rs` 0.56.0 tag still resolves to
`8f1b43f447a792ff9307f1c2c7f54da63914870e`. Its published core manifest
declares Rust 1.82.0, which is within NearLink's pinned Rust 1.84.1. This only
clears the declared core crate MSRV check. It does not establish that the exact
WebCrypto feature graph and browser target build on 1.84.1, nor does it review
the resolved dependency graph. The release README continues to describe WASM
builds and configurable storage traits, but the WebCrypto provider remains
experimental for suites 2, 5, and 7, with X.509 unsupported. No named-browser
execution evidence or browser provider maturity evidence was found. The
published storage examples remain in-memory and SQLite; there is no supplied
IndexedDB implementation or proof of atomic transactions across MLS state,
cursor, deduplication, and ACK intent.

The exact `mls-rs-crypto-webcrypto` manifest in the 0.56.0 tag identifies
provider package version 0.15.0. Its WebCrypto and WASM dependencies establish
that it is intended to call browser cryptographic APIs, not that the provider
is production mature or supported in NearLink's named browsers. The package's
full transitive lock, license compatibility, and current advisory exposure
have not been reviewed for a NearLink feature graph. Upstream's own statement
that the implementation has not received a full third-party security audit
remains a hard-gate blocker. Official upstream audit and interop workflows
are evidence of project CI activity, but the reviewed material does not
establish independent cross-implementation exchanges for the exact 0.56.0
source and proposed NearLink profile.

The OpenMLS v0.9.0 assessment has no material upstream status change in this
revalidation: its Rust 1.91 minimum remains above the product pin, upstream
still marks `wasm32-unknown-unknown` unsupported, and synchronous storage does
not prove safe asynchronous IndexedDB persistence. The existing spike audit
is a 2026-10-15 lockfile snapshot, not a refreshed scan or continuing coverage.

The official MLS implementation inventory also lists `ts-mls`, a TypeScript
implementation. Its latest stable release observed here is v1.6.4 at commit
`ddff62aa15d3064fff5d77dda35b3cdf2970870d`; the moving main branch reports
version `2.0.0-rc.16`, so it is not a stable revision to assess as a release.
The project describes browser suitability and RFC 9420 support, and its
repository includes interop material. Its README says it has no formal
security audit. The evidence reviewed does not establish an atomic durable
IndexedDB integration, the NearLink identity and owner policy, native Rust
counterpart behavior, exact-profile cross-implementation exchanges, or a
complete exact-release lockfile, license, and advisory review. This is an
additional research lead only, not a selected or qualified candidate.

| Hard gate | `mls-rs` 0.56.0 revalidation | OpenMLS 0.9.0 | `ts-mls` v1.6.4 screen |
| --- | --- | --- | --- |
| Exact release and source | Tag `0.56.0`, commit `8f1b43f447a792ff9307f1c2c7f54da63914870e` | Tag `openmls-v0.9.0`, commit `3a3e35de3feeca8f6605143c464d5452ae584d43` | Stable tag `v1.6.4`, commit `ddff62aa15d3064fff5d77dda35b3cdf2970870d`; main is RC `2.0.0-rc.16` |
| MSRV and targets | Exact spike graph passes in Chromium 148 with Rust 1.91.0; Rust 1.84.1 fails before compilation on `zeroize_derive`; other named browsers and support with an updated lock or compatible product toolchain remain unverified | Rust 1.91.0; WASM target marked unsupported despite compile CI | Browser use advertised; exact stable release target matrix and required native counterpart remain unverified |
| Provider and persistence | WebCrypto experimental; no IndexedDB adapter or atomicity evidence | RustCrypto/native evidence only; sync storage API does not establish IndexedDB safety | Browser oriented; no NearLink-ready provider or atomic IndexedDB transaction evidence found |
| Dependencies, licensing, advisories | RustSec scan of 147 lock entries, including the local root crate, is clean as of 2026-10-16; CI scans without exceptions; active target graphs and license compatibility remain under review | Spike lock audit dated 2026-10-15 and still requires disposition | Exact v1.6.4 lock, licenses, and advisories not reviewed |
| Maintenance, audit, interoperability | Upstream CI exists; exact-profile cross-implementation result not established | Active upstream, but no resolution of target/MSRV/storage blockers | Official implementation inventory lists it; repo interop material is not proof for the NearLink profile |
| Full third-party security audit | Not completed; hard selection gate | Not completed; hard selection gate | Not completed; hard selection gate |

None of these rows is an overall pass. In particular, the core `mls-rs`
MSRV result and the existence of a browser-oriented TypeScript project do not
clear the provider, persistence, dependency, identity-policy,
interoperability, and independent-review gates. Keep all candidates
unselected. Before a later product integration decision, complete the exact
candidate scorecard and isolated feasibility work. Before any third-party
implementation audit, first freeze a reviewed implementation and its release
artifact as described in the [cryptography design review packet](cryptographic-review-packet.md#preconditions-before-a-third-party-implementation-audit).

Sources checked on 2026-10-16: [mls-rs 0.56.0 release](https://github.com/awslabs/mls-rs/releases/tag/0.56.0), [mls-rs 0.56.0 manifest](https://docs.rs/crate/mls-rs/0.56.0/source/Cargo.toml.orig), [mls-rs 0.56.0 README](https://github.com/awslabs/mls-rs/blob/0.56.0/mls-rs/README.md), [WebCrypto provider manifest](https://github.com/awslabs/mls-rs/blob/0.56.0/mls-rs-crypto-webcrypto/Cargo.toml), [mls-rs audit workflow](https://github.com/awslabs/mls-rs/actions/workflows/audit.yml), [mls-rs interop workflow](https://github.com/awslabs/mls-rs/blob/main/.github/workflows/interop_tests.yml), [MLS implementation inventory](https://github.com/mlswg/mls-implementations/blob/main/implementation_list.md), [ts-mls stable release](https://github.com/LukaJCB/ts-mls/releases/tag/v1.6.4), [ts-mls exact release commit](https://github.com/LukaJCB/ts-mls/commit/ddff62aa15d3064fff5d77dda35b3cdf2970870d), [ts-mls README](https://github.com/LukaJCB/ts-mls/tree/v1.6.4), and [ts-mls current package manifest](https://github.com/LukaJCB/ts-mls/blob/main/package.json).

## NL-61 isolated `mls-rs` compatibility spike, 2026-10-16

An isolated research crate now pins `mls-rs` 0.56.0, the WebCrypto provider
0.15.0, and the RustCrypto provider 0.22.1. It exercises the P-256 AES-128
suite in both a native RustCrypto run and headless Chromium using WebCrypto.
Both runs pass a two-member flow that creates and adds a member, processes a
Welcome, exchanges an application message, handles an Update proposal, reloads
memory-backed state, and processes removal. The removed member observes the
removal effect. This is browser feasibility evidence, not app identity or
authorization policy, cross-provider interoperability, durable storage, or
security approval.

Measured raw MLS objects range from 215 to 886 bytes in the native run and 215
to 892 bytes in Chromium for this two-member group and short body. The Add
Commit is 573 bytes native and 579 bytes in Chromium. These omit NearLink
envelopes and framing, larger groups, and maximum message bodies, so they do
not close the profile size or page budget gates. Rust 1.84.1 fails before
compilation on both targets because the locked `zeroize_derive` 1.5.0 manifest
requires Cargo's `edition2024` support. Rust 1.91.0 runs the compatibility
spike. The lock contains 147 entries including the local root crate; 146
registry package rows have declared license
expressions; compatibility review is still required. Active target graphs
include `zeroize_derive` through the selected crypto providers. No MLS
candidate is selected, and the external third-party security audit remains a
hard gate.

RustSec loaded 1,329 advisories and found no known advisory in the pinned
147-entry lock on 2026-10-16. The repository workflow now repeats this
scan without advisory exceptions. That full-lock scan is distinct from active
target graph review and from the external audit. The OpenMLS-only exceptions
remain scoped to the separate OpenMLS lockfile.

## Upstream and toolchain revalidation

Rechecked on 2026-10-14 against the official upstream repositories and their
GitHub API metadata. The default branch heads remain `mls-rs`
`d4c5b19f4bbf8a931face27fc9e30f2db33ce83e` and OpenMLS
`be2368a21ec5e0380abd568821addc57b79013ea`. The highest `mls-rs` Git tag
reported by the repository API is `0.56.0`, at
[`8f1b43f447a792ff9307f1c2c7f54da63914870e`](https://github.com/awslabs/mls-rs/tree/8f1b43f447a792ff9307f1c2c7f54da63914870e).
The latest OpenMLS GitHub release is `openmls-v0.9.0`, dated 2026-08-25; the
current main workspace also declares package version `0.9.0`.

The current `mls-rs` README still lists WebCrypto as experimental for cipher
suites 2, 5, and 7, with X.509 unsupported. It also says the library has not
received a full third-party security audit. The OpenMLS v0.9.0 README
classifies `wasm32-unknown-unknown` as unsupported, although CI builds that
target. Its `openmls-wasm` package is explicitly experimental and contains
unfinished paths. The v0.9.0 workspace manifest sets Rust 1.91.0 as its
minimum supported version. This repository pins Rust 1.84.1, so a compatibility
spike must use an explicit newer toolchain rather than change the product
toolchain. The repository-pinned Rust 1.84.1 toolchain has
`x86_64-unknown-linux-gnu` and `wasm32-unknown-unknown` installed. The spike's
Rust 1.91.0 toolchain now has both targets installed. Target installation does
not establish OpenMLS support or browser compatibility.

OpenMLS also uses a synchronous storage provider API. NearLink's browser
storage is asynchronous IndexedDB, so a browser integration would need a
carefully reviewed adapter that preserves atomic MLS state transitions. That
integration problem is not answered by a successful compile.

Decision: permit only a narrow, isolated, non-production OpenMLS v0.9.0
compatibility spike using Rust 1.91.0. It may check native MLS operations,
state reload, and whether the experimental WASM package can compile. At this
snapshot, the native group flow passed 1 test, and the WASM integration-test
target compiled after enabling the JavaScript entropy backend for the legacy
`getrandom` dependency. These checks do not execute tests in a browser or
establish supported browser behavior, browser-to-native interoperability,
production readiness, or a security claim. Do not add MLS to product flows or
treat the spike as a library selection. OpenMLS's documented WASM support
limits, experimental package, and storage mismatch remain selection blockers.
The `mls-rs` WebCrypto experimental status and lack of a full third-party
security audit also remain blockers. Defer integration until one candidate
passes the exact target, provider, interoperability, storage, and independent
review gates below.

A RustSec audit of this spike's complete lockfile on 2026-10-15 reported
`RUSTSEC-2026-0330` and `RUSTSEC-2026-0331` for `libcrux-kem` 0.0.9, plus an
informational unmaintained warning for `proc-macro-error2`. The two
`libcrux-kem` advisories describe panic-on-short-input behavior. Their patched
release is 0.0.10, but the locked optional `hpke-rs-libcrux` 0.7.0 package pins
`libcrux-kem` 0.0.9. `cargo tree --target all -i libcrux-kem@0.0.9` found no
active path for the spike's selected `OpenMlsRustCrypto` provider and tested
targets; RustSec still reports packages present in the full lockfile. The
`proc-macro-error2` warning is in the active selected graph through
`hax-lib-macros`, `libcrux-sha3`, and `hpke-rs`, which is used by
`openmls_rust_crypto`. The OpenMLS workflow still checks formatting, native
tests, and WASM compilation without rerunning RustSec, so its audit results are
a dated snapshot. The isolated `mls-rs` lockfile is scanned by RustSec in the
repository security workflow without advisory exceptions. That automated scan
covers the complete lockfile; target-specific active dependency graphs still
require separate review. Any lockfile or dependency feature-graph change
requires a fresh RustSec review of the complete lockfile and the active
selected graph, followed by independent review before candidate selection.
Keep OpenMLS unselected until that review and the other adoption gates are
satisfied. References: [RUSTSEC-2026-0330](https://rustsec.org/advisories/RUSTSEC-2026-0330),
[RUSTSEC-2026-0331](https://rustsec.org/advisories/RUSTSEC-2026-0331), and
[RUSTSEC-2026-0173](https://rustsec.org/advisories/RUSTSEC-2026-0173).

At this snapshot, the isolated spike manifest pins OpenMLS 0.9.0,
`openmls_rust_crypto` 0.6.0, `openmls_basic_credential` 0.6.0, and `tls_codec`
0.5.0, with Rust 1.91 as its minimum. Its native test source exercises a
two-member group using
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, including group creation,
KeyPackage addition, Welcome processing, application-message encryption and
decryption, member removal, and reload within the same in-memory provider. It
does not test a process restart or durable storage. This records the scope
present in the spike source. The native test passed, but reload remains within
the same in-memory provider rather than a process restart or durable store. The
WASM result covers compilation only. The reviewed spike files do not contain a
browser interoperability test, browser execution, or an IndexedDB storage
adapter.

Evidence links: [mls-rs repository and provider/security status](https://github.com/awslabs/mls-rs/tree/d4c5b19f4bbf8a931face27fc9e30f2db33ce83e),
[mls-rs 0.56.0 tag](https://github.com/awslabs/mls-rs/tree/0.56.0),
[OpenMLS v0.9.0 README](https://github.com/openmls/openmls/blob/openmls-v0.9.0/README.md),
[OpenMLS v0.9.0 workspace manifest](https://github.com/openmls/openmls/blob/openmls-v0.9.0/Cargo.toml),
[OpenMLS v0.9.0 WASM package](https://github.com/openmls/openmls/tree/openmls-v0.9.0/openmls-wasm),
and [OpenMLS 0.9.0 release](https://github.com/openmls/openmls/releases/tag/openmls-v0.9.0).

## Protocol direction

NearLink is evaluating the IETF Messaging Layer Security (MLS) protocol from
[RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) for one-to-one and
group conversations. A direct conversation can use an MLS group with two
members. MLS defines cryptographic group state and message protection. It does
not provide the application identity system, message delivery guarantees,
durable storage, or protection from a compromised endpoint.

The architecture must account for the Authentication Service (AS) and Delivery
Service (DS) roles described by
[RFC 9750](https://www.rfc-editor.org/rfc/rfc9750.html). The AS validates the
binding between an application identity and MLS credentials. MLS deployments
normally trust the AS to make that binding correctly. The DS distributes
initial key material and routes group messages. A DS can still observe routing
metadata and disrupt availability, even where message contents remain
confidential.

MLS protocol support alone does not authenticate a person. NearLink must bind
device credentials to an application identity and provide an out-of-band
verification flow. Room codes remain routing hints. They do not establish
identity or group authorization.

## Candidate library selection

`mls-rs` is a candidate for an interoperability spike. Its maintainers document
RFC 9420 support, WebAssembly builds, a WebCrypto provider, native providers,
and Apache-2.0 or MIT licensing. The WebCrypto provider is listed as
experimental in the upstream
[provider support table at the reviewed revision](https://github.com/awslabs/mls-rs/blob/d4c5b19f4bbf8a931face27fc9e30f2db33ce83e/mls-rs/README.md#crypto-providers).
Treat browser suitability as unverified until the exact version, provider,
target browsers, and cipher suite pass the spike.

OpenMLS v0.9.0 is also under evaluation, but its WASM target is documented as
unsupported and its WASM package is experimental. The release requires Rust
1.91.0, above this repository's pinned Rust 1.84.1. A spike may establish
limited compatibility evidence; it cannot waive these support limits. See the
[v0.9.0 README](https://github.com/openmls/openmls/blob/openmls-v0.9.0/README.md),
[manifest](https://github.com/openmls/openmls/blob/openmls-v0.9.0/Cargo.toml),
and [WASM package](https://github.com/openmls/openmls/tree/openmls-v0.9.0/openmls-wasm).

The following scorecard is a hard-gate checklist, not an averaged score. Each
candidate must have evidence for every row at an exact release version and
source revision. A missing or unknown result is a failure for selection, not a
presumed pass.

| Selection criterion | Evidence required to pass |
| --- | --- |
| Protocol and interoperability | Exact version implements the required RFC 9420 behavior, passes relevant upstream vectors, and exchanges messages with an independent implementation using the proposed profile. |
| Browser and native targets | The same supported cipher suite and credential profile work in the intended browser WASM target and each named native target. No experimental provider is accepted without a written risk decision and independent review. |
| Cryptographic provider | Provider algorithms, randomness source, key handling, and platform support are documented for the exact version. No debug feature may expose secrets in release builds. |
| State and storage | APIs permit application-controlled persistence with atomic state transitions, safe reload, and documented handling of messages and commits received more than once or out of order. |
| Maintenance and security | Release history, maintainers, security reporting process, known advisories, and dependency tree have been reviewed. No unresolved critical or high severity issue may affect the selected code path. |
| Licensing and distribution | Exact transitive dependency licenses are compatible with NearLink distribution and recorded in the dependency inventory. |
| Integration fit | The library can be used without a custom cryptographic protocol or an always-on cloud service, and its API can support the credential and delivery design below. |

Selection rule: select a candidate only after every row passes, the exact
version and source revision are pinned, the chosen cipher suite is recorded,
and an independent reviewer approves the evidence. If both candidates fail,
defer MLS implementation and evaluate other established protocols. Do not
weaken a row to make a candidate pass.

## Proposed identity verification behavior

The QR flow is a proposal and must be reviewed with the credential profile
before implementation. The candidate-neutral [initial MLS deployment profile
and decision register](initial-mls-deployment-profile.md) proposes exact OOB
comparison of device identity and the exact KeyPackage reference used for
admission. It verifies a device credential key against the identity binding
displayed by the app. It does not prove a civil identity or that a human
controls a device.

The proposed identity-verification QR contains a format version, the canonical
encoding of the application identity-to-device credential binding, the
credential type, and the MLS credential public authentication key. It contains
no private key, group secret, message key, or one-time KeyPackage. It is
separate from the invitation QR, which carries the invitee's public one-use
KeyPackage and reference as described in the
[identity and authorization profile](identity-and-authorization-profile.md).
The displayed fingerprint is the full SHA-256 digest of the domain-separated
identity-verification payload:
`SHA-256("NearLink MLS credential fingerprint v1" || canonical_payload)`.
The profile recommends assessing RFC 8785 JSON Canonicalization Scheme for
application-owned binding data, but does not freeze that encoding. The
canonical encoding and trust root for the identity binding must be selected
and independently reviewed before this format is frozen. RFC 8785 does not
replace MLS serialization or establish identity.
Users compare by scanning a peer's QR in person or by comparing the complete
fingerprint through another trusted channel. A shortened fingerprint may be
used for display only if the full value remains available for comparison.

The interface must distinguish these states:

- **Unverified device:** the credential has not been compared out of band. The
  UI must say that the displayed identity is not verified and may be spoofed.
- **Verified device:** the credential fingerprint matches the value compared
  out of band. The UI may say “Verified device” and must not imply a verified
  real-world person.
- **Changed credential:** the binding or public authentication key differs
  from the verified value. Clear the verified state, show a prominent change
  notice, and require a fresh comparison. Do not silently accept the change.
- **Invalid credential:** credential validation or identity-binding checks
  fail. Do not allow the peer to be treated as verified or silently fall back
  to an unverified state.

Room codes and display names must never be presented as evidence of identity.
Key rotation, multiple devices, recovery, revocation, and loss of verification
state need defined behavior before a production identity claim.

## Threat assumptions and limits

The security design must use the blueprint's threat model and explicitly
consider:

- A malicious participant on the same Wi-Fi network who can observe, inject,
  replay, delay, reorder, or drop network traffic.
- A rogue or compromised local hub acting as the DS. It must not learn message
  plaintext from correctly protected MLS application messages, but it can
  observe metadata and can refuse delivery or interfere with availability.
- A compromised or dishonest AS, which may issue or validate a false identity
  binding. Users must have a verification method that does not rely solely on
  that service.
- Identity spoofing, unauthorized group additions, credential expiry and
  revocation, replay, conflicting group changes, and malicious group members.
- Browser storage eviction, user-cleared data, interrupted writes, device loss,
  and local state corruption. MLS encryption does not provide durable storage
  or identity recovery.
- Compromised endpoints, including malicious application code, browser
  extensions with access, malware, and a user with access to an unlocked
  device. MLS cannot protect plaintext after an endpoint decrypts it.
- Malformed or oversized MLS framing, handshake, Welcome, and application
  inputs, plus resource exhaustion from repeated parsing, group operations, or
  state growth. Inputs need explicit size, work, and state limits before
  parsing or persistence.
- Denial of service, message suppression, traffic analysis, and metadata
  exposure. MLS does not guarantee availability or hide all routing and timing
  metadata.

The initial MLS design assumes endpoint software and cryptographic randomness
are not compromised. The trust model for AS behavior, device identity, and
credential revocation is not yet selected. A malicious authenticated group
member can disclose messages they can read, and NearLink cannot prevent
recipients from copying or photographing plaintext. These cases must be
documented as limits, not described as solved by MLS.

## Delivery and partition model

The proposed initial topology is one optional local hub for hub delivery and
direct peer delivery for exactly two-member groups. This is a candidate-neutral
design baseline, not a library selection or validated feasibility result. The
profile and its decision register are in
[initial-mls-deployment-profile.md](initial-mls-deployment-profile.md). Future
topologies require a reviewed profile revision. The baseline includes:

1. An optional local hub performing DS functions for devices on the same LAN.
2. Direct peer-to-peer delivery for a two-member conversation, with the
   connected peers providing the message exchange needed by MLS.
3. Any future multi-device or offline store-and-forward arrangement, which
   must not require a remote cloud service for core local communication.

The initial profile has no centralized AS. Clients validate credential
bindings and exact out-of-band comparisons. The local hub is only a DS. RFC
9750 describes strongly consistent and eventually consistent DS approaches.
An implementation must prove its ordering policy and test catch-up behavior;
MLS itself does not provide one global delivery order.

During a network partition, delivery and group state progress may pause. The
design must define how clients detect a missing or conflicting Commit, avoid
silently accepting divergent group state, and recover after reconnection. It
must also state whether membership changes are blocked until participants
reconcile. No exactly-once, durable, or eventual-delivery guarantee is made by
this candidate note. The selected policy must preserve local operation without
making cloud connectivity mandatory.

## Implementation and release gates

### Before selecting a dependency

1. Complete the scorecard above for each considered candidate and cite the
   exact release tag, commit, provider, target, and license evidence.
2. Build a narrow browser-to-native interoperability spike with one proposed
   cipher suite. Exercise group creation, member addition, Welcome processing,
   application messages, restart and state reload, and member removal.
3. Record the candidate decision, unresolved risks, target support, and the
   reviewers who approved selection. Do not claim that this spike establishes
   production security.

### Before integrating into the product

1. Specify identity binding, QR verification, credential lifetime and
   revocation, device removal, group authorization, and the trust assumptions
   for AS behavior.
2. Specify the DS topology and the consistency, partition recovery, metadata,
   and offline behavior for local hub and direct peer-to-peer paths.
3. Confirm that browser and native implementations use the same credential
   format, cipher suite, serialization, and state transition rules.
4. Design atomic persistence of MLS group state and test crash recovery,
   duplicated messages, reordered or conflicting commits, stale credentials,
   invalid Welcome messages, storage loss, and migration failure.
5. Review endpoint key storage, application update risks, logging, diagnostics,
   plaintext lifetime, and secret deletion behavior on supported platforms.

### Before a public secure messaging claim

1. Complete independent security review of the integration, identity model,
   delivery behavior, storage transitions, and threat model. Resolve all
   critical findings and document accepted residual risks.
2. Obtain a third-party audit of the shipped cryptographic integration and
   release configuration. Publish the audit scope and material limitations.
3. Verify the release build uses the reviewed pinned versions and has no
   development options that expose secrets.
4. Ensure the product explains identity verification status, metadata
   exposure, endpoint compromise limits, availability limits, and recovery
   behavior in clear user-facing language.

Until these gates are met, NearLink must continue to describe the current
WebSocket messages as plaintext and unsuitable for sensitive communication.
Selecting or integrating MLS alone does not complete the blueprint's security
requirements or justify a secure public messaging claim.
