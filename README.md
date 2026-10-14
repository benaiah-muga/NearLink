# NearLink

NearLink is an open-source, local-first messaging project. Its goal is to let people exchange messages over a reachable local network without requiring internet access.

The current prototype provides browser messaging through an optional local hub and a manually signaled direct WebRTC path. It does not claim reviewed end-to-end encryption or emergency-grade reliability. See the product status and security notes below.

## Project layout

- `apps/web`: React and TypeScript browser application.
- `services/local-hub`: FastAPI WebSocket hub.
- `docs`: architecture, protocol, security, and contributor documentation.

## Development

Requirements: Node.js 20 or newer, npm, Python 3.11 or newer, and a browser with IndexedDB and WebSocket support.

```sh
npm ci
npm run dev
```

Create a production web bundle with `npm run build`.

Run the complete local verification after installing the Python test dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r services/local-hub/requirements-dev.lock
npm run verify:foundation
```

The foundation checks build the web client, run the local hub tests, and check tracked and non-ignored project files for em dash characters. See [local verification](docs/engineering/verification.md) for setup details.

Run the local hub in a second terminal:

```sh
cd services/local-hub
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000 --ws-max-size 32768
```

The browser client defaults to `ws://<current-host>:8000/ws` and includes an editable hub address. On another device, enter the computer's local network address, such as `ws://192.168.1.20:8000/ws`. Browser mixed-content restrictions can prevent an HTTPS page from connecting to an unsecured `ws://` hub.

The local hub must be reachable from both devices. The browser application itself can be opened offline after its shell has been cached by a successful visit or PWA installation. The hub keeps bounded local history in SQLite and replays retained room messages when a client joins. History is limited by age, message count, database size, and per-join replay caps. Older messages can be discarded, and the client warns when replay was truncated. This is not a recipient-specific delivery guarantee. Messages and identities are plaintext, and hub rooms are unauthenticated.

For direct communication, both browser clients can exchange WebRTC offer and answer text out of band, then compare the complete DTLS fingerprint over a separate trusted channel before sending. The comparison identifies only the current connection certificate. It does not prove a person or a persistent device identity. The direct path currently uses host ICE candidates only, so it is limited to network paths reachable without a configured STUN or TURN server. Real-device interoperability remains to be validated.

## Product status

This is an early development project. Local network communication depends on users being able to reach the same hub. The hub stores and relays plaintext in its bounded local history. Direct WebRTC data is also not end-to-end encrypted by an application messaging protocol. Browser storage can be cleared or evicted. Do not use NearLink for sensitive communication or emergency coordination.

See [the architecture overview](docs/architecture/overview.md), [protocol draft](docs/protocol/v1-draft.md), [threat model](docs/security/threat-model.md), and [contributing guide](CONTRIBUTING.md).
