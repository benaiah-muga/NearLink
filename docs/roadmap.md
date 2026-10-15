# NearLink roadmap

This roadmap groups the project blueprint outcomes into phases and links each
phase to repository evidence and its next concrete outcome. It has no delivery
dates. Automated checks establish only the paths they exercise. Physical
devices, external security review, and field use require separate evidence.

## Current position

NearLink is an early local-first browser messaging prototype. It has an
optional local WebSocket hub with bounded plaintext history, a manually
signaled direct WebRTC path, and bounded message synchronization. It does not
have reviewed application-level end-to-end encryption, durable cryptographic
identity, emergency-grade reliability, or a release approved for controlled
beta use.

## Blueprint phases and outcomes

| Blueprint phase | Current evidence | Next outcome | Open gates |
| --- | --- | --- | --- |
| Browser and local hub foundation | The browser client, optional FastAPI hub, local IndexedDB persistence, bounded hub history, reconnect handling, and local browser journeys are implemented. CI runs build and automated unit, hub, and browser checks. See [verification](engineering/verification.md), [beta evidence](product-beta.md), and the [hub operating notes](../services/local-hub/README.md). | Complete a dated candidate record with real-device browser and hub checks before treating the prototype as a beta candidate. | Physical two-device local network exchange, supported browser and operating system matrix, installation and device acceptance, controlled beta criteria, and operator recovery evidence remain pending. |
| Portable protocol and synchronization | Shared TypeScript validation and Rust protocol core are in use; Rust/WASM is exercised by browser vectors. The browser uses bounded inventories, history pages, and restartable synchronization over the hub and confirmed direct sessions. NL-56 adds deterministic generated reconciliation invariants. See the [protocol draft](protocol/v1-draft.md), [synchronization draft](protocol/synchronization-v1-draft.md), and [portable core decision](architecture/adr/0002-portable-core.md). | Define and verify the next storage and lifecycle boundary before claiming cross-device completeness or durable Rust synchronization. | The portable reconciliation primitive is in-memory. Persistent Rust messaging and synchronization integration, physical device evidence, and cross-device completeness remain open. |
| Security, identity, and privacy | Threat modeling and candidate MLS, identity, and authorization designs are documented. The current hub path is plaintext; the direct fingerprint comparison identifies a session certificate only. See the [threat model](security/threat-model.md), [identity profile](security/identity-and-authorization-profile.md), and [MLS architecture](security/mls-architecture.md). | Complete the approved protocol and identity design gates, implementation review, and independent third-party security review before integrating security claims into product behavior. | Application-level E2EE, durable identity, group authorization, secure media or file transfer, implementation integration, third-party security audit, and any resulting public security claim remain pending. |
| Browser compatibility and controlled beta | Production browser journeys cover Chromium and selected Firefox/WebKit paths in CI, same-host hub and direct flows, service-worker recovery, and a packaged web archive smoke. These are automated checks, not physical-device acceptance. See [beta status](product-beta.md) and the [release checklist](release/README.md). | Complete a candidate record with exact artifact, browser and device matrix, named reviewers, known limits, feedback handling, and withdrawal instructions. | Two-device acceptance, manual accessibility and operator review, full compatibility evidence, and controlled beta authorization remain pending. No controlled beta is approved by this roadmap. |
| Native clients and platform adapters | Readiness constraints and adapter boundaries are recorded in [native readiness](platform/native-readiness.md). Browser and portable Rust code provide groundwork, not a native application. | Select a native platform approach only after the shared protocol, persistence, identity, and adapter boundaries are ready for review. | Native desktop and Android adapters, builds, installation, lifecycle behavior, and device validation are not implemented or verified. |
| Mesh networking and field reliability | A deterministic mesh simulator and its limits are documented in [mesh simulation](networking/mesh-simulation.md). Simulation evidence does not establish field behavior. | Define an operational field test plan with safety boundaries, representative devices, measurable recovery and resource limits, and a way to retain reproducible results. | Field validation of partitions, adversarial routing, storage limits, battery use, background lifecycle, and latency is pending. Emergency-grade reliability evidence is also pending. |

## How status changes

Mark a roadmap outcome complete only when a reviewable record links the exact
implementation or design, relevant check results, and independent review where
required. Keep external work pending until its evidence is recorded. Do not
infer device support from browser automation, release readiness from a build,
or security and reliability properties from design documents or dependency
scans.

The [governance policy](../GOVERNANCE.md) describes decision and release
authority. The [release checklist](release/README.md) defines the candidate
record and acceptance evidence.
