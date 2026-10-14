"""Small SQLite-backed WebSocket relay for the NearLink v1 draft protocol.

Messages are plaintext. Room codes provide routing only and do not authenticate
participants. Message history is retained locally within configured bounds.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from time import monotonic, time
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
MAX_REPLAY_MESSAGES = 100
MAX_MESSAGES_PER_ROOM = 200
MAX_TOTAL_STORED_MESSAGES = 2_000
MAX_TRACKED_ROOMS = MAX_TOTAL_STORED_MESSAGES + MAX_ROOMS
MAX_TOTAL_STORED_BYTES = 32 * 1024 * 1024
MAX_DATABASE_BYTES = 64 * 1024 * 1024
SQLITE_PAGE_BYTES = 4_096
MAX_DATABASE_PAGES = MAX_DATABASE_BYTES // SQLITE_PAGE_BYTES
MESSAGE_RETENTION_SECONDS = 30 * 24 * 60 * 60
MAX_STORED_PACKET_BYTES = MAX_FRAME_BYTES
DEFAULT_DATABASE_PATH = "nearlink-hub.sqlite3"

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
room_delivery_lock = asyncio.Lock()


class MessageStore:
    """Bounded local message history backed by SQLite.

    Each operation opens its own connection so worker threads and app reloads
    do not share a SQLite connection. Unique room and message IDs make retries
    idempotent while a record is retained.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        replay_limit: int = MAX_REPLAY_MESSAGES,
        per_room_limit: int = MAX_MESSAGES_PER_ROOM,
        total_limit: int = MAX_TOTAL_STORED_MESSAGES,
    ) -> None:
        self.path = str(path) if str(path) == ":memory:" else str(Path(path).expanduser())
        self.replay_limit = replay_limit
        self.per_room_limit = per_room_limit
        self.total_limit = total_limit

    def _connect(self) -> sqlite3.Connection:
        if self.path != ":memory:":
            file_path = Path(self.path).resolve()
            file_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(file_path, os.O_CREAT | os.O_RDWR, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
            finally:
                os.close(descriptor)
        connection = sqlite3.connect(self.path, timeout=2)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 2000")
        connection.execute("PRAGMA wal_autocheckpoint = 100")
        connection.execute(f"PRAGMA max_page_count = {MAX_DATABASE_PAGES}")
        connection.execute("PRAGMA journal_mode = WAL")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 2:
            connection.close()
            raise sqlite3.DatabaseError("database schema version is newer than this hub")
        if version == 0:
            connection.execute("PRAGMA auto_vacuum = INCREMENTAL")
            try:
                connection.executescript(
                    """BEGIN IMMEDIATE;
                    CREATE TABLE messages (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    packet TEXT NOT NULL,
                    packet_bytes INTEGER NOT NULL,
                    stored_at REAL NOT NULL,
                    UNIQUE(room, message_id)
                    );
                    CREATE INDEX messages_room_sequence ON messages(room, sequence);
                    CREATE TABLE room_state (
                        room TEXT PRIMARY KEY,
                        history_truncated INTEGER NOT NULL DEFAULT 0,
                        touched_at REAL NOT NULL
                    );
                    CREATE TABLE store_state (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        marker_overflow INTEGER NOT NULL DEFAULT 0
                    );
                    INSERT INTO store_state(id, marker_overflow) VALUES (1, 0);
                    PRAGMA user_version = 2;
                    COMMIT;"""
                )
            except sqlite3.Error:
                connection.rollback()
                connection.close()
                raise
        elif version == 1:
            try:
                connection.executescript(
                    """BEGIN IMMEDIATE;
                    ALTER TABLE room_state ADD COLUMN touched_at REAL NOT NULL DEFAULT 0;
                    UPDATE room_state SET touched_at = 0;
                    CREATE TABLE store_state (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        marker_overflow INTEGER NOT NULL DEFAULT 0
                    );
                    INSERT INTO store_state(id, marker_overflow) VALUES (1, 0);
                    PRAGMA user_version = 2;
                    COMMIT;"""
                )
            except sqlite3.Error:
                connection.rollback()
                connection.close()
                raise
        elif version == 2:
            for table in ("messages", "room_state", "store_state"):
                exists = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
                ).fetchone()
                if exists is None:
                    connection.close()
                    raise sqlite3.DatabaseError(f"version 2 database is missing {table}")
        self._secure_sidecars()
        return connection

    @staticmethod
    def _touch_room(connection: sqlite3.Connection, room: str, *, truncated: bool = False) -> None:
        connection.execute(
            """INSERT INTO room_state(room, history_truncated, touched_at) VALUES (?, ?, ?)
               ON CONFLICT(room) DO UPDATE SET
                 history_truncated = MAX(room_state.history_truncated, excluded.history_truncated),
                 touched_at = excluded.touched_at""",
            (room, int(truncated), time()),
        )

    @staticmethod
    def _trim_room_markers(connection: sqlite3.Connection) -> None:
        count = connection.execute("SELECT COUNT(*) FROM room_state").fetchone()[0]
        overflow = count - MAX_TRACKED_ROOMS
        if overflow <= 0:
            return
        removed = connection.execute(
            """SELECT room FROM room_state
               WHERE room NOT IN (SELECT DISTINCT room FROM messages)
               ORDER BY touched_at ASC LIMIT ?""",
            (overflow,),
        ).fetchall()
        if removed:
            connection.executemany("DELETE FROM room_state WHERE room = ?", [(row["room"],) for row in removed])
            connection.execute("UPDATE store_state SET marker_overflow = 1 WHERE id = 1")

    def store(self, packet: dict[str, Any]) -> str:
        encoded = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        try:
            packet_size = len(encoded.encode("utf-8"))
        except UnicodeEncodeError:
            return "invalid"
        if packet_size > MAX_STORED_PACKET_BYTES:
            return "too_large"

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT packet FROM messages WHERE room = ? AND message_id = ?",
                (packet["room"], packet["id"]),
            ).fetchone()
            if existing is not None:
                connection.rollback()
                return "duplicate" if existing["packet"] == encoded else "conflict"

            self._touch_room(connection, packet["room"])
            cutoff = time() - MESSAGE_RETENTION_SECONDS
            expired_rooms = connection.execute(
                "SELECT DISTINCT room FROM messages WHERE stored_at < ?", (cutoff,)
            ).fetchall()
            connection.execute("DELETE FROM messages WHERE stored_at < ?", (cutoff,))
            for expired_room in expired_rooms:
                self._touch_room(connection, expired_room["room"], truncated=True)

            connection.execute(
                "INSERT INTO messages(room, message_id, packet, packet_bytes, stored_at) VALUES (?, ?, ?, ?, ?)",
                (packet["room"], packet["id"], encoded, packet_size, time()),
            )
            room_before = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE room = ?", (packet["room"],)
            ).fetchone()[0]
            connection.execute(
                """DELETE FROM messages WHERE room = ? AND sequence NOT IN (
                    SELECT sequence FROM messages WHERE room = ?
                    ORDER BY sequence DESC LIMIT ?
                )""",
                (packet["room"], packet["room"], self.per_room_limit),
            )
            room_after = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE room = ?", (packet["room"],)
            ).fetchone()[0]
            if room_before > room_after:
                self._touch_room(connection, packet["room"], truncated=True)
            while True:
                totals = connection.execute(
                    "SELECT COUNT(*) AS rows, COALESCE(SUM(packet_bytes), 0) AS bytes FROM messages"
                ).fetchone()
                if totals["rows"] <= self.total_limit and totals["bytes"] <= MAX_TOTAL_STORED_BYTES:
                    break
                oldest = connection.execute(
                    "SELECT sequence, room FROM messages ORDER BY sequence LIMIT 1"
                ).fetchone()
                if oldest is None:
                    break
                connection.execute("DELETE FROM messages WHERE sequence = ?", (oldest["sequence"],))
                self._touch_room(connection, oldest["room"], truncated=True)
            self._trim_room_markers(connection)
            connection.commit()
            try:
                self._post_commit_maintenance(connection)
            except (OSError, sqlite3.Error):
                # The message is already durable. Housekeeping cannot turn a
                # committed message into a storage failure response.
                pass
            return "stored"
        except sqlite3.Error:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _secure_sidecars(self) -> None:
        if self.path == ":memory:":
            return
        for suffix in ("-wal", "-shm", "-journal"):
            try:
                os.chmod(f"{self.path}{suffix}", 0o600)
            except FileNotFoundError:
                pass

    def _post_commit_maintenance(self, connection: sqlite3.Connection) -> None:
        connection.execute("PRAGMA incremental_vacuum(16)")
        self._secure_sidecars()

    def recent(self, room: str) -> tuple[list[dict[str, Any]], bool]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            cutoff = time() - MESSAGE_RETENTION_SECONDS
            expired_rooms = connection.execute(
                "SELECT DISTINCT room FROM messages WHERE stored_at < ?", (cutoff,)
            ).fetchall()
            connection.execute("DELETE FROM messages WHERE stored_at < ?", (cutoff,))
            for expired_room in expired_rooms:
                self._touch_room(connection, expired_room["room"], truncated=True)
            self._trim_room_markers(connection)
            count = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE room = ?", (room,)
            ).fetchone()[0]
            state = connection.execute(
                "SELECT history_truncated FROM room_state WHERE room = ?", (room,)
            ).fetchone()
            marker_overflow = connection.execute(
                "SELECT marker_overflow FROM store_state WHERE id = 1"
            ).fetchone()[0]
            rows = connection.execute(
                """SELECT packet FROM messages WHERE room = ?
                   ORDER BY sequence DESC LIMIT ?""",
                (room, self.replay_limit),
            ).fetchall()
            truncated = (
                count > self.replay_limit
                or (state is not None and bool(state["history_truncated"]))
                or bool(marker_overflow)
            )
            connection.commit()
            return [json.loads(row["packet"]) for row in reversed(rows)], truncated
        except sqlite3.Error:
            connection.rollback()
            raise
        finally:
            connection.close()


def database_path() -> str:
    configured = os.environ.get("NEARLINK_HUB_DB_PATH", "").strip()
    return configured or DEFAULT_DATABASE_PATH


message_store = MessageStore(database_path())


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


async def relay(client: Client, packet: dict[str, Any]) -> bool:
    # Serialize storage, ACK, fan-out, and room snapshots so a joining client
    # sees either a message in history or after history, never in both or neither.
    async with room_delivery_lock:
        try:
            result = await asyncio.to_thread(message_store.store, packet)
        except (OSError, sqlite3.Error):
            await send_packet(
                client,
                packet_error("storage_unavailable", "The local hub could not store this message.", packet["id"]),
            )
            return False
        if result == "conflict":
            await send_packet(
                client,
                packet_error(
                    "message_conflict", "This message ID was already used for different content.", packet["id"]
                ),
            )
            return False
        if result == "too_large":
            await send_packet(
                client,
                packet_error("message_too_large", "Packet exceeds the maximum size.", packet["id"]),
            )
            return False
        if result == "invalid":
            await send_packet(client, packet_error("invalid_packet", "Message contains invalid text.", packet["id"]))
            return False

        ack_failed = False
        try:
            await send_packet(client, {"version": PROTOCOL_VERSION, "type": "ack", "id": packet["id"]})
        except Exception:
            # The row is already durable. A broken sender socket must not
            # prevent other connected room members from receiving the packet.
            ack_failed = True
        members = tuple(rooms.get(client.room, ()))
        recipients = [member for member in members if member is not client]
        if result != "duplicate" and recipients:
            results = await asyncio.gather(
                *(send_packet(recipient, packet) for recipient in recipients),
                return_exceptions=True,
            )
            for recipient, send_result in zip(recipients, results):
                if isinstance(send_result, BaseException):
                    await remove_client(recipient)
                    try:
                        await recipient.websocket.close(code=1013)
                    except Exception:
                        pass
        if ack_failed:
            await remove_client(client)
            try:
                await client.websocket.close(code=1011)
            except Exception:
                pass
        return ack_failed


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
        async with room_delivery_lock:
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
            try:
                history, truncated = await asyncio.to_thread(message_store.recent, room)
            except (OSError, sqlite3.Error):
                await send_packet(
                    client,
                    packet_error("storage_unavailable", "The local hub could not load room history."),
                )
                await websocket.close(code=1011)
                return
            await send_packet(
                client,
                {
                    "version": PROTOCOL_VERSION,
                    "type": "joined",
                    "room": room,
                    "peers": max(0, len(members) - 1),
                    "historyTruncated": truncated,
                },
            )
            try:
                async def replay_history() -> None:
                    for packet in history:
                        await send_packet(client, packet)

                await asyncio.wait_for(replay_history(), timeout=5)
            except asyncio.TimeoutError:
                await send_packet(
                    client,
                    packet_error("storage_unavailable", "The local hub could not replay room history."),
                )
                await websocket.close(code=1013)
                return
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
            if await relay(client, message):
                break
    except WebSocketDisconnect:
        pass
    finally:
        try:
            if client is not None:
                await remove_client(client)
        finally:
            active_connections -= 1
