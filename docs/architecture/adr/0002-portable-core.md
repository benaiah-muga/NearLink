# ADR 0002: Portable communication core

- Status: Accepted for implementation direction
- Date: 2026-10-14

## Context

NearLink targets browser and future native clients and requires consistent protocol behavior across platforms. Reimplementing protocol state independently in each UI risks incompatible behavior. The Rust core validates protocol v1 JSON structure and provides bounded in-memory message reconciliation. Its WebAssembly facade is used by the browser for packet validation and inventory sequence acceptance. Rust/WASM also validates and tracks bounded request/completion relationships. TypeScript retains pending-request maps and coordinates IndexedDB access, accepted-message snapshots, transport I/O, persistence checks, rate budgets, and UI state. The Rust message index is in-memory and is not the browser's persistent source of truth.

## Options considered

1. Keep all domain behavior in each client language.
2. Move portable protocol, synchronization, and cryptographic state into a Rust core with narrow platform adapters.
3. Put networking and presentation into one cross-platform framework.

## Decision

Use a small Rust core for platform-neutral protocol processing and bounded synchronization state, with future message and cryptographic behavior added only after concrete requirements and review. Keep storage, UI, permissions, rate budgets, and transport I/O behind explicit adapters. Expose the core to the web client through a narrow WebAssembly interface after dependency target support and bundle size are verified.

The Rust validator, bounded in-memory reconciliation primitive, and browser synchronization state wrappers are incremental portability slices, not a complete portable messaging core. The browser uses Rust/WASM for bounded inventory sequencing, request/completion validation, missing-ID selection against the full local snapshot in bounded chunks, and bounded request planning. TypeScript retains app-side pending-request bookkeeping and remains responsible for persistent message snapshots, message storage, transport interaction, persistence verification, rate budgets, and presentation. No native application currently integrates the core.

## Rationale

Rust provides strong data modeling and can target native platforms and WebAssembly. Narrow adapters preserve browser and native platform capabilities without putting platform APIs in the core.

## Trade-offs

- Cross-language builds and generated bindings increase development complexity.
- WebAssembly target support must be verified for every selected dependency.
- A portable core does not remove differences in browser storage, background lifecycle, or native networking.

## Consequences

- Future core behavior changes require Rust unit tests and browser/native interoperability tests.
- The Rust crate validates messages, maintains bounded in-memory synchronization state, and can produce bounded in-memory missing-message pages. Its JavaScript facade is exercised in browser tests. The `MessageIndex` is not persistent browser storage. Native application integration remains unverified, and no native app exists in the repository.
- No unsafe Rust is expected in the portable core without a documented exception.
- Platform-specific features remain outside the core.
