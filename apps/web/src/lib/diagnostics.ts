export type DiagnosticHubState = "offline" | "connecting" | "linking" | "online" | "retrying" | "error";
export type DiagnosticDirectState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type DiagnosticProtocolState = "loading" | "ready" | "unavailable";
export type DiagnosticStorageState = "checking" | "granted" | "denied" | "unavailable";

export interface DiagnosticMessageCounts {
  total: number;
  queued: number;
  sent: number;
  failed: number;
}

export interface DiagnosticsInput {
  hubState: DiagnosticHubState;
  directState: DiagnosticDirectState;
  protocolState: DiagnosticProtocolState;
  storageState: DiagnosticStorageState;
  conversationReady: boolean;
  messageCounts: DiagnosticMessageCounts | null;
}

export interface DiagnosticsSummary {
  hub: DiagnosticHubState;
  direct: DiagnosticDirectState;
  protocol: DiagnosticProtocolState;
  storage: DiagnosticStorageState;
  conversation: {
    state: "ready" | "loading";
    counts: DiagnosticMessageCounts | null;
  };
}

const HUB_STATES: readonly DiagnosticHubState[] = ["offline", "connecting", "linking", "online", "retrying", "error"];
const DIRECT_STATES: readonly DiagnosticDirectState[] = ["new", "connecting", "connected", "disconnected", "failed", "closed"];
const PROTOCOL_STATES: readonly DiagnosticProtocolState[] = ["loading", "ready", "unavailable"];
const STORAGE_STATES: readonly DiagnosticStorageState[] = ["checking", "granted", "denied", "unavailable"];

function allowlisted<T extends string>(value: T, values: readonly T[], fallback: T): T {
  return values.includes(value) ? value : fallback;
}

function areCountsValid(counts: DiagnosticMessageCounts): boolean {
  return Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0)
    && counts.queued + counts.sent + counts.failed === counts.total;
}

/** Build a support summary from allowlisted states and counts only. */
export function buildDiagnosticsSummary(input: DiagnosticsInput): DiagnosticsSummary {
  const counts = input.conversationReady && input.messageCounts && areCountsValid(input.messageCounts)
    ? { ...input.messageCounts }
    : null;
  return {
    hub: allowlisted(input.hubState, HUB_STATES, "error"),
    direct: allowlisted(input.directState, DIRECT_STATES, "failed"),
    protocol: allowlisted(input.protocolState, PROTOCOL_STATES, "unavailable"),
    storage: allowlisted(input.storageState, STORAGE_STATES, "unavailable"),
    conversation: {
      state: counts ? "ready" : "loading",
      counts,
    },
  };
}

/** Format the typed summary for display and copying. */
export function formatDiagnosticsSummary(summary: DiagnosticsSummary): string {
  const countLines = summary.conversation.counts
    ? [
      `Messages: ${summary.conversation.counts.total}`,
      `Queued: ${summary.conversation.counts.queued}`,
      `Sent: ${summary.conversation.counts.sent}`,
      `Failed: ${summary.conversation.counts.failed}`,
    ]
    : ["Message counts: unavailable while the selected conversation loads or changes"];
  return [
    "NearLink diagnostics",
    `Hub: ${summary.hub}`,
    `Direct peer: ${summary.direct}`,
    `Protocol checks: ${summary.protocol}`,
    `Browser storage: ${summary.storage}`,
    ...countLines,
  ].join("\n");
}
