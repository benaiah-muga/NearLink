from __future__ import annotations

import json
import sys
from contextlib import ExitStack
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as hub  # noqa: E402


@pytest.fixture(autouse=True)
def empty_hub_state():
    assert hub.rooms == {}
    assert hub.active_connections == 0
    yield
    assert hub.rooms == {}
    assert hub.active_connections == 0


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


@pytest.mark.parametrize(
    "packet",
    [
        None,
        {"version": True, "type": "join", "room": "room", "sender": "s", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "bad room", "sender": "s", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "room", "sender": "bad sender!", "senderName": "Name"},
        {"version": 1, "type": "join", "room": "room", "sender": "s", "senderName": "  "},
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


def test_relay_ack_order_presence_and_disconnect_cleanup():
    with TestClient(hub.app) as client, ExitStack() as stack:
        sender = stack.enter_context(client.websocket_connect("/ws"))
        sender.send_json(join_packet())
        assert sender.receive_json() == {"version": 1, "type": "joined", "room": "test-room", "peers": 0}
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

        peer = stack.enter_context(client.websocket_connect("/ws"))
        peer.send_json(join_packet(sender="sender-2", name="Peer"))

        assert peer.receive_json() == {"version": 1, "type": "joined", "room": "test-room", "peers": 1}
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 1}
        assert peer.receive_json() == {"version": 1, "type": "presence", "peers": 1}

        sender.send_json(message_packet())
        assert sender.receive_json() == {"version": 1, "type": "ack", "id": "message-1"}
        assert peer.receive_json() == message_packet()

        peer.close()
        assert sender.receive_json() == {"version": 1, "type": "presence", "peers": 0}

    assert hub.rooms == {}
    assert hub.active_connections == 0


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
