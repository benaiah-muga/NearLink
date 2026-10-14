# ADR 0001: Initial platform choices

Status: Accepted

## Context

The first development cycle needs a small, runnable browser client and an optional local hub, while preserving clear boundaries for future protocol and platform work.

## Decision

Use React, TypeScript, and Vite for the browser client. Use FastAPI and WebSockets for the initial local hub. Keep the message envelope documented independently of either implementation. Defer Rust/WASM integration until message and synchronization requirements have a concrete, reviewed protocol.

## Consequences

The stack supports fast iteration across browser and local service code. The first hub relays messages and therefore cannot provide end-to-end confidentiality. A later Rust core can replace domain logic incrementally behind stable interfaces.
