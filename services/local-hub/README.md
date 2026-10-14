# NearLink local hub

This optional FastAPI service relays version 1 NearLink JSON packets over
WebSockets. Room membership is in process memory. Messages are stored in a
local SQLite database and recent room history is replayed to each joining
client after its `joined` packet.

Messages are plaintext. Room codes provide routing only and do not authenticate
participants. The hub does not provide end-to-end encryption or emergency
grade reliability. Anyone with access to the database files can read message
contents. Protect the data directory and remove its database, WAL, and SHM files
when deleting local history.

## Run locally

From this directory, create and activate a Python virtual environment, then
install the documented dependencies:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.lock
uvicorn main:app --host 127.0.0.1 --port 8000 --ws-max-size 32768
```

The database defaults to `nearlink-hub.sqlite3` in the current working
directory. Set `NEARLINK_HUB_DB_PATH` to choose another local path. Keep the
database on local storage. The schema uses SQLite `user_version` migrations;
unsupported, incomplete, or corrupt databases fail closed and are not reset.
New database directories are created with owner-only access and the database
and SQLite sidecar files are restricted to the owner. For backups, use SQLite's
online backup API or stop the hub and copy the database with its `-wal` and
`-shm` files. Copying only the main database while the hub is running can omit
committed data.

Connect clients to `ws://127.0.0.1:8000/ws`. Each connection must send a valid
version 1 `join` packet first. The hub responds with `joined`, which carries a
`historyTruncated` boolean, replays up to 100 recent room messages in sequence
order, then broadcasts `presence`. The boolean tells a client that some earlier
room history was removed by a cap or retention expiry. If the bounded room
marker table overflows, the hub sets this flag conservatively for all rooms. A
global delivery lock makes the history snapshot and transition to live relay
ordered across rooms.

Valid `message` packets are durably committed before the sender receives an
`ack`. This confirms local hub storage only. It does not confirm recipient
storage or reading. A duplicate `(room, id)` with the same normalized packet
gets an ACK without another live fan-out. Reusing that key for different
content returns `message_conflict`. This deduplication guarantee lasts only
while the original row is retained. After its age, room, or global storage limit
evicts the row, the hub no longer has that ID record. If storage fails or
reaches its disk cap, the hub returns `storage_unavailable` without
acknowledging the message.

The hub caps incoming WebSocket frames at 32 KiB and message bodies at 16 KiB.
It limits each room to 32 active clients, the process to 64 rooms or 256 clients,
and each connection to 120 messages per minute. Sends to a slow client time out
after two seconds. Local history expires after 30 days, with at most 200
messages per room, 2,000 messages and 32 MiB of message data globally, a
64 MiB SQLite database, and 100 replayed messages per join. Old history is
deleted to honor those limits, and `historyTruncated` signals that a room's
history has a gap. Room codes use letters, digits, `_`, and `-`, with a maximum
of 64 characters.
