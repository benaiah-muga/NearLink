# NearLink

NearLink is an open-source, local-first messaging project. Its goal is to let people exchange messages over a reachable local network without requiring internet access.

The first local messaging slice provides a browser client and an optional local hub. It does not claim end-to-end encryption, WebRTC peer connections, or emergency-grade reliability. Those capabilities require separate implementation and review.

## Project layout

- `apps/web`: React and TypeScript browser application.
- `services/local-hub`: FastAPI WebSocket hub.
- `docs`: architecture, protocol, security, and contributor documentation.

## Development

Requirements: Node.js 20.19 or newer, npm, Python 3.11 or newer, and a browser with IndexedDB and WebSocket support.

```sh
npm ci
npm run dev
```

Create a production web bundle with `npm run build`.

Run the local hub in a second terminal:

```sh
cd services/local-hub
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000 --ws-max-size 32768
```

The browser client defaults to `ws://<current-host>:8000/ws` and includes an editable hub address. On another device, enter the computer's local network address, such as `ws://192.168.1.20:8000/ws`. Browser mixed-content restrictions can prevent an HTTPS page from connecting to an unsecured `ws://` hub.

The local hub must be reachable from both devices. The browser application itself can be opened offline after its shell has been cached by a successful visit or PWA installation. The hub is not a durable message store, so incoming messages sent while a device is disconnected are not replayed later.

## Product status

This is an early development project. Local network communication depends on users being able to reach the same hub. Messages and identities are local browser data, and the hub relays plaintext in this initial proof of concept. Do not use it for sensitive communication.

See [the architecture overview](docs/architecture/overview.md), [protocol draft](docs/protocol/v1-draft.md), [threat model](docs/security/threat-model.md), and [contributing guide](CONTRIBUTING.md).
