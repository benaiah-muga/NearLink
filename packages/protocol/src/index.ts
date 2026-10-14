export const PROTOCOL_VERSION = 1 as const;

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
  code: "invalid_packet" | "room_required" | "message_too_large";
  message: string;
}

export type ClientPacket = JoinPacket | MessagePacket;
export type ServerPacket =
  | JoinedPacket
  | MessagePacket
  | AcknowledgmentPacket
  | PresencePacket
  | ErrorPacket;

export function isMessagePacket(value: unknown): value is MessagePacket {
  if (typeof value !== "object" || value === null) return false;
  const packet = value as Record<string, unknown>;
  return (
    packet.version === PROTOCOL_VERSION &&
    packet.type === "message" &&
    typeof packet.id === "string" &&
    packet.id.length > 0 &&
    typeof packet.room === "string" &&
    packet.room.length > 0 &&
    typeof packet.sender === "string" &&
    packet.sender.length > 0 &&
    typeof packet.senderName === "string" &&
    typeof packet.createdAt === "string" &&
    typeof packet.body === "string" &&
    packet.body.length > 0
  );
}
