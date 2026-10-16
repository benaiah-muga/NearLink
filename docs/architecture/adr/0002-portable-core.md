# ADR 0002: Portable communication core

- Status: Accepted for implementation direction
- Date: 2026-10-14

## Context

NearLink targets browser and future native clients and requires consistent protocol behavior across platforms. Reimplementing protocol state independently in each UI risks incompatible behavior. The Rust core validates protocol v1 JSON structure and provides bounded in-memory message reconciliation. Its WebAssembly facade is used by the browser for packet validation, inventory sequencing, and inbound acceptance classification. Rust/WASM also owns the browser exchange's bounded inventory sequence, frozen missing-ID plan and batching, per-peer request replay and conflict checks, requested-message matching, staged completion correlation and validation, and coverage outcome aggregation across active peer plans. TypeScript keeps WASM handles and peer scheduling/async continuation. It coordinates bounded IndexedDB reads and durable acceptance, validates loaded durable rows, and asks Rust/WASM to compare exact IDs and packets against tracked state. TypeScript presents partial/final status and coordinates tombstones, writes, display order, transaction commit, transport I/O, timers, and rate budgets. IndexedDB remains the browser's persistent source of truth. Rust synchronization state is ephemeral and is not a persistent exchange journal.

## Options considered

1. Keep all domain behavior in each client language.
2. Move portable protocol, synchronization, and cryptographic state into a Rust core with narrow platform adapters.
3. Put networking and presentation into one cross-platform framework.

## Decision

Use a small Rust core for platform-neutral protocol processing and bounded synchronization state, with future message and cryptographic behavior added only after concrete requirements and review. Keep storage, UI, permissions, rate budgets, and transport I/O behind explicit adapters. Expose the core to the web client through a narrow WebAssembly interface after dependency target support and bundle size are verified.

The Rust validator, bounded in-memory reconciliation primitive, browser synchronization state wrappers, and inbound acceptance classifier are incremental portability slices, not a complete portable messaging core. In the browser, Rust/WASM owns bounded inventory sequence acceptance, the frozen missing-ID plan and request batching, request replay and conflicts, requested-message matching, completion staging, correlation, subset validation, commit/abort state, and sticky coverage aggregation across active peer inventories and request plans. It also selects missing IDs against accepted-ID snapshots in bounded chunks and compares inbound packets without transport assumptions. IndexedDB supplies at most 4,096 ordered accepted IDs from one bounded primary-key cursor snapshot and at most 100 requested message rows from keyed reads. A truncated ID snapshot marks the exchange partial. The classifier takes expected room, tombstone state, candidate packet, and optional saved packet as inputs. It does not read or write storage. TypeScript keeps WASM object handles and peer scheduling/async continuation while performing bounded IndexedDB reads and durable message acceptance. It loads and validates durable rows, then asks Rust/WASM to compare exact IDs and packets against tracked state. Rust/WASM reports the aggregate coverage outcome; TypeScript presents that status and handles tombstones, keyed message lookup, writes, display order, transaction commit, transport interaction, timers, and rate budgets. The Rust state is in-memory and ephemeral. Reconnect starts a fresh exchange from persisted accepted message IDs. No native application currently integrates the core.

## Rationale

Rust provides strong data modeling and can target native platforms and WebAssembly. Narrow adapters preserve browser and native platform capabilities without putting platform APIs in the core.

## Trade-offs

- Cross-language builds and generated bindings increase development complexity.
- WebAssembly target support must be verified for every selected dependency.
- A portable core does not remove differences in browser storage, background lifecycle, or native networking.

## Consequences

- Future core behavior changes require Rust unit tests and browser/native interoperability tests.
- The Rust crate validates messages, maintains bounded in-memory synchronization state, can produce bounded in-memory missing-message pages, and classifies inbound acceptance. Shared fixtures exercise the classifier and sync state in native Rust, the WASM facade, and browser WASM tests. During inbound and hub-history transactions, the browser reads tombstones and rows and performs the synchronous WASM decision while the transaction is active, then persists according to its storage policy. Sync reads use a bounded accepted-ID snapshot and keyed reads for requested rows, not a materialized room message array. The `MessageIndex` and synchronization state are not persistent browser storage. Native application integration remains unverified, and no native app exists in the repository.
- No unsafe Rust is expected in the portable core without a documented exception.
- Platform-specific features remain outside the core.
