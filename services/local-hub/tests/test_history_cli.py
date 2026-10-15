from __future__ import annotations

import os
import sqlite3
import stat
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


def test_backup_includes_committed_wal_data_and_is_owner_only(tmp_path):
    source = tmp_path / "history.sqlite3"
    populated_store(source)
    writer = sqlite3.connect(source)
    writer.execute("PRAGMA wal_autocheckpoint = 0")
    writer.execute("UPDATE room_state SET history_truncated = 1 WHERE room = 'room-b'")
    writer.commit()
    wal_path = Path(f"{source}-wal")
    assert wal_path.exists() and wal_path.stat().st_size > 0

    destination = tmp_path / "snapshot.sqlite3"
    summary = hub.backup_retained_history(source, destination)
    assert summary.message_count == 3
    assert summary.room_count == 2
    assert summary.truncated_room_count == 1
    assert summary.marker_overflow is False
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert hub.list_retained_history(destination) == [
        ("room-a", 2, False),
        ("room-b", 1, True),
    ]
    with sqlite3.connect(destination) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert hub.list_retained_history(source) == hub.list_retained_history(destination)
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []
    writer.close()


@pytest.mark.parametrize(
    "destination_kind",
    ["existing", "symlink", "same", "parent_symlink", "parent_symlink_dotdot", "unsafe_parent"],
)
def test_backup_rejects_unsafe_destination_paths_without_touching_source(tmp_path, destination_kind):
    source = tmp_path / "history.sqlite3"
    populated_store(source)
    before = source.read_bytes()
    if destination_kind == "existing":
        destination = tmp_path / "existing.sqlite3"
        destination.write_text("keep me")
    elif destination_kind == "symlink":
        destination = tmp_path / "link.sqlite3"
        destination.symlink_to(source)
    elif destination_kind == "same":
        destination = source
    elif destination_kind == "unsafe_parent":
        unsafe_parent = tmp_path / "unsafe"
        unsafe_parent.mkdir()
        unsafe_parent.chmod(0o777)
        destination = unsafe_parent / "snapshot.sqlite3"
    else:
        real_parent = tmp_path / "real"
        real_parent.mkdir()
        linked_parent = tmp_path / "linked"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        destination = linked_parent / ".." / "snapshot.sqlite3" if destination_kind.endswith("dotdot") else linked_parent / "snapshot.sqlite3"

    with pytest.raises(ValueError, match="symbolic link|already exists|source database|writable by other users"):
        hub.backup_retained_history(source, destination)

    assert source.read_bytes() == before
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []
    if destination_kind == "existing":
        assert destination.read_text() == "keep me"


def test_backup_rejects_missing_source_without_creating_output(tmp_path):
    source = tmp_path / "missing.sqlite3"
    destination = tmp_path / "snapshot.sqlite3"

    with pytest.raises(ValueError, match="existing regular file"):
        hub.backup_retained_history(source, destination)

    assert not destination.exists()
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []


def test_backup_rejects_symlinked_source_component_before_parent_traversal(tmp_path):
    real_parent = tmp_path / "real"
    child = real_parent / "child"
    child.mkdir(parents=True)
    source_target = real_parent / "history.sqlite3"
    populated_store(source_target)
    source_link = tmp_path / "source-link"
    source_link.symlink_to(child, target_is_directory=True)
    source = source_link / ".." / "history.sqlite3"
    destination = tmp_path / "snapshot.sqlite3"

    with pytest.raises(ValueError, match="source database path"):
        hub.backup_retained_history(source, destination)

    assert not destination.exists()


def test_backup_rejects_unsupported_source_without_creating_output(tmp_path):
    source = tmp_path / "unsupported.sqlite3"
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA user_version = 99")
        connection.execute("CREATE TABLE keep_me(value TEXT)")
        connection.execute("INSERT INTO keep_me VALUES ('untouched')")
    before = source.read_bytes()
    destination = tmp_path / "snapshot.sqlite3"

    with pytest.raises(ValueError, match="schema version"):
        hub.backup_retained_history(source, destination)

    assert source.read_bytes() == before
    assert not destination.exists()
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []


def test_backup_cleans_temporary_output_when_snapshot_verification_fails(tmp_path, monkeypatch):
    source = tmp_path / "history.sqlite3"
    populated_store(source)
    before = source.read_bytes()
    destination = tmp_path / "snapshot.sqlite3"
    original = hub._history_backup_counts
    calls = 0

    def mismatched_counts(connection):
        nonlocal calls
        calls += 1
        counts = original(connection)
        return counts if calls == 1 else (counts[0] + 1, *counts[1:])

    monkeypatch.setattr(hub, "_history_backup_counts", mismatched_counts)
    with pytest.raises(ValueError, match="retained history does not match"):
        hub.backup_retained_history(source, destination)

    assert source.read_bytes() == before
    assert not destination.exists()
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []


def test_backup_removes_published_output_when_directory_sync_fails(tmp_path, monkeypatch):
    source = tmp_path / "history.sqlite3"
    populated_store(source)
    before = source.read_bytes()
    destination = tmp_path / "snapshot.sqlite3"
    original_fsync = hub.os.fsync
    calls = 0

    def fail_directory_sync(descriptor):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected directory sync failure")
        return original_fsync(descriptor)

    monkeypatch.setattr(hub.os, "fsync", fail_directory_sync)
    with pytest.raises(OSError, match="directory sync failure"):
        hub.backup_retained_history(source, destination)

    assert source.read_bytes() == before
    assert not destination.exists()
    assert list(tmp_path.glob(".snapshot.sqlite3.*")) == []


def test_backup_cli_reports_counts_without_message_contents(tmp_path):
    source = tmp_path / "history.sqlite3"
    populated_store(source)
    destination = tmp_path / "snapshot.sqlite3"
    env = {**os.environ, "NEARLINK_HUB_DB_PATH": str(source)}
    script = Path(__file__).resolve().parents[1] / "main.py"

    result = subprocess.run(
        [sys.executable, str(script), "history", "backup", "--output", str(destination)],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )

    assert "Retained rows: 3; room markers: 2;" in result.stdout
    assert "hello" not in result.stdout
    assert "Backup created:" in result.stdout
