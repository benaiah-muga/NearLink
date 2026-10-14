import { describe, expect, it } from "vitest";
import { buildDiagnosticsSummary, formatDiagnosticsSummary } from "./diagnostics";

describe("privacy-safe diagnostics summaries", () => {
  it("contains only allowlisted states and counts, never private support data", () => {
    const sensitiveValues = [
      "private-room-code-9f2a",
      "Private Call Sign",
      "sender-secret-identifier",
      "wss://private-hub.example:8123/ws?token=secret",
      '{"type":"offer","sdp":"private-sdp-value"}',
      "sha-256 AA:BB:CC:DD private-fingerprint",
      "A private message body that must not be copied",
      "raw error with private stack and token=secret",
    ];
    const summary = buildDiagnosticsSummary({
      hubState: "retrying",
      directState: "connected",
      protocolState: "ready",
      storageState: "granted",
      conversationReady: true,
      messageCounts: { total: 3, queued: 1, sent: 1, failed: 1 },
    });
    const serialized = formatDiagnosticsSummary(summary);

    expect(serialized).toContain("Hub: retrying");
    expect(serialized).toContain("Direct peer: connected");
    expect(serialized).toContain("Messages: 3");
    for (const value of sensitiveValues) expect(serialized).not.toContain(value);
    expect(Object.keys(summary)).toEqual(["hub", "direct", "protocol", "storage", "conversation"]);
  });

  it("marks counts unavailable when the conversation is not ready", () => {
    const summary = buildDiagnosticsSummary({
      hubState: "offline",
      directState: "closed",
      protocolState: "loading",
      storageState: "checking",
      conversationReady: false,
      messageCounts: { total: 4, queued: 2, sent: 2, failed: 0 },
    });

    expect(summary.conversation).toEqual({ state: "loading", counts: null });
    expect(formatDiagnosticsSummary(summary)).toContain("Message counts: unavailable while the selected conversation loads or changes");
    expect(formatDiagnosticsSummary(summary)).not.toContain("Messages: 4");
  });

  it("rejects inconsistent or unsafe counts instead of exposing them", () => {
    const summary = buildDiagnosticsSummary({
      hubState: "error",
      directState: "failed",
      protocolState: "unavailable",
      storageState: "denied",
      conversationReady: true,
      messageCounts: { total: Number.MAX_SAFE_INTEGER + 1, queued: 0, sent: 0, failed: 0 },
    });

    expect(summary.conversation).toEqual({ state: "loading", counts: null });
  });

  it("replaces runtime values outside the status allowlists", () => {
    const privateValue = "private-room-code-9f2a with sender-secret-identifier";
    const untrustedInput = {
      hubState: privateValue,
      directState: privateValue,
      protocolState: privateValue,
      storageState: privateValue,
      conversationReady: false,
      messageCounts: null,
    } as unknown as Parameters<typeof buildDiagnosticsSummary>[0];
    const output = formatDiagnosticsSummary(buildDiagnosticsSummary(untrustedInput));

    expect(output).not.toContain(privateValue);
    expect(output).toContain("Hub: error");
    expect(output).toContain("Direct peer: failed");
    expect(output).toContain("Protocol checks: unavailable");
    expect(output).toContain("Browser storage: unavailable");
  });
});
