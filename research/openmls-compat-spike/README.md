# OpenMLS compatibility spike

Status: experimental research only. This crate is isolated from NearLink application and protocol code. It is not approved security design, a production implementation, or an audited integration. Nothing in this spike changes NearLink security claims.

## Pinned upstream

This experiment uses OpenMLS 0.9.0 and matching 0.6.0 support crates from the exact upstream `openmls-v0.9.0` Git tag at commit `3a3e35de3feeca8f6605143c464d5452ae584d43`. Cargo.lock records that tag and commit for all OpenMLS workspace crates. OpenMLS 0.9.0 declares Rust 1.91 as its minimum supported version. The repository's product toolchain remains pinned to Rust 1.84.1. Run this crate with an explicit Rust 1.91.0 toolchain:

```sh
cargo +1.91.0 test --manifest-path research/openmls-compat-spike/Cargo.toml --locked
```

The compile-only WASM check for the integration test and dependency graph is:

```sh
cargo +1.91.0 check --manifest-path research/openmls-compat-spike/Cargo.toml --locked --tests --target wasm32-unknown-unknown
```

The crate has its own Cargo workspace and lockfile so its dependency graph does not join the product workspace.

## Demonstrated flow

`tests/native_flow.rs` exercises an in-process native flow with two independent OpenMLS providers:

1. Generate signing credentials and a Bob KeyPackage.
2. Create an MLS group, add Bob, serialize and parse the Welcome, then join Bob using the exported ratchet tree.
3. Encrypt an application payload as Alice, serialize and parse the MLS message, and decrypt it as Bob.
4. Remove Bob with an MLS Commit, merge it on both sides, and confirm the removed client becomes inactive and cannot create a new application message.
5. Reload Alice's group from the same provider's memory storage and verify the membership and epoch.

The reload check only covers the provider's in-memory storage within one process. It does not demonstrate durable storage or restart recovery.

## Limits and follow-up required

- This uses the OpenMLS RustCrypto provider and basic credentials for a compatibility exercise. No NearLink identity, authentication, authorization, trust-on-first-use, or credential verification policy is defined.
- The test passes serialized messages directly between test participants. There is no transport, offline queue, retry policy, delivery service, multi-device synchronization, or group lifecycle protocol.
- No durable storage, backup, migration, key rotation policy, key deletion audit, or device compromise recovery is implemented.
- A compile-only check of the integration test and dependency graph passed for `wasm32-unknown-unknown` with Rust 1.91.0 after enabling `getrandom` 0.2 JavaScript entropy on that target. The compile initially failed because the RustCrypto provider dependency graph uses `getrandom` 0.2 without the JavaScript backend; the target-specific feature unification is recorded in this crate. This does not execute tests in a browser, establish supported browser behavior, or review the provider for browser use.
- No application-layer integration, UI, media encryption, attachment transfer, or backward-compatible wire protocol is included.
- No independent cryptographic or protocol security review has been performed. Do not describe this spike as production-ready, end-to-end encrypted NearLink, or emergency-grade reliable.

## Dependency review

The OpenMLS packages are pinned to the exact `openmls-v0.9.0` Git tag in `Cargo.toml`, and the resolved transitive graph is recorded in `Cargo.lock`. Cargo metadata resolved 198 packages, each with a declared license expression after this private spike crate inherited the repository MIT license. No dedicated license policy checker or RustSec audit command is installed in the environment, so this is license metadata inventory only and no advisory status is claimed. Before any product adoption, review the complete resolved dependency graph, license policy, advisories, browser target behavior, storage semantics, protocol threat model, operational design, and independent security assessment. This research spike is not an approval for adding these dependencies to product flows.
