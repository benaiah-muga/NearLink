import { describe, expect, it } from "vitest";
import {
  isClientPacket,
  isJoinPacket,
  isMessagePacket,
  isProtocolIdentifier,
  isProtocolRoom,
  isProtocolTimestamp,
  isServerPacket,
  PROTOCOL_VERSION,
} from "../src/index";

const join = {
  version: PROTOCOL_VERSION,
  type: "join",
  room: "near_link-1",
  sender: "device:one.1",
  senderName: "Amina",
};

const message = {
  version: PROTOCOL_VERSION,
  type: "message",
  id: "message:one.1",
  room: "near_link-1",
  sender: "device:one.1",
  senderName: "Amina",
  createdAt: "2026-10-14T12:00:00.125Z",
  body: "Hello over the local link",
};

describe("NearLink protocol v1 validation", () => {
  it("accepts valid client join and message packets", () => {
    expect(isJoinPacket(join)).toBe(true);
    expect(isClientPacket(join)).toBe(true);
    expect(isMessagePacket(message)).toBe(true);
    expect(isClientPacket(message)).toBe(true);
  });

  it("accepts valid server packet variants", () => {
    const serverPackets = [
      { version: 1, type: "joined", room: "near_link-1", peers: 2 },
      { version: 1, type: "joined", room: "near_link-1", peers: 2, historyTruncated: true },
      message,
      { version: 1, type: "ack", id: "message:one.1" },
      { version: 1, type: "presence", peers: 2 },
      { version: 1, type: "error", code: "invalid_packet", message: "Packet rejected." },
      { version: 1, type: "error", code: "invalid_packet", message: "Packet rejected.", id: "message:one.1" },
      { version: 1, type: "error", code: "message_conflict", message: "Message ID conflict.", id: "message:one.1" },
      { version: 1, type: "error", code: "storage_unavailable", message: "Storage unavailable.", id: "message:one.1" },
    ];

    for (const packet of serverPackets) expect(isServerPacket(packet)).toBe(true);
  });

  it("rejects malformed identifiers and rooms", () => {
    for (const id of ["", "bad id", "x".repeat(129), "emoji-🔒", "id\n"]) {
      expect(isProtocolIdentifier(id)).toBe(false);
      expect(isJoinPacket({ ...join, sender: id })).toBe(false);
      expect(isMessagePacket({ ...message, id })).toBe(false);
    }
    for (const room of ["", "has space", "slash/name", "x".repeat(65), "room\n"]) {
      expect(isProtocolRoom(room)).toBe(false);
      expect(isJoinPacket({ ...join, room })).toBe(false);
      expect(isMessagePacket({ ...message, room })).toBe(false);
    }
  });

  it("counts message body size in UTF-8 bytes", () => {
    expect(isMessagePacket({ ...message, body: "a".repeat(16 * 1024) })).toBe(true);
    expect(isMessagePacket({ ...message, body: "a".repeat(16 * 1024 + 1) })).toBe(false);
    expect(isMessagePacket({ ...message, body: "🔒".repeat(4096) })).toBe(true);
    expect(isMessagePacket({ ...message, body: "🔒".repeat(4097) })).toBe(false);
    expect(isMessagePacket({ ...message, body: "  \n  " })).toBe(false);
  });

  it("matches Python str.strip whitespace for names and message bodies", () => {
    const pythonWhitespace = [
      ...Array.from({ length: 5 }, (_, index) => String.fromCodePoint(0x09 + index)),
      ...Array.from({ length: 4 }, (_, index) => String.fromCodePoint(0x1c + index)),
      ...[
        0x20, 0x85, 0xa0, 0x1680,
        ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
        0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
      ].map((point) => String.fromCodePoint(point)),
    ];

    for (const whitespace of pythonWhitespace) {
      expect(isJoinPacket({ ...join, senderName: whitespace })).toBe(false);
      expect(isMessagePacket({ ...message, body: whitespace })).toBe(false);
      expect(isJoinPacket({ ...join, senderName: `${whitespace}Amina${whitespace}` })).toBe(true);
      expect(isMessagePacket({ ...message, body: `${whitespace}Hello${whitespace}` })).toBe(true);
    }

    // Python str.strip does not classify BOM, U+180E, or U+001B as whitespace.
    for (const value of ["\ufeff", "\u180e", "\u001b"]) {
      expect(isJoinPacket({ ...join, senderName: value })).toBe(true);
      expect(isMessagePacket({ ...message, body: value })).toBe(true);
    }
  });

  it("rejects lone UTF-16 surrogates before UTF-8 encoding", () => {
    for (const malformed of ["\ud800", "\udfff", "\ud800A", "A\udfff", "\ud800\ud800"]) {
      expect(isJoinPacket({ ...join, senderName: malformed })).toBe(false);
      expect(isMessagePacket({ ...message, senderName: malformed })).toBe(false);
      expect(isMessagePacket({ ...message, body: malformed })).toBe(false);
    }
    expect(isMessagePacket({ ...message, body: "valid 🔒 text" })).toBe(true);
  });

  it("accepts hub-compatible ISO timestamps and rejects invalid values", () => {
    for (const value of [
      "2026-10-14T12:00:00Z",
      "2026-10-14T12:00:00.1Z",
      "2026-10-14T12:00:00.125+03:00",
    ]) expect(isProtocolTimestamp(value)).toBe(true);

    for (const value of [
      "2026-02-30T12:00:00Z",
      "2026-10-14 12:00:00Z",
      "2026-10-14T12:00:00.1234Z",
      "2026-10-14T12:00:00",
      "2026-10-14T12:00:00+99:99",
      "2026-10-14T12:00:00Z\n",
      "x".repeat(65),
    ]) {
      expect(isProtocolTimestamp(value)).toBe(false);
      expect(isMessagePacket({ ...message, createdAt: value })).toBe(false);
    }
  });

  it("rejects unsupported versions, unknown types, and non-packet values", () => {
    for (const version of [0, 2, "1", true, null]) {
      expect(isClientPacket({ ...join, version })).toBe(false);
      expect(isServerPacket({ version, type: "presence", peers: 1 })).toBe(false);
    }
    expect(isClientPacket({ ...join, type: "leave" })).toBe(false);
    expect(isServerPacket({ version: 1, type: "future_packet" })).toBe(false);
    expect(isClientPacket(null)).toBe(false);
    expect(isServerPacket([])).toBe(false);
  });

  it("rejects malformed server packet fields", () => {
    expect(isServerPacket({ version: 1, type: "joined", room: "bad room", peers: 0 })).toBe(false);
    expect(isServerPacket({ version: 1, type: "joined", room: "room", peers: -1 })).toBe(false);
    expect(isServerPacket({ version: 1, type: "joined", room: "room", peers: 0, historyTruncated: "yes" })).toBe(false);
    expect(isServerPacket({ version: 1, type: "presence", peers: 1.5 })).toBe(false);
    expect(isServerPacket({ version: 1, type: "ack", id: "bad id" })).toBe(false);
    expect(isServerPacket({ version: 1, type: "error", code: "unknown", message: "no" })).toBe(false);
    expect(isServerPacket({ version: 1, type: "error", code: "invalid_packet", message: 1 })).toBe(false);
  });
});
