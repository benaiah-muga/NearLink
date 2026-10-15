from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as hub  # noqa: E402


def packet(room: str, message_id: str) -> dict:
    return {
        "version": 1,
        "type": "message",
        "id": message_id,
        "room": room,
        "sender": "sender-1",
        "senderName": "Sender",
        "createdAt": "2026-10-14T12:00:00Z",
        "body": "hello",
    }


def populated_store(path: Path) -> hub.MessageStore:
    store = hub.MessageStore(path)
    assert store.store(packet("room-a", "a-1")) == "stored"
    assert store.store(packet("room-a", "a-2")) == "stored"
    assert store.store(packet("room-b", "b-1")) == "stored"
    return store


def test_list_reports_counts_and_truncation(tmp_path):
    store = populated_store(tmp_path / "history.sqlite3")
    with store._connect() as connection:
        connection.execute("UPDATE room_state SET history_truncated = 1 WHERE room = 'room-b'")

    assert hub.list_retained_history(store.path) == [
        ("room-a", 2, False),
        ("room-b", 1, True),
    ]


def test_selective_purge_preserves_other_room_and_truncation_after_restart(tmp_path):
    path = tmp_path / "history.sqlite3"
    populated_store(path)

    assert hub.purge_retained_history(path, room="room-a") == 2
    restarted = hub.MessageStore(path)
    assert restarted.recent("room-a") == ([], True)
    assert restarted.recent("room-b") == ([packet("room-b", "b-1")], False)
    assert hub.list_retained_history(path) == [
        ("room-a", 0, True),
        ("room-b", 1, False),
    ]


def test_purge_all_and_repeated_purge_are_idempotent(tmp_path):
    path = tmp_path / "history.sqlite3"
    populated_store(path)

    assert hub.purge_retained_history(path) == 3
    assert hub.purge_retained_history(path) == 0
    restarted = hub.MessageStore(path)
    assert restarted.recent("room-a") == ([], True)
    assert restarted.recent("room-b") == ([], True)
    assert hub.list_retained_history(path) == [
        ("room-a", 0, True),
        ("room-b", 0, True),
    ]


def test_purge_unknown_valid_room_sets_marker(tmp_path):
    path = tmp_path / "history.sqlite3"
    hub.MessageStore(path).store(packet("existing", "existing-1"))
    assert hub.purge_retained_history(path, room="new-room") == 0
    assert hub.list_retained_history(path) == [
        ("existing", 1, False),
        ("new-room", 0, True),
    ]


def test_purge_unknown_rooms_keeps_marker_table_bounded(tmp_path):
    import sqlite3

    path = tmp_path / "history.sqlite3"
    hub.MessageStore(path).recent("initialize")
    with sqlite3.connect(path) as connection:
        connection.executemany(
            "INSERT INTO room_state(room, history_truncated, touched_at) VALUES (?, 1, ?)",
            ((f"old-room-{index}", index) for index in range(hub.MAX_TRACKED_ROOMS)),
        )

    assert hub.purge_retained_history(path, room="new-room") == 0
    with sqlite3.connect(path) as connection:
        marker_count = connection.execute("SELECT COUNT(*) FROM room_state").fetchone()[0]
        marker_overflow = connection.execute("SELECT marker_overflow FROM store_state WHERE id = 1").fetchone()[0]

    assert marker_count == hub.MAX_TRACKED_ROOMS
    assert marker_overflow == 1


def test_invalid_database_path_is_not_created(tmp_path):
    missing = tmp_path / "missing" / "history.sqlite3"
    with pytest.raises(ValueError, match="existing regular file"):
        hub.list_retained_history(missing)
    with pytest.raises(ValueError, match="existing regular file"):
        hub.purge_retained_history(missing)
    assert not missing.parent.exists()


def test_symlink_database_path_is_rejected(tmp_path):
    real_path = tmp_path / "real.sqlite3"
    hub.MessageStore(real_path).recent("room")
    link_path = tmp_path / "link.sqlite3"
    link_path.symlink_to(real_path)
    with pytest.raises(ValueError, match="symbolic link"):
        hub.purge_retained_history(link_path)


def test_admin_accepts_sqlite_optimizer_statistics(tmp_path):
    path = tmp_path / "analyzed.sqlite3"
    populated_store(path)
    import sqlite3

    with sqlite3.connect(path) as connection:
        connection.execute("ANALYZE")

    assert hub.list_retained_history(path) == [
        ("room-a", 2, False),
        ("room-b", 1, False),
    ]
    assert hub.purge_retained_history(path, room="room-a") == 2


def test_unsupported_or_incomplete_schema_is_rejected_without_reset(tmp_path):
    path = tmp_path / "unsupported.sqlite3"
    import sqlite3

    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 99")
        connection.execute("CREATE TABLE keep_me(value TEXT)")
        connection.execute("INSERT INTO keep_me VALUES ('untouched')")

    with pytest.raises(ValueError, match="schema version"):
        hub.purge_retained_history(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT value FROM keep_me").fetchone() == ("untouched",)

    incomplete = tmp_path / "incomplete.sqlite3"
    with sqlite3.connect(incomplete) as connection:
        connection.execute("PRAGMA user_version = 2")
        connection.execute("CREATE TABLE messages(room TEXT)")
        connection.execute("CREATE TABLE room_state(room TEXT)")
        connection.execute("CREATE TABLE store_state(id INTEGER)")
    with pytest.raises(ValueError, match="incompatible shape"):
        hub.purge_retained_history(incomplete)

    incompatible = tmp_path / "incompatible.sqlite3"
    with sqlite3.connect(incompatible) as connection:
        connection.execute("PRAGMA user_version = 2")
        connection.execute("CREATE TABLE messages(sequence INTEGER PRIMARY KEY, room TEXT NOT NULL, message_id TEXT NOT NULL, packet TEXT NOT NULL, packet_bytes INTEGER NOT NULL, stored_at REAL NOT NULL)")
        connection.execute("CREATE TABLE room_state(room TEXT PRIMARY KEY, history_truncated INTEGER NOT NULL DEFAULT 0, touched_at REAL NOT NULL)")
        connection.execute("CREATE TABLE store_state(id INTEGER PRIMARY KEY, marker_overflow INTEGER NOT NULL DEFAULT 0)")
        connection.execute("INSERT INTO store_state(id, marker_overflow) VALUES (1, 0)")
        connection.execute("INSERT INTO messages(room, message_id, packet, packet_bytes, stored_at) VALUES ('room', 'keep', '{}', 2, 1)")

    with pytest.raises(ValueError, match="message identity index is missing"):
        hub.purge_retained_history(incompatible)
    with sqlite3.connect(incompatible) as connection:
        assert connection.execute("SELECT message_id FROM messages").fetchall() == [("keep",)]


def test_cli_uses_configured_database_and_reports_counts_and_purge(tmp_path):
    path = tmp_path / "history.sqlite3"
    populated_store(path)
    env = {**os.environ, "NEARLINK_HUB_DB_PATH": str(path)}
    script = Path(__file__).resolve().parents[1] / "main.py"

    listed = subprocess.run(
        [sys.executable, str(script), "history", "list"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    assert "room-a\t2\tfalse" in listed.stdout
    purged = subprocess.run(
        [sys.executable, str(script), "history", "purge", "--room", "room-a"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    assert "Purged 2 message(s) from room room-a." in purged.stdout
    assert "does not securely erase" in purged.stdout


def test_cli_rejects_missing_database_without_creating_it(tmp_path):
    missing = tmp_path / "missing" / "history.sqlite3"
    env = {**os.environ, "NEARLINK_HUB_DB_PATH": str(missing)}
    script = Path(__file__).resolve().parents[1] / "main.py"

    result = subprocess.run(
        [sys.executable, str(script), "history", "list"],
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 2
    assert "existing regular file" in result.stderr
    assert not missing.parent.exists()


def test_cli_rejects_unsupported_database_without_modifying_it(tmp_path):
    import sqlite3

    path = tmp_path / "unsupported-cli.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 99")
        connection.execute("CREATE TABLE keep_me(value TEXT)")
        connection.execute("INSERT INTO keep_me VALUES ('untouched')")
    env = {**os.environ, "NEARLINK_HUB_DB_PATH": str(path)}
    script = Path(__file__).resolve().parents[1] / "main.py"

    result = subprocess.run(
        [sys.executable, str(script), "history", "purge", "--all"],
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 2
    assert "unsupported hub database schema version" in result.stderr
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT value FROM keep_me").fetchone() == ("untouched",)
