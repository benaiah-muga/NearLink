# `mls-rs` 0.56.0 compatibility spike

Status: isolated research only. This crate is not part of the product, does
not select an MLS implementation, and does not establish that MLS is ready for
NearLink. It makes no product security or end-to-end encryption claim.

## Pinned candidate

| Item | Pin or evidence |
| --- | --- |
| Upstream source | `mls-rs` tag `0.56.0`, commit `8f1b43f447a792ff9307f1c2c7f54da63914870e` |
| Source archive | Tarball from `https://codeload.github.com/awslabs/mls-rs/tar.gz/refs/tags/0.56.0`; SHA-256 `46ccc4c7f1a688052ba8650ce99876da4833ef42230995be3bac1ee821ce5753` |
| MLS crate | `mls-rs = 0.56.0`, exact version in `Cargo.toml` and `Cargo.lock` |
| Browser provider | `mls-rs-crypto-webcrypto = 0.15.0`, exact version in `Cargo.toml` and `Cargo.lock` |
| Host provider | `mls-rs-crypto-rustcrypto = 0.22.1`, exact version in `Cargo.toml` and `Cargo.lock` |
| Tested suite | MLS cipher suite 2, `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` |
| Product Rust pin | 1.84.1 |

The WebCrypto provider exposes P-256, P-384, and P-521 suites. Upstream labels
the WebCrypto provider experimental and says the implementation has not
received a full third-party security audit. The native RustCrypto provider is
also experimental. This spike does not change NearLink's candidate-neutral
profile or accept experimental provider risk.

## Results

| Target | Runtime and provider | Result |
| --- | --- | --- |
| `x86_64-unknown-linux-gnu` | Rust 1.91.0, RustCrypto, suite 2 | Group flow passed 1/1 |
| `wasm32-unknown-unknown` in Chromium 148.0.7778.215 | Rust 1.91.0, WebCrypto, suite 2 | Group flow passed 1/1 in headless Chromium |
| `x86_64-unknown-linux-gnu` with Rust 1.84.1 | Product-pinned Cargo and candidate lock | Blocked before compilation: `zeroize_derive` 1.5.0 requires Cargo's `edition2024` feature, which Cargo 1.84.1 does not support |
| `wasm32-unknown-unknown` with Rust 1.84.1 | Product-pinned Cargo and candidate lock | Same dependency manifest failure before compilation |

The passing group flow creates an owner group, generates and adds a KeyPackage,
measures the serialized Add Commit and processes the Welcome, exchanges an
application message, receives a member Update proposal, commits it, writes and
reloads group state through the in-memory provider, then removes the member. Reload occurs in the same process
with memory storage. It is not a restart, crash, or durable-storage test.

The raw encoded MLS objects measured in the successful runs were:

| Object | Host native bytes | Chromium WebCrypto bytes |
| --- | ---: | ---: |
| KeyPackage | 387 | 393 |
| Add Commit | 573 | 579 |
| Welcome | 886 | 892 |
| Application message | 215 | 215 |
| Member Update proposal | 378 | 382 |
| Remove Commit | 418 | 421 |

These raw object sizes are below the proposed 18 KiB measured envelope target.
The measurements cover a two-member group and a short message body. They do not
include a NearLink envelope, transport framing, multiple envelopes, or a 16-member group. They do
not validate maximum-body, envelope, or proposed page budgets.

The harness uses test credentials and does not prove NearLink's credential
binding, reciprocal out-of-band fingerprint checks, exact KeyPackage
confirmation, owner-only authorization before state mutation, group owner
succession, or member Update identity-to-leaf policy. The MLS library does not
provide NearLink's application owner policy. Those remain design and
implementation gates.

## Dependencies and audit

`Cargo.lock` pins the complete research dependency graph. `licenses.csv`
records manifest-declared license expressions for all resolved registry
packages. It is an inventory, not a legal compatibility decision. Repository
CI scans the full lockfile with RustSec; target-specific active graphs still
need review before any candidate decision. This isolated dependency graph must never be added to
product manifests without a separate reviewed decision.

## Reproduction

Use Rust 1.91.0 for this research run. `mls_build_async` is required by the
upstream browser and async test configuration.

```sh
RUSTFLAGS="--cfg mls_build_async" cargo +1.91.0 test --locked --test group_flow -- --nocapture

PATH="/path/to/matching/wasm-bindgen-tools:/path/to/chromedriver:$PATH" \
RUSTFLAGS="--cfg mls_build_async" \
WASM_BINDGEN_TEST_TIMEOUT=300 \
CHROME=/path/to/chrome \
cargo +1.91.0 test --locked --target wasm32-unknown-unknown --test group_flow -- --nocapture
```

The WASM runner and `wasm-bindgen` binary must match the locked `wasm-bindgen`
crate version. ChromeDriver must match the selected Chrome build. The repository
CI audits this lockfile without the OpenMLS-only advisory exceptions.
No native or browser result in this spike is a third-party audit, independent
implementation interop test, storage assurance, platform support statement,
or security release approval.
