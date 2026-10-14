"""Small in-memory WebSocket relay for the NearLink v1 draft protocol.

Messages are plaintext. Room codes provide routing only and do not authenticate
participants. State exists only while clients are connected to this process.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from time import monotonic
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 32 * 1024
MAX_BODY_BYTES = 16 * 1024
MAX_ROOM_LENGTH = 64
MAX_SENDER_LENGTH = 128
MAX_NAME_LENGTH = 64
MAX_ID_LENGTH = 128
MAX_ROOMS = 64
MAX_ROOM_MEMBERS = 32
MAX_TOTAL_CLIENTS = 256
MAX_MESSAGES_PER_MINUTE = 120
SEND_TIMEOUT_SECONDS = 2

ROOM_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")

app = FastAPI(title="NearLink local hub", docs_url=None, redoc_url=None)


@dataclass(eq=False)
class Client:
    websocket: WebSocket
    room: str
    sender: str
    sender_name: str
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    message_window_started: float = field(default_factory=monotonic)
    messages_in_window: int = 0

    def consume_message(self) -> bool:
        now = monotonic()
        if now - self.message_window_started >= 60:
            self.message_window_started = now
            self.messages_in_window = 0
        if self.messages_in_window >= MAX_MESSAGES_PER_MINUTE:
            return False
        self.messages_in_window += 1
        return True


rooms: dict[str, set[Client]] = {}
active_connections = 0


def packet_error(code: str, message: str, message_id: str | None = None) -> dict[str, Any]:
    packet = {
        "version": PROTOCOL_VERSION,
        "type": "error",
        "code": code,
        "message": message,
    }
    if message_id is not None:
        packet["id"] = message_id
    return packet


def valid_version(packet: dict[str, Any]) -> bool:
    # bool is an int subclass in Python, but true is not protocol version 1.
    return type(packet.get("version")) is int and packet["version"] == PROTOCOL_VERSION


async def send_packet(client: Client, packet: dict[str, Any]) -> None:
    async def send() -> None:
        async with client.send_lock:
            await client.websocket.send_json(packet)

    await asyncio.wait_for(send(), timeout=SEND_TIMEOUT_SECONDS)


async def send_error(websocket: WebSocket, code: str, message: str) -> None:
    await websocket.send_json(packet_error(code, message))


def valid_room(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= MAX_ROOM_LENGTH and ROOM_PATTERN.fullmatch(value) is not None


def valid_identifier(value: Any, limit: int = MAX_ID_LENGTH) -> bool:
    return isinstance(value, str) and len(value) <= limit and IDENTIFIER_PATTERN.fullmatch(value) is not None


def valid_text(value: Any, limit: int) -> bool:
    if not isinstance(value, str):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return 0 < len(value.strip()) <= limit


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 64 or not TIMESTAMP_PATTERN.fullmatch(value):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def validate_join(packet: Any) -> tuple[str, str, str] | None:
    if not isinstance(packet, dict) or not valid_version(packet) or packet.get("type") != "join":
        return None
    room = packet.get("room")
    sender = packet.get("sender")
    name = packet.get("senderName")
    if not valid_room(room) or not valid_identifier(sender, MAX_SENDER_LENGTH) or not valid_text(name, MAX_NAME_LENGTH):
        return None
    return room, sender, name.strip()


def validate_message(packet: Any, client: Client) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(packet, dict) or not valid_version(packet) or packet.get("type") != "message":
        return None, "invalid_packet"

    message_id = packet.get("id")
    room = packet.get("room")
    sender = packet.get("sender")
    sender_name = packet.get("senderName")
    created_at = packet.get("createdAt")
    body = packet.get("body")
    if not valid_room(room):
        return None, "room_required"
    if not valid_identifier(message_id) or not valid_identifier(sender, MAX_SENDER_LENGTH):
        return None, "invalid_packet"
    if not valid_text(sender_name, MAX_NAME_LENGTH) or not valid_timestamp(created_at):
        return None, "invalid_packet"
    if not isinstance(body, str) or not body.strip():
        return None, "invalid_packet"
    try:
        body_size = len(body.encode("utf-8"))
    except UnicodeEncodeError:
        return None, "invalid_packet"
    if body_size > MAX_BODY_BYTES:
        return None, "message_too_large"
    if room != client.room or sender != client.sender or sender_name.strip() != client.sender_name:
        return None, "invalid_packet"

    return {
        "version": PROTOCOL_VERSION,
        "type": "message",
        "id": message_id,
        "room": room,
        "sender": sender,
        "senderName": client.sender_name,
        "createdAt": created_at,
        "body": body,
    }, None


async def broadcast_presence(room: str) -> None:
    members = tuple(rooms.get(room, ()))
    await asyncio.gather(
        *(
            send_packet(
                recipient,
                {"version": PROTOCOL_VERSION, "type": "presence", "peers": max(0, len(members) - 1)},
            )
            for recipient in members
        ),
        return_exceptions=True,
    )


async def relay(client: Client, packet: dict[str, Any]) -> None:
    # Confirm hub acceptance before attempting best-effort delivery to peers.
    await send_packet(client, {"version": PROTOCOL_VERSION, "type": "ack", "id": packet["id"]})
    members = tuple(rooms.get(client.room, ()))
    recipients = [member for member in members if member is not client]
    if recipients:
        results = await asyncio.gather(
            *(send_packet(recipient, packet) for recipient in recipients),
            return_exceptions=True,
        )
        for recipient, result in zip(recipients, results):
            if isinstance(result, BaseException):
                await remove_client(recipient)
                try:
                    await recipient.websocket.close(code=1013)
                except Exception:
                    pass


async def remove_client(client: Client) -> None:
    members = rooms.get(client.room)
    if members is None or client not in members:
        return
    members.remove(client)
    if not members:
        del rooms[client.room]
        return
    await broadcast_presence(client.room)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    global active_connections
    await websocket.accept()
    if active_connections >= MAX_TOTAL_CLIENTS:
        await send_error(websocket, "capacity_reached", "The local hub has reached its connection capacity.")
        await websocket.close(code=1013)
        return
    active_connections += 1
    client: Client | None = None
    try:
        raw = await websocket.receive_text()
        if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
            await send_error(websocket, "message_too_large", "Packet exceeds the maximum size.")
            await websocket.close(code=1009)
            return
        try:
            join_packet = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            await send_error(websocket, "invalid_packet", "Expected a valid JSON join packet.")
            await websocket.close(code=1003)
            return
        join = validate_join(join_packet)
        if join is None:
            await send_error(websocket, "invalid_packet", "Join packet does not match protocol version 1.")
            await websocket.close(code=1008)
            return

        room, sender, sender_name = join
        total_clients = sum(len(members) for members in rooms.values())
        current_room = rooms.get(room, set())
        if (
            total_clients >= MAX_TOTAL_CLIENTS
            or (room not in rooms and len(rooms) >= MAX_ROOMS)
            or len(current_room) >= MAX_ROOM_MEMBERS
        ):
            await send_error(websocket, "capacity_reached", "The local hub has reached its room capacity.")
            await websocket.close(code=1013)
            return
        client = Client(websocket, room, sender, sender_name)
        members = rooms.setdefault(room, set())
        members.add(client)
        await send_packet(
            client,
            {"version": PROTOCOL_VERSION, "type": "joined", "room": room, "peers": max(0, len(members) - 1)},
        )
        await broadcast_presence(room)

        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                await send_error(websocket, "message_too_large", "Packet exceeds the maximum size.")
                await websocket.close(code=1009)
                break
            try:
                incoming = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                await send_error(websocket, "invalid_packet", "Expected a valid JSON message packet.")
                continue
            message, error = validate_message(incoming, client)
            if error is not None:
                text = "Room is required or invalid." if error == "room_required" else (
                    "Message body exceeds the maximum size." if error == "message_too_large" else
                    "Packet does not match protocol version 1."
                )
                message_id = incoming.get("id") if isinstance(incoming, dict) else None
                if not valid_identifier(message_id):
                    message_id = None
                await send_packet(client, packet_error(error, text, message_id))
                continue
            if not client.consume_message():
                message_id = incoming.get("id") if isinstance(incoming, dict) else None
                if not valid_identifier(message_id):
                    message_id = None
                await send_packet(
                    client,
                    packet_error("rate_limited", "Please wait before sending more messages.", message_id),
                )
                continue
            await relay(client, message)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            if client is not None:
                await remove_client(client)
        finally:
            active_connections -= 1
