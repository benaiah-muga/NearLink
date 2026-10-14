# NearLink local hub

This optional FastAPI service relays the version 1 NearLink JSON packets over
WebSockets. It keeps room membership in process memory and removes a client
when its WebSocket disconnects. It does not persist messages or provide
durable delivery.

Messages are plaintext. Room codes provide routing only and do not authenticate
participants. This service does not provide end-to-end encryption or emergency
grade reliability.

## Run locally

From this directory, create and activate a Python virtual environment, then
install the documented dependencies:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.lock
uvicorn main:app --host 127.0.0.1 --port 8000 --ws-max-size 32768
```

Connect clients to `ws://127.0.0.1:8000/ws`. Each connection must send a valid
version 1 `join` packet first. The hub responds with `joined`, then broadcasts
`presence`. Valid `message` packets are relayed to other room members, and the
sender receives an `ack` after the hub accepts the packet for relay. That
acknowledgment does not confirm recipient storage or reading.

The hub caps incoming WebSocket frames at 32 KiB and message bodies at 16 KiB.
It limits each room to 32 active clients, the process to 64 rooms or 256 clients,
and each connection to 120 messages per minute. Sends to a slow client time out
after two seconds. Acknowledgments are sent before best-effort room fan-out, so
they still mean hub acceptance only. Room codes use letters, digits, `_`, and
`-`, with a maximum of 64 characters.
