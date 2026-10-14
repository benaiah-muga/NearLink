# NearLink

NearLink is an open-source, local-first messaging project. Its goal is to let people exchange messages over a reachable local network without requiring internet access.

The first milestone establishes a browser client and an optional local hub. It does not claim end-to-end encryption, WebRTC peer connections, or emergency-grade reliability. Those capabilities require separate implementation and review.

## Project layout

- `apps/web`: React and TypeScript browser application.
- `services/local-hub`: FastAPI WebSocket hub.
- `docs`: architecture, protocol, security, and contributor documentation.

## Development

Requirements: Node.js 20 or newer, npm, and Python 3.11 or newer.

```sh
npm install
npm run dev
```

Run the local hub in a second terminal:

```sh
cd services/local-hub
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn nearlink_hub.main:app --reload --host 0.0.0.0 --port 8765
```

The browser client defaults to `ws://localhost:8765/ws`. Set `VITE_NEARLINK_HUB_URL` to a reachable hub WebSocket URL when connecting from another device. Browser mixed-content restrictions can prevent an HTTPS page from connecting to an unsecured `ws://` hub.

## Product status

This is an early development project. Local network communication depends on users being able to reach the same hub. Messages and identities are local browser data, and the hub relays plaintext in this initial proof of concept. Do not use it for sensitive communication.

See [the architecture overview](docs/architecture/overview.md), [protocol draft](docs/protocol/v1-draft.md), [threat model](docs/security/threat-model.md), and [contributing guide](CONTRIBUTING.md).
