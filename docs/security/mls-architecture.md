# MLS implementation investigation

Status: implementation candidate, not approved for a security claim

Research snapshot: 2026-10-14. Repository support statements below were checked
against `mls-rs` commit `d4c5b19f4bbf8a931face27fc9e30f2db33ce83e` and OpenMLS
commit `be2368a21ec5e0380abd568821addc57b79013ea`. No MLS dependency or version
has been selected.

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

OpenMLS is an alternate candidate. Its upstream README currently lists
`wasm32-unknown-unknown` as built in CI but unsupported, and its WASM package is
an experiment. Recheck that status before relying on it. See
[OpenMLS](https://github.com/openmls/openmls) and its
[WASM package](https://github.com/openmls/openmls/tree/main/openmls-wasm).

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
before implementation. It verifies a device credential key against the
identity binding displayed by the app. It does not prove a civil identity or
that a human controls a device.

The proposed QR payload contains a format version, the canonical encoding of
the application identity-to-device credential binding, the credential type,
and the MLS credential public authentication key. It contains no private key,
group secret, message key, or one-time KeyPackage. The displayed fingerprint
is the full SHA-256 digest of the domain-separated canonical payload:
`SHA-256("NearLink MLS credential fingerprint v1" || canonical_payload)`.
The canonical encoding and trust root for the identity binding must be fixed in
the selected profile and independently reviewed before this format is frozen.
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

The delivery topology is an open architecture decision. NearLink must compare
at least these deployment shapes:

1. An optional local hub performing DS functions for devices on the same LAN.
2. Direct peer-to-peer delivery for a two-member conversation, with the
   connected peers providing the message exchange needed by MLS.
3. Any future multi-device or offline store-and-forward arrangement, which
   must not require a remote cloud service for core local communication.

For each shape, document where AS functions and initial KeyPackages live, what
the DS can observe, how clients order Commit messages, and how a returning
client catches up. RFC 9750 describes strongly consistent and eventually
consistent DS approaches. The implementation must choose and test a compatible
policy rather than assuming MLS itself provides one global delivery order.

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
