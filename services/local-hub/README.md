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

The hub relays the three sync-v1 control packet types
(`sync_inventory_page`, `sync_missing_request`, and `sync_page_complete`) to
other active sockets in the same joined room. It requires each packet's room
and sender to match the connection's join, validates the packet shape, and
limits controls to 2,700 per minute per `(room, sender)` pair, about 45 per
second. Rate history survives socket disconnects until its 60-second window expires, with a fixed
maximum of 256 tracked pairs. Controls are ephemeral: they are not
acknowledged, stored, or replayed as chat history.
When the control limit is reached, the hub returns `sync_rate_limited`.
Room and sender values are routing claims only. The hub does not authenticate
participants or the inventories they send, and hub relays remain plaintext.

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

## Inspect and purge local history

From the repository root, stop the hub before performing maintenance, or use
the command when the database is available for a short write transaction. These
offline commands operate on the existing database selected by
`NEARLINK_HUB_DB_PATH`, or on
`nearlink-hub.sqlite3` in the current directory when the variable is unset:

```sh
python services/local-hub/main.py history list
python services/local-hub/main.py history purge --room ROOM_CODE
python services/local-hub/main.py history purge --all
python services/local-hub/main.py history backup --output /secure/local/path/nearlink-history.sqlite3
```

The list reports retained message counts and whether history may be incomplete.
Purging one room or all rooms deletes matching message rows in a transaction
and keeps a truncation marker so joining clients are not told the history is
complete. The hub will no longer replay purged rows. Purging does not remove
copies already stored by browsers or peers. The data is plaintext, and SQLite
pages, WAL or SHM files, and backups may retain recoverable copies. This is not
secure erasure. Protect the database and backups as message content.

The backup command uses SQLite's backup API to include committed data in a
live WAL. It requires a new output path in an existing trusted directory,
writes the working copy inside a private owner-only temporary directory,
checks integrity, supported schema, retained row counts, and truncation
markers, then publishes the snapshot atomically. It rejects path components
that are symbolic links and directories writable by other users unless the
sticky bit protects their entries. It prints counts and marker state only,
never message contents. Stop the hub for routine maintenance and before
restoring a snapshot.

Backups contain plaintext packets and are as sensitive as the live database.
Restrict access to their directory, review them under the same retention
schedule as message history, and remove expired copies through the normal
filesystem process. File deletion does not promise secure erasure.

To restore a snapshot, stop the hub, confirm `NEARLINK_HUB_DB_PATH`, and keep a
protected rollback copy of the active database with its `-wal` and `-shm`
sidecars. Move the active database and sidecars out of the active directory,
copy the chosen snapshot to the configured database path, and restrict it to
owner access. Start the hub and run `history list` to confirm counts and
truncation markers. The CLI has no restore command. Treat rollback copies as
plaintext message data and remove them under the normal retention process.

Connect clients to `ws://127.0.0.1:8000/ws`. Each connection must send a valid
version 1 `join` packet first. The hub responds with `joined`, which carries a
`historyTruncated` boolean, replays up to 100 recent room messages in sequence
order, then broadcasts `presence`. The boolean reports history removed by a
storage cap or retention expiry. It does not mean more retained rows are
available. If the bounded room marker table overflows, the hub sets this flag
conservatively for all rooms. A global delivery lock orders history snapshots
and live relays.

Joined room members can request more retained history with a version 1 packet
shaped like `{"version":1,"type":"history_request","requestId":"req-1","room":"room-code","cursor":null,"limit":100}`.
The limit must be from 1 to 100. A null cursor starts at the newest retained
message; a later cursor is the oldest message ID already loaded. The hub sends
ordinary `message` packets from newest to oldest, then one
`history_page_complete` packet. Its ordered `messageIds` identify only the page
packets, `pageBytes` counts their compact UTF-8 JSON envelopes, `nextCursor` is
the oldest page message ID when `hasMore` is true, and `historyTruncated` reports
retention or storage loss independently of `hasMore`. Each message packet is
limited to 18 KiB, and a page is limited to 100 packets and 512 KiB total.
History requests are limited to 30 per connection per minute. A rejected
request returns `history_rate_limited`.

`requestId` is a correlation value, not a server-side pagination session. A
retry with a null cursor starts from the newest retained edge again and may
include newer messages accepted since the first request. A retry with a
non-null cursor returns the same older slice while that cursor and its older
rows remain retained. Clients should deduplicate messages by ID before saving
or advancing the cursor. If retention removes a cursor row, the hub returns an
`invalid_cursor` error with the current `historyTruncated` state; clients should
restart from a null cursor and deduplicate already saved IDs.

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
and each connection to 120 messages per minute. Message throttling returns
`rate_limited`. Sends to a slow client time out after two seconds. Local
history expires after 30 days, with at most 200 messages per room, 2,000
messages and 32 MiB of message data globally, a
64 MiB SQLite database, and 100 replayed messages per join. Old history is
deleted to honor those limits, and `historyTruncated` signals that a room's
history has a gap. Room codes use letters, digits, `_`, and `-`, with a maximum
of 64 characters.
