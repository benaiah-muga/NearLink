export const PROTOCOL_VERSION = 1 as const;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/;
export const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})(?![\s\S])/;
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 64;
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

export interface JoinedPacket {
  version: typeof PROTOCOL_VERSION;
  type: "joined";
  room: string;
  peers: number;
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
    | "rate_limited";
  message: string;
  id?: string;
}

export type ClientPacket = JoinPacket | MessagePacket;
export type ServerPacket =
  | JoinedPacket
  | MessagePacket
  | AcknowledgmentPacket
  | PresencePacket
  | ErrorPacket;

export function isJoinPacket(value: unknown): value is JoinPacket {
  if (!isRecord(value)) return false;
  return value.version === PROTOCOL_VERSION
    && value.type === "join"
    && isProtocolRoom(value.room)
    && isProtocolIdentifier(value.sender)
    && isDisplayName(value.senderName);
}

export function isMessagePacket(value: unknown): value is MessagePacket {
  if (!isRecord(value)) return false;
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

export function isServerPacket(value: unknown): value is ServerPacket {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.type !== "string") return false;

  switch (value.type) {
    case "joined":
      return isProtocolRoom(value.room) && Number.isInteger(value.peers) && Number(value.peers) >= 0;
    case "message":
      return isMessagePacket(value);
    case "ack":
      return isProtocolIdentifier(value.id);
    case "presence":
      return Number.isInteger(value.peers) && Number(value.peers) >= 0;
    case "error":
      return ["invalid_packet", "room_required", "message_too_large", "capacity_reached", "rate_limited"].includes(String(value.code))
        && typeof value.message === "string"
        && (value.id === undefined || isProtocolIdentifier(value.id));
    default:
      return false;
  }
}

export function isClientPacket(value: unknown): value is ClientPacket {
  return isJoinPacket(value) || isMessagePacket(value);
}
