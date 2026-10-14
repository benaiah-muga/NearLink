# ADR 0002: Portable communication core

- Status: Accepted for implementation direction
- Date: 2026-10-14

## Context

NearLink targets browser and native clients and requires consistent protocol behavior across platforms. Reimplementing protocol state independently in each UI risks incompatible behavior. The web application and its protocol rules are currently implemented in TypeScript. A small Rust crate now validates protocol v1 JSON structure against shared vectors, but it has no browser binding and does not yet implement message state transitions, synchronization, storage, or cryptography.

## Options considered

1. Keep all domain behavior in each client language.
2. Move portable protocol, synchronization, and cryptographic state into a Rust core with narrow platform adapters.
3. Put networking and presentation into one cross-platform framework.

## Decision

Use a small Rust core for platform-neutral protocol processing, message state transitions, synchronization, and cryptographic integration. Keep storage, UI, permissions, and transport I/O behind explicit adapters. Expose the core to the web client through a narrow WebAssembly interface only after dependency target support and bundle size are verified.

The Rust validator is a first portability slice, not a portable messaging core. The TypeScript implementation remains the product path until the Rust core has concrete behavior parity and interoperability tests.

## Rationale

Rust provides strong data modeling and can target native platforms and WebAssembly. Narrow adapters preserve browser and native platform capabilities without putting platform APIs in the core.

## Trade-offs

- Cross-language builds and generated bindings increase development complexity.
- WebAssembly target support must be verified for every selected dependency.
- A portable core does not remove differences in browser storage, background lifecycle, or native networking.

## Consequences

- Future core behavior changes require Rust unit tests and browser/native interoperability tests.
- The Rust crate is tested on the native Linux target and CI cross-compiles it for WebAssembly. It still has no JavaScript binding or browser runtime test. Native application integration remains unverified.
- No unsafe Rust is expected in the portable core without a documented exception.
- Platform-specific features remain outside the core.
