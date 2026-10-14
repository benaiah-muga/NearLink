from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from contextlib import ExitStack
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as hub  # noqa: E402


@pytest.fixture(autouse=True)
def empty_hub_state(monkeypatch, tmp_path):
    assert hub.rooms == {}
    assert hub.active_connections == 0
    hub.sync_rate_buckets.clear()
    monkeypatch.setattr(hub, "message_store", hub.MessageStore(tmp_path / "history.sqlite3"))
    yield
    assert hub.rooms == {}
    assert hub.active_connections == 0
    hub.sync_rate_buckets.clear()


def join_packet(room: str = "test-room", sender: str = "sender-1", name: str = "Sender") -> dict:
    return {
        "version": 1,
        "type": "join",
        "room": room,
        "sender": sender,
        "senderName": name,
    }


def message_packet(
    *, message_id: str = "message-1", room: str = "test-room", sender: str = "sender-1", name: str = "Sender"
) -> dict:
    return {
        "version": 1,
        "type": "message",
        "id": message_id,
        "room": room,
        "sender": sender,
        "senderName": name,
        "createdAt": "2026-10-14T12:00:00Z",
        "body": "hello",
    }


def sync_inventory_packet(*, room: str = "test-room", sender: str = "sender-1") -> dict:
    return {
        "version": 1,
        "type": "sync_inventory_page",
        "room": room,
        "syncId": "sync-1",
        "sender": sender,
        "cursor": None,
        "messageIds": ["id-a", "id-b"],
        "nextCursor": "id-b",
        "hasMore": False,
        "limitReached": False,
    }


@pytest.mark.parametrize(
    "packet",
    [
        None,
        {"version": True, "type": "join", "room": "room", "sender": "s", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "bad room", "sender": "s", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "room", "sender": "bad sender!", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "room", "sender": "s", "senderName": "  "},
        {"version": 1, "type": "join", "room": "room", "sender": "s", "senderName": "\ud800"},
    ],
)
def test_invalid_join_packets_are_rejected_and_closed(packet):
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text(json.dumps(packet))
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert response["code"] == "invalid_packet"
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_json()

    assert hub.rooms == {}
    assert hub.active_connections == 0


def test_malformed_input_gets_error_then_connection_can_continue():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            assert websocket.receive_json() == {"version": 1, "type": "presence", "peers": 0}

            websocket.send_text("not-json")
            malformed = websocket.receive_json()
            assert malformed["type"] == "error"
            assert malformed["code"] == "invalid_packet"

            invalid_message = message_packet()
            invalid_message["body"] = "   "
            websocket.send_json(invalid_message)
            rejected = websocket.receive_json()
            assert rejected["type"] == "error"
            assert rejected["code"] == "invalid_packet"
            assert rejected["id"] == "message-1"

    assert hub.rooms == {}
    assert hub.active_connections == 0


def test_text_whitespace_and_unicode_scalar_rules_match_protocol_vectors():
    python_whitespace = [
        *(chr(point) for point in range(0x09, 0x0E)),
        *(chr(point) for point in range(0x1C, 0x20)),
        *(chr(point) for point in [0x20, 0x85, 0xA0, 0x1680]),
        *(chr(point) for point in range(0x2000, 0x200B)),
        *(chr(point) for point in [0x2028, 0x2029, 0x202F, 0x205F, 0x3000]),
    ]
    for whitespace in python_whitespace:
        assert not hub.valid_text(whitespace, hub.MAX_NAME_LENGTH)
        assert hub.valid_text(f"{whitespace}Amina{whitespace}", hub.MAX_NAME_LENGTH)

    for value in ["\ufeff", "\u180e", "\u001b"]:
        assert hub.valid_text(value, hub.MAX_NAME_LENGTH)

    assert not hub.valid_text("\ud800", hub.MAX_NAME_LENGTH)


def test_message_with_lone_surrogate_is_rejected_without_ending_connection():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            websocket.receive_json()

            malformed = message_packet()
            malformed["body"] = "\ud800"
            websocket.send_text(json.dumps(malformed, ensure_ascii=True))
            rejected = websocket.receive_json()
            assert rejected["type"] == "error"
            assert rejected["code"] == "invalid_packet"
            assert "id" not in rejected

            websocket.send_json(message_packet(message_id="valid-after-surrogate"))
            assert websocket.receive_json() == {"version": 1, "type": "ack", "id": "valid-after-surrogate"}

    assert hub.rooms == {}
    assert hub.active_connections == 0


def test_compact_message_packet_limit_is_enforced_even_for_escaped_text():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            websocket.receive_json()

            oversized = message_packet(message_id="escaped-envelope")
            oversized["body"] = "\u0001" * 4_000
            websocket.send_json(oversized)
            rejected = websocket.receive_json()
            assert rejected["type"] == "error"
            assert rejected["code"] == "message_too_large"
            assert "id" not in rejected
            assert hub.message_store.recent("test-room")[0] == []


def test_compact_incoming_envelope_limit_applies_before_packet_type_validation():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            oversized_join = {**join_packet(), "ignored": "x" * 19_000}
            raw_join = json.dumps(oversized_join, separators=(",", ":"))
            assert len(raw_join.encode("utf-8")) < hub.MAX_FRAME_BYTES
            websocket.send_text(raw_join)
            rejected_join = websocket.receive_json()
            assert rejected_join["code"] == "message_too_large"
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_json()

        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            assert websocket.receive_json()["type"] == "presence"

            oversized_message = {**message_packet(message_id="ignored-extra"), "ignored": "x" * 19_000}
            raw_message = json.dumps(oversized_message, separators=(",", ":"))
            assert len(raw_message.encode("utf-8")) < hub.MAX_FRAME_BYTES
            websocket.send_text(raw_message)
            assert websocket.receive_json()["code"] == "message_too_large"

            oversized_history = {
                "version": 1,
                "type": "history_request",
                "requestId": "large-history-request",
                "room": "test-room",
                "cursor": None,
                "limit": 10,
                "ignored": "x" * 19_000,
            }
            raw_history = json.dumps(oversized_history, separators=(",", ":"))
            assert len(raw_history.encode("utf-8")) < hub.MAX_FRAME_BYTES
            websocket.send_text(raw_history)
            assert websocket.receive_json()["code"] == "message_too_large"


def test_legacy_v2_rows_over_packet_limit_are_pruned_on_replay_and_page():
    store = hub.message_store
    valid = message_packet(message_id="retained-valid")
    oversized = message_packet(message_id="legacy-oversized")
    oversized["body"] = "\u0001" * 4_000
    encoded_oversized = json.dumps(oversized, ensure_ascii=False, separators=(",", ":"))
    assert len(encoded_oversized.encode("utf-8")) > hub.MAX_PROTOCOL_PACKET_BYTES

    with store._connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        connection.execute(
            "INSERT INTO messages(room, message_id, packet, packet_bytes, stored_at) VALUES (?, ?, ?, ?, ?)",
            ("test-room", oversized["id"], encoded_oversized, len(encoded_oversized.encode("utf-8")), hub.time()),
        )
    assert store.store(valid) == "stored"

    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            joined = websocket.receive_json()
            assert joined["historyTruncated"] is True
            replayed = websocket.receive_json()
            assert replayed == valid
            assert websocket.receive_json()["type"] == "presence"
            with store._connect() as connection:
                assert connection.execute(
                    "SELECT COUNT(*) FROM messages WHERE message_id = ?", (oversized["id"],)
                ).fetchone()[0] == 0

            page_oversized = {**oversized, "id": "legacy-page-oversized"}
            page_encoded = json.dumps(page_oversized, ensure_ascii=False, separators=(",", ":"))
            with store._connect() as connection:
                connection.execute(
                    "INSERT INTO messages(room, message_id, packet, packet_bytes, stored_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        "test-room",
                        page_oversized["id"],
                        page_encoded,
                        len(page_encoded.encode("utf-8")),
                        hub.time(),
                    ),
                )
            websocket.send_json({
                "version": 1,
                "type": "history_request",
                "requestId": "legacy-page",
                "room": "test-room",
                "cursor": None,
                "limit": 10,
            })
            page_message = websocket.receive_json()
            completion = websocket.receive_json()
            assert page_message == valid
            assert completion["type"] == "history_page_complete"
            assert completion["messageIds"] == ["retained-valid"]
            assert completion["historyTruncated"] is True
            with store._connect() as connection:
                assert connection.execute(
                    "SELECT COUNT(*) FROM messages WHERE message_id = ?", (page_oversized["id"],)
                ).fetchone()[0] == 0


def test_relay_ack_order_presence_and_disconnect_cleanup():
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        assert sender.receive_json() == {
            "version": 1,
            "type": "joined",
            "room": "test-room",
            "peers": 0,
            "historyTruncated": False,
        }
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="sender-2", name="Peer"))

        assert peer.receive_json() == {
            "version": 1,
            "type": "joined",
            "room": "test-room",
            "peers": 1,
            "historyTruncated": False,
        }
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 1}
        assert peer.receive_json() == {"version": 1, "type": "presence", "peers": 1}

        sender.send_json(message_packet())
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "message-1"}
        assert peer.receive_json() == message_packet()

        peer.close()
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

    assert hub.rooms == {}
    assert hub.active_connections == 0


def test_offline_recipient_gets_durable_room_history_after_joined():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as sender:
            sender.send_json(join_packet())
            assert sender.receive_json()["type"] == "joined"
            assert sender.receive_json()["type"] == "presence"
            sender.send_json(message_packet(message_id="offline-message"))
            assert sender.receive_json() == {"version": 1, "type": "ack", "id": "offline-message"}

        with client.websocket_connect("/ws") as recipient:
            recipient.send_json(join_packet(sender="recipient", name="Recipient"))
            assert recipient.receive_json() == {
                "version": 1,
                "type": "joined",
                "room": "test-room",
                "peers": 0,
                "historyTruncated": False,
            }
            assert recipient.receive_json() == message_packet(message_id="offline-message")
            assert recipient.receive_json() == {"version": 1, "type": "presence", "peers": 0}


def test_room_history_survives_store_recreation(tmp_path, monkeypatch):
    path = tmp_path / "restart.sqlite3"
    first_store = hub.MessageStore(path)
    original = message_packet(message_id="survives-restart")
    assert first_store.store(original) == "stored"
    restarted_store = hub.MessageStore(path)
    assert restarted_store.store(original) == "duplicate"
    assert restarted_store.store({**original, "body": "conflict after restart"}) == "conflict"
    monkeypatch.setattr(hub, "message_store", restarted_store)

    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        assert sender.receive_json()["historyTruncated"] is False
        assert sender.receive_json() == original
        assert sender.receive_json()["type"] == "presence"

        recipient = stack.enter_context(client.websocket_connect("/ws"))
        recipient.send_json(join_packet(sender="recipient", name="Recipient"))
        assert recipient.receive_json()["historyTruncated"] is False
        assert recipient.receive_json() == original
        sender.receive_json()
        recipient.receive_json()

        sender.send_json(original)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "survives-restart"}
        next_message = message_packet(message_id="after-restart-retry")
        sender.send_json(next_message)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "after-restart-retry"}
        assert recipient.receive_json() == next_message


def test_version_one_database_migrates_transactionally(tmp_path):
    path = tmp_path / "version-one.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """CREATE TABLE messages (
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
                history_truncated INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO room_state(room, history_truncated) VALUES ('old-room', 1);
            PRAGMA user_version = 1;"""
        )

    store = hub.MessageStore(path)
    assert store.recent("old-room") == ([], True)
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        columns = {row[1] for row in connection.execute("PRAGMA table_info(room_state)")}
        assert "touched_at" in columns
        assert connection.execute("SELECT marker_overflow FROM store_state WHERE id = 1").fetchone()[0] == 0


def test_duplicate_retry_is_idempotent_and_conflicting_id_is_rejected():
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        sender.receive_json()
        sender.receive_json()
        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="peer", name="Peer"))
        peer.receive_json()
        sender.receive_json()
        peer.receive_json()

        original = message_packet(message_id="retry-me")
        sender.send_json(original)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "retry-me"}
        assert peer.receive_json() == original

        sender.send_json(original)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "retry-me"}

        conflicting = {**original, "body": "different content"}
        sender.send_json(conflicting)
        rejected = sender.receive_json()
        assert rejected["type"] == "error"
        assert rejected["code"] == "message_conflict"
        assert rejected["id"] == "retry-me"
        assert hub.message_store.recent("test-room")[0] == [original]

        cross_sender = message_packet(message_id="retry-me", sender="peer", name="Peer")
        peer.send_json(cross_sender)
        cross_sender_rejected = peer.receive_json()
        assert cross_sender_rejected["code"] == "message_conflict"
        assert cross_sender_rejected["id"] == "retry-me"

        next_message = message_packet(message_id="after-retry")
        sender.send_json(next_message)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "after-retry"}
        assert peer.receive_json() == next_message
        assert hub.message_store.recent("test-room")[0] == [original, next_message]


def test_history_retention_and_replay_are_bounded(tmp_path):
    store = hub.MessageStore(tmp_path / "bounded.sqlite3", replay_limit=2, per_room_limit=3, total_limit=10)
    for index in range(3):
        assert store.store(message_packet(message_id=f"room-a-{index}")) == "stored"
    for index in range(2):
        assert store.store(message_packet(message_id=f"room-b-{index}", room="room-b")) == "stored"

    room_a, truncated_a = store.recent("test-room")
    room_b, truncated_b = store.recent("room-b")
    assert [packet["id"] for packet in room_a] == ["room-a-1", "room-a-2"]
    assert [packet["id"] for packet in room_b] == ["room-b-0", "room-b-1"]
    assert truncated_a is False
    assert truncated_b is False
    with store._connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 5
    page, _, next_cursor, has_more, page_truncated, error = store.history_page("test-room", None, 2)
    assert error is None
    assert [packet["id"] for packet in page] == ["room-a-2", "room-a-1"]
    assert next_cursor == "room-a-1"
    assert has_more is True
    assert page_truncated is False


def test_history_requests_page_newest_first_and_use_message_ids_as_cursors():
    for index in range(5):
        assert hub.message_store.store(message_packet(message_id=f"page-{index}")) == "stored"

    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            for _ in range(5):
                assert websocket.receive_json()["type"] == "message"
            assert websocket.receive_json()["type"] == "presence"

            request = {
                "version": 1,
                "type": "history_request",
                "requestId": "page-request",
                "room": "test-room",
                "cursor": None,
                "limit": 2,
            }
            websocket.send_json(request)
            first = [websocket.receive_json(), websocket.receive_json(), websocket.receive_json()]
            assert [packet["id"] for packet in first[:2]] == ["page-4", "page-3"]
            complete = first[2]
            assert complete == {
                "version": 1,
                "type": "history_page_complete",
                "requestId": "page-request",
                "room": "test-room",
                "messageIds": ["page-4", "page-3"],
                "pageBytes": sum(
                    len(json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                    for packet in first[:2]
                ),
                "nextCursor": "page-3",
                "hasMore": True,
                "historyTruncated": False,
            }

            websocket.send_json({**request, "requestId": "page-request-2", "cursor": "page-3"})
            second = [websocket.receive_json(), websocket.receive_json(), websocket.receive_json()]
            assert [packet["id"] for packet in second[:2]] == ["page-2", "page-1"]
            assert second[2]["nextCursor"] == "page-1"
            assert second[2]["hasMore"] is True

            retry = {**request, "requestId": "retry", "cursor": "page-3"}
            websocket.send_json(retry)
            repeated = [websocket.receive_json(), websocket.receive_json(), websocket.receive_json()]
            assert [packet["id"] for packet in repeated[:2]] == second[2]["messageIds"]
            assert repeated[2]["messageIds"] == second[2]["messageIds"]


def test_history_request_requires_room_membership_and_known_cursor():
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            assert websocket.receive_json()["type"] == "presence"

            websocket.send_json({
                "version": 1,
                "type": "history_request",
                "requestId": "wrong-room",
                "room": "another-room",
                "cursor": None,
                "limit": 10,
            })
            assert websocket.receive_json()["code"] == "not_joined"

            websocket.send_json({
                "version": 1,
                "type": "history_request",
                "requestId": "missing-cursor",
                "room": "test-room",
                "cursor": "pruned-message",
                "limit": 10,
            })
            stale = websocket.receive_json()
            assert stale["code"] == "invalid_cursor"
            assert stale["historyTruncated"] is False


def test_history_request_rate_limit_is_separate_and_bounded(monkeypatch):
    monkeypatch.setattr(hub, "MAX_HISTORY_REQUESTS_PER_MINUTE", 1)
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            assert websocket.receive_json()["type"] == "presence"
            request = {
                "version": 1,
                "type": "history_request",
                "requestId": "first-history-request",
                "room": "test-room",
                "cursor": None,
                "limit": 10,
            }
            websocket.send_json(request)
            first = websocket.receive_json()
            assert first["type"] == "history_page_complete"
            websocket.send_json({**request, "requestId": "second-history-request"})
            limited = websocket.receive_json()
            assert limited["type"] == "error"
            assert limited["code"] == "history_rate_limited"
            assert "id" not in limited


def test_history_page_is_bounded_and_truncation_only_reports_storage_loss():
    for index in range(100):
        packet = message_packet(message_id=f"bounded-{index}")
        packet["body"] = "x" * 7_500
        assert hub.message_store.store(packet) == "stored"
    with sqlite3.connect(hub.message_store.path) as connection:
        connection.execute(
            "UPDATE room_state SET history_truncated = 1 WHERE room = ?", ("test-room",)
        )

    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            for _ in range(100):
                websocket.receive_json()
            assert websocket.receive_json()["type"] == "presence"
            websocket.send_json({
                "version": 1,
                "type": "history_request",
                "requestId": "bounded-page",
                "room": "test-room",
                "cursor": None,
                "limit": 100,
            })
            packets = []
            while True:
                packet = websocket.receive_json()
                if packet["type"] == "history_page_complete":
                    complete = packet
                    break
                packets.append(packet)
            assert 0 < len(packets) <= 100
            assert all(
                len(json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                <= hub.MAX_PROTOCOL_PACKET_BYTES
                for packet in packets
            )
            assert complete["pageBytes"] <= 512 * 1024
            assert complete["pageBytes"] == sum(
                len(json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                for packet in packets
            )
            assert complete["hasMore"] is True
            assert complete["historyTruncated"] is True


def test_byte_retention_and_room_marker_metadata_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(hub, "MAX_TOTAL_STORED_BYTES", 1)
    monkeypatch.setattr(hub, "MAX_TRACKED_ROOMS", 1)
    store = hub.MessageStore(tmp_path / "byte-bounded.sqlite3", total_limit=1)
    assert store.store(message_packet(message_id="first-room", room="first-room")) == "stored"
    assert store.store(message_packet(message_id="second-room", room="second-room")) == "stored"

    packets, truncated = store.recent("third-room")
    assert packets == []
    assert truncated is True
    with store._connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM room_state").fetchone()[0] <= 1
        assert connection.execute("SELECT marker_overflow FROM store_state WHERE id = 1").fetchone()[0] == 1


def test_expired_history_is_removed_and_marked_as_truncated(tmp_path, monkeypatch):
    monkeypatch.setattr(hub, "MESSAGE_RETENTION_SECONDS", 60)
    store = hub.MessageStore(tmp_path / "expired.sqlite3")
    assert store.store(message_packet(message_id="expired-message")) == "stored"
    with store._connect() as connection:
        connection.execute("UPDATE messages SET stored_at = 1")

    packets, truncated = store.recent("test-room")
    assert packets == []
    assert truncated is True


def test_database_failure_does_not_acknowledge_or_relay(monkeypatch):
    class FailedStore:
        def store(self, packet):
            raise sqlite3.OperationalError("disk unavailable")

        def recent(self, room):
            return [], False

    monkeypatch.setattr(hub, "message_store", FailedStore())
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        sender.receive_json()
        sender.receive_json()
        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="peer", name="Peer"))
        peer.receive_json()
        sender.receive_json()
        peer.receive_json()

        sender.send_json(message_packet(message_id="must-not-ack"))
        failure = sender.receive_json()
        assert failure["type"] == "error"
        assert failure["code"] == "storage_unavailable"
        assert failure["id"] == "must-not-ack"
        assert hub.rooms["test-room"]


def test_post_commit_maintenance_failure_keeps_durable_ack_and_fanout(monkeypatch):
    def fail_maintenance(connection):
        raise sqlite3.OperationalError("vacuum failed after commit")

    monkeypatch.setattr(hub.message_store, "_post_commit_maintenance", fail_maintenance)
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        sender.receive_json()
        sender.receive_json()
        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="peer", name="Peer"))
        peer.receive_json()
        sender.receive_json()
        peer.receive_json()

        committed = message_packet(message_id="maintenance-fails")
        sender.send_json(committed)
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "maintenance-fails"}
        assert peer.receive_json() == committed
        assert hub.message_store.recent("test-room")[0] == [committed]


def test_ack_send_failure_does_not_prevent_peer_fanout(monkeypatch):
    original_send_packet = hub.send_packet

    async def fail_ack(client, packet):
        if packet.get("type") == "ack":
            raise asyncio.TimeoutError("injected ACK send timeout")
        await original_send_packet(client, packet)

    monkeypatch.setattr(hub, "send_packet", fail_ack)
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        sender.receive_json()
        sender.receive_json()
        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="peer", name="Peer"))
        peer.receive_json()
        sender.receive_json()
        peer.receive_json()

        committed = message_packet(message_id="ack-send-fails")
        sender.send_json(committed)
        assert peer.receive_json() == committed
        assert hub.message_store.recent("test-room")[0] == [committed]


def test_corrupt_database_is_reported_instead_of_reinitialized(tmp_path):
    path = tmp_path / "corrupt.sqlite3"
    path.write_bytes(b"this is not a sqlite database")
    store = hub.MessageStore(path)
    with pytest.raises(sqlite3.DatabaseError):
        store.recent("test-room")


def test_room_capacity_rejects_extra_member_and_releases_capacity(monkeypatch):
    monkeypatch.setattr(hub, "MAX_ROOM_MEMBERS", 1)
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as first:
            first.send_json(join_packet())
            assert first.receive_json()["type"] == "joined"

            with client.websocket_connect("/ws") as extra:
                extra.send_json(join_packet(sender="sender-2", name="Peer"))
                response = extra.receive_json()
                assert response["type"] == "error"
                assert response["code"] == "capacity_reached"
                with pytest.raises(WebSocketDisconnect):
                    extra.receive_json()

        assert hub.rooms == {}
        assert hub.active_connections == 0


def test_rate_limit_rejects_message_without_relay(monkeypatch):
    monkeypatch.setattr(hub, "MAX_MESSAGES_PER_MINUTE", 1)
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        assert sender.receive_json()["type"] == "joined"
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="sender-2", name="Peer"))
        assert peer.receive_json()["type"] == "joined"
        sender.receive_json()
        peer.receive_json()

        sender.send_json(message_packet(message_id="first"))
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "first"}
        assert peer.receive_json()["id"] == "first"

        sender.send_json(message_packet(message_id="limited"))
        limited = sender.receive_json()
        assert limited["type"] == "error"
        assert limited["code"] == "rate_limited"
        assert limited["id"] == "limited"

        peer.close()
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

    assert hub.rooms == {}
    assert hub.active_connections == 0


def test_sync_control_packets_are_validated_relayed_room_scoped_and_not_stored():
    packets = [
        sync_inventory_packet(),
        {
            "version": 1,
            "type": "sync_missing_request",
            "room": "test-room",
            "syncId": "sync-1",
            "requestId": "request-1",
            "sender": "sender-1",
            "targetSender": "sender-2",
            "messageIds": ["id-a", "id-b"],
        },
        {
            "version": 1,
            "type": "sync_page_complete",
            "room": "test-room",
            "syncId": "sync-1",
            "requestId": "request-1",
            "sender": "sender-2",
            "targetSender": "sender-1",
            "messageIds": ["id-a"],
        },
    ]
    with TestClient(hub.app) as client:
        sender = client.websocket_connect("/ws")
        peer = client.websocket_connect("/ws")
        isolated = client.websocket_connect("/ws")
        with sender, peer, isolated:
            sender.send_json(join_packet())
            assert sender.receive_json()["type"] == "joined"
            sender.receive_json()
            peer.send_json(join_packet(sender="sender-2", name="Peer"))
            assert peer.receive_json()["type"] == "joined"
            peer.receive_json()
            sender.receive_json()
            isolated.send_json(join_packet(room="other-room", sender="other", name="Other"))
            assert isolated.receive_json()["type"] == "joined"
            isolated.receive_json()

            for packet in packets:
                if packet["sender"] == "sender-1":
                    sender.send_json(packet)
                    assert peer.receive_json() == packet
                else:
                    peer.send_json(packet)
                    assert sender.receive_json() == packet

            assert hub.message_store.recent("test-room")[0] == []
            assert hub.message_store.recent("other-room")[0] == []

    assert hub.rooms == {}
    assert len(hub.sync_rate_buckets) == 2

    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as observer:
            observer.send_json(join_packet(sender="observer", name="Observer"))
            assert observer.receive_json()["type"] == "joined"
            assert observer.receive_json()["type"] == "presence"
            assert hub.message_store.recent("test-room")[0] == []


@pytest.mark.parametrize(
    "mutate, expected_code",
    [
        (lambda packet: packet.update(extra="not-allowed"), "invalid_packet"),
        (lambda packet: packet.update(sender="forged-sender"), "invalid_packet"),
        (lambda packet: packet.update(room="other-room"), "not_joined"),
        (lambda packet: packet.update(messageIds=["id-b", "id-a"]), "invalid_packet"),
        (lambda packet: packet.update(nextCursor="id-a"), "invalid_packet"),
        (lambda packet: packet.update(messageIds=["id-a"] * 101), "invalid_packet"),
    ],
)
def test_sync_control_rejects_malformed_unjoined_and_wrong_sender(mutate, expected_code):
    packet = sync_inventory_packet()
    mutate(packet)
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json(join_packet())
            assert websocket.receive_json()["type"] == "joined"
            assert websocket.receive_json()["type"] == "presence"
            websocket.send_json(packet)
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert response["code"] == expected_code
            assert hub.message_store.recent("test-room")[0] == []


def test_sync_control_rate_limit_is_bounded_and_separate(monkeypatch):
    monkeypatch.setattr(hub, "MAX_SYNC_CONTROLS_PER_MINUTE", 1)
    with TestClient(hub.app) as client:
        sender = client.websocket_connect("/ws")
        peer = client.websocket_connect("/ws")
        with sender, peer:
            sender.send_json(join_packet())
            assert sender.receive_json()["type"] == "joined"
            sender.receive_json()
            peer.send_json(join_packet(sender="sender-2", name="Peer"))
            assert peer.receive_json()["type"] == "joined"
            peer.receive_json()
            sender.receive_json()
            packet = sync_inventory_packet()
            sender.send_json(packet)
            assert peer.receive_json() == packet
            sender.send_json({**packet, "syncId": "sync-2"})
            limited = sender.receive_json()
            assert limited["type"] == "error"
            assert limited["code"] == "sync_rate_limited"
            assert "id" not in limited
            assert hub.message_store.recent("test-room")[0] == []


def test_sync_control_configured_rate_limit_allows_2700_packets_per_minute():
    client = hub.Client(websocket=None, room="test-room", sender="sender-1", sender_name="Sender")
    assert hub.MAX_SYNC_CONTROLS_PER_MINUTE == 2_700
    assert all(hub.consume_sync_control(client) for _ in range(2_700))
    assert not hub.consume_sync_control(client)
    assert len(hub.sync_rate_buckets) == 1


def test_sync_control_rate_limit_survives_reconnect_and_bucket_count_is_bounded(monkeypatch):
    monkeypatch.setattr(hub, "MAX_SYNC_CONTROLS_PER_MINUTE", 1)
    monkeypatch.setattr(hub, "MAX_SYNC_RATE_BUCKETS", 1)
    with TestClient(hub.app) as client:
        with client.websocket_connect("/ws") as first:
            first.send_json(join_packet())
            assert first.receive_json()["type"] == "joined"
            assert first.receive_json()["type"] == "presence"
            first.send_json(sync_inventory_packet())

        assert hub.rooms == {}
        assert len(hub.sync_rate_buckets) == 1
        assert ("test-room", "sender-1") in hub.sync_rate_buckets

        with client.websocket_connect("/ws") as reconnect:
            reconnect.send_json(join_packet())
            assert reconnect.receive_json()["type"] == "joined"
            assert reconnect.receive_json()["type"] == "presence"
            reconnect.send_json({**sync_inventory_packet(), "syncId": "sync-2"})
            rejected = reconnect.receive_json()
            assert rejected["type"] == "error"
            assert rejected["code"] == "sync_rate_limited"

        with client.websocket_connect("/ws") as new_sender:
            new_sender.send_json(join_packet(sender="sender-2", name="Sender Two"))
            assert new_sender.receive_json()["type"] == "joined"
            assert new_sender.receive_json()["type"] == "presence"
            new_sender.send_json(sync_inventory_packet(sender="sender-2"))
            rejected_for_capacity = new_sender.receive_json()
            assert rejected_for_capacity["type"] == "error"
            assert rejected_for_capacity["code"] == "sync_rate_limited"
            assert len(hub.sync_rate_buckets) == 1
