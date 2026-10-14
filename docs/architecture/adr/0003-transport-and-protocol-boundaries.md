# ADR 0003: Transport-independent messaging protocol

- Status: Accepted
- Date: 2026-10-14

## Context

The initial web client uses a WebSocket relay. The MVP also calls for direct WebRTC communication. Messages must remain understandable and testable regardless of the selected path.

## Options considered

1. Put a separate message model in every transport.
2. Define one versioned application envelope and adapt each transport at the boundary.

## Decision

Use a versioned protocol envelope for identity, conversation, message identifiers, payload type, timestamps, and delivery events. WebSocket and WebRTC adapters transport opaque validated envelopes. Transport connection state and transport-level acknowledgments are not equivalent to recipient delivery or read state.

## Rationale

One envelope allows message logic, persistence, deduplication, and synchronization to be tested independently of network details.

## Trade-offs

- Version negotiation and compatibility rules require maintenance.
- An envelope must not expose plaintext or metadata beyond what the selected security design permits.

## Consequences

- Protocol revisions require compatibility tests and documented migration behavior.
- Application delivery receipts must represent durable recipient acceptance, not merely successful socket writes.
