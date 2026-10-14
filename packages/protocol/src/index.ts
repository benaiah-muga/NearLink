export const PROTOCOL_VERSION = 1 as const;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/;
export const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})(?![\s\S])/;
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_HISTORY_PAGE_MESSAGES = 100;
export const MAX_HISTORY_PAGE_BYTES = 512 * 1024;
export const MAX_PROTOCOL_ENVELOPE_BYTES = 18 * 1024;
export const MAX_SYNC_INVENTORY_IDS = 4096;
export const MAX_SYNC_PACKET_IDS = 100;
const HUB_WHITESPACE = "\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const HUB_WHITESPACE_AT_EDGES = new RegExp(`^[${HUB_WHITESPACE}]+|[${HUB_WHITESPACE}]+$`, "gu");

export function isProtocolIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function isProtocolRoom(value: unknown): value is string {
  return typeof value === "string" && ROOM_PATTERN.test(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stripHubWhitespace(value: string): string {
  return value.replace(HUB_WHITESPACE_AT_EDGES, "");
}

function isDisplayName(value: unknown): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return false;
  const length = [...stripHubWhitespace(value)].length;
  return length > 0 && length <= MAX_DISPLAY_NAME_LENGTH;
}

export function isProtocolTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !TIMESTAMP_PATTERN.test(value)) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))(?![\s\S])/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === fields.length && actual.every((field) => fields.includes(field));
}

function isEnvelopeWithinLimit(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string"
      && new TextEncoder().encode(encoded).byteLength <= MAX_PROTOCOL_ENVELOPE_BYTES;
  } catch {
    return false;
  }
}

export interface JoinPacket {
  version: typeof PROTOCOL_VERSION;
  type: "join";
  room: string;
  sender: string;
  senderName: string;
}

export interface MessagePacket {
  version: typeof PROTOCOL_VERSION;
  type: "message";
  id: string;
  room: string;
  sender: string;
  senderName: string;
  createdAt: string;
  body: string;
}

export interface HistoryRequestPacket {
  version: typeof PROTOCOL_VERSION;
  type: "history_request";
  requestId: string;
  room: string;
  cursor: string | null;
  limit: number;
}

export interface HistoryPageCompletePacket {
  version: typeof PROTOCOL_VERSION;
  type: "history_page_complete";
  requestId: string;
  room: string;
  messageIds: string[];
  pageBytes: number;
  nextCursor: string | null;
  hasMore: boolean;
  historyTruncated: boolean;
}

export interface SyncInventoryPagePacket {
  version: typeof PROTOCOL_VERSION;
  type: "sync_inventory_page";
  room: string;
  syncId: string;
  sender: string;
  cursor: string | null;
  messageIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
  limitReached: boolean;
}

export interface SyncMissingRequestPacket {
  version: typeof PROTOCOL_VERSION;
  type: "sync_missing_request";
  room: string;
  syncId: string;
  requestId: string;
  sender: string;
  targetSender: string;
  messageIds: string[];
}

export interface SyncPageCompletePacket {
  version: typeof PROTOCOL_VERSION;
  type: "sync_page_complete";
  room: string;
  syncId: string;
  requestId: string;
  sender: string;
  targetSender: string;
  messageIds: string[];
}

export type SyncPacket = SyncInventoryPagePacket | SyncMissingRequestPacket | SyncPageCompletePacket;

export interface JoinedPacket {
  version: typeof PROTOCOL_VERSION;
  type: "joined";
  room: string;
  peers: number;
  historyTruncated?: boolean;
}

export interface AcknowledgmentPacket {
  version: typeof PROTOCOL_VERSION;
  type: "ack";
  id: string;
}

export interface PresencePacket {
  version: typeof PROTOCOL_VERSION;
  type: "presence";
  peers: number;
}

export interface ErrorPacket {
  version: typeof PROTOCOL_VERSION;
  type: "error";
  code:
    | "invalid_packet"
    | "room_required"
    | "message_too_large"
    | "capacity_reached"
    | "rate_limited"
    | "history_rate_limited"
    | "sync_rate_limited"
    | "message_conflict"
    | "storage_unavailable"
    | "not_joined"
    | "invalid_cursor"
    | "history_packet_too_large"
    | "history_page_too_large";
  message: string;
  id?: string;
}

export type ClientPacket = JoinPacket | MessagePacket | HistoryRequestPacket | SyncPacket;
export type ServerPacket =
  | JoinedPacket
  | MessagePacket
  | AcknowledgmentPacket
  | PresencePacket
  | ErrorPacket
  | HistoryPageCompletePacket
  | SyncPacket;

function isSortedUniqueIdentifiers(value: unknown, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value)
    || value.length > MAX_SYNC_PACKET_IDS
    || (!allowEmpty && value.length === 0)
    || !value.every(isProtocolIdentifier)) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) return false;
  }
  return true;
}

export function isSyncInventoryPagePacket(value: unknown): value is SyncInventoryPagePacket {
  if (!isRecord(value) || !hasExactFields(value, [
    "version", "type", "room", "syncId", "sender", "cursor", "messageIds", "nextCursor", "hasMore", "limitReached",
  ]) || !isEnvelopeWithinLimit(value)
    || value.version !== PROTOCOL_VERSION
    || value.type !== "sync_inventory_page"
    || !isProtocolRoom(value.room)
    || !isProtocolIdentifier(value.syncId)
    || !isProtocolIdentifier(value.sender)
    || !(value.cursor === null || isProtocolIdentifier(value.cursor))
    || !isSortedUniqueIdentifiers(value.messageIds, true)
    || !(value.nextCursor === null || isProtocolIdentifier(value.nextCursor))
    || typeof value.hasMore !== "boolean"
    || typeof value.limitReached !== "boolean") return false;
  const ids = value.messageIds;
  if (ids.length === 0) return value.cursor === null && value.nextCursor === null && !value.hasMore && !value.limitReached;
  if (value.nextCursor !== ids[ids.length - 1] || (value.cursor !== null && ids[0] <= value.cursor)) return false;
  return !value.limitReached || !value.hasMore;
}

export function isSyncMissingRequestPacket(value: unknown): value is SyncMissingRequestPacket {
  return isRecord(value) && hasExactFields(value, [
    "version", "type", "room", "syncId", "requestId", "sender", "targetSender", "messageIds",
  ]) && isEnvelopeWithinLimit(value)
    && value.version === PROTOCOL_VERSION
    && value.type === "sync_missing_request"
    && isProtocolRoom(value.room)
    && isProtocolIdentifier(value.syncId)
    && isProtocolIdentifier(value.requestId)
    && isProtocolIdentifier(value.sender)
    && isProtocolIdentifier(value.targetSender)
    && isSortedUniqueIdentifiers(value.messageIds, false);
}

export function isSyncPageCompletePacket(value: unknown): value is SyncPageCompletePacket {
  return isRecord(value) && hasExactFields(value, [
    "version", "type", "room", "syncId", "requestId", "sender", "targetSender", "messageIds",
  ]) && isEnvelopeWithinLimit(value)
    && value.version === PROTOCOL_VERSION
    && value.type === "sync_page_complete"
    && isProtocolRoom(value.room)
    && isProtocolIdentifier(value.syncId)
    && isProtocolIdentifier(value.requestId)
    && isProtocolIdentifier(value.sender)
    && isProtocolIdentifier(value.targetSender)
    && isSortedUniqueIdentifiers(value.messageIds, true);
}

function isSyncPacket(value: unknown): value is SyncPacket {
  return isSyncInventoryPagePacket(value)
    || isSyncMissingRequestPacket(value)
    || isSyncPageCompletePacket(value);
}

export function isJoinPacket(value: unknown): value is JoinPacket {
  if (!isRecord(value) || !isEnvelopeWithinLimit(value)) return false;
  return value.version === PROTOCOL_VERSION
    && value.type === "join"
    && isProtocolRoom(value.room)
    && isProtocolIdentifier(value.sender)
    && isDisplayName(value.senderName);
}

export function isMessagePacket(value: unknown): value is MessagePacket {
  if (!isRecord(value) || !isEnvelopeWithinLimit(value)) return false;
  return (
    value.version === PROTOCOL_VERSION &&
    value.type === "message" &&
    isProtocolIdentifier(value.id) &&
    isProtocolRoom(value.room) &&
    isProtocolIdentifier(value.sender) &&
    isDisplayName(value.senderName) &&
    isProtocolTimestamp(value.createdAt) &&
    typeof value.body === "string" &&
    isWellFormedUnicode(value.body) &&
    stripHubWhitespace(value.body).length > 0 &&
    new TextEncoder().encode(value.body).byteLength <= MAX_MESSAGE_BODY_BYTES
  );
}

export function isHistoryRequestPacket(value: unknown): value is HistoryRequestPacket {
  if (!isRecord(value) || !isEnvelopeWithinLimit(value)) return false;
  return value.version === PROTOCOL_VERSION
    && value.type === "history_request"
    && isProtocolIdentifier(value.requestId)
    && isProtocolRoom(value.room)
    && (value.cursor === null || isProtocolIdentifier(value.cursor))
    && Number.isInteger(value.limit)
    && Number(value.limit) >= 1
    && Number(value.limit) <= MAX_HISTORY_PAGE_MESSAGES;
}

export function isHistoryPageCompletePacket(value: unknown): value is HistoryPageCompletePacket {
  if (!isRecord(value)
    || !isEnvelopeWithinLimit(value)
    || value.version !== PROTOCOL_VERSION
    || value.type !== "history_page_complete"
    || !isProtocolIdentifier(value.requestId)
    || !isProtocolRoom(value.room)
    || !Array.isArray(value.messageIds)
    || value.messageIds.length > MAX_HISTORY_PAGE_MESSAGES
    || !value.messageIds.every(isProtocolIdentifier)
    || new Set(value.messageIds).size !== value.messageIds.length
    || !Number.isInteger(value.pageBytes)
    || Number(value.pageBytes) < 0
    || Number(value.pageBytes) > MAX_HISTORY_PAGE_BYTES
    || (value.messageIds.length === 0) !== (value.pageBytes === 0)
    || !(value.nextCursor === null || isProtocolIdentifier(value.nextCursor))
    || typeof value.hasMore !== "boolean"
    || typeof value.historyTruncated !== "boolean") return false;

  return value.hasMore
    ? value.messageIds.length > 0 && value.nextCursor === value.messageIds[value.messageIds.length - 1]
    : value.nextCursor === null;
}

export function isServerPacket(value: unknown): value is ServerPacket {
  if (!isRecord(value) || !isEnvelopeWithinLimit(value) || value.version !== PROTOCOL_VERSION || typeof value.type !== "string") return false;

  switch (value.type) {
    case "history_page_complete":
      return isHistoryPageCompletePacket(value);
    case "sync_inventory_page":
    case "sync_missing_request":
    case "sync_page_complete":
      return isSyncPacket(value);
    case "joined":
      return isProtocolRoom(value.room)
        && Number.isInteger(value.peers)
        && Number(value.peers) >= 0
        && (value.historyTruncated === undefined || typeof value.historyTruncated === "boolean");
    case "message":
      return isMessagePacket(value);
    case "ack":
      return isProtocolIdentifier(value.id);
    case "presence":
      return Number.isInteger(value.peers) && Number(value.peers) >= 0;
    case "error":
      return typeof value.code === "string"
        && [
          "invalid_packet",
          "room_required",
          "message_too_large",
          "capacity_reached",
          "rate_limited",
          "history_rate_limited",
          "sync_rate_limited",
          "message_conflict",
          "storage_unavailable",
          "not_joined",
          "invalid_cursor",
          "history_packet_too_large",
          "history_page_too_large",
        ].includes(value.code)
        && typeof value.message === "string"
        && (value.id === undefined || isProtocolIdentifier(value.id));
    default:
      return false;
  }
}

export function isClientPacket(value: unknown): value is ClientPacket {
  return isJoinPacket(value) || isMessagePacket(value) || isHistoryRequestPacket(value) || isSyncPacket(value);
}
