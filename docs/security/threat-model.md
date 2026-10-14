# Initial threat model

## Scope

The first prototype connects browser clients to a local FastAPI WebSocket hub. It supports plain text room messaging.

## Assets

- Message contents and local conversation history.
- Local display names and room membership.
- Availability of the local hub and connected clients.

## Threats and limits

- A participant on the same network may observe or alter unencrypted WebSocket traffic.
- The hub operator can read relayed message contents.
- Room codes can be guessed or shared and do not authenticate participants.
- Malformed or excessive traffic may affect service availability.
- Browser storage can be cleared or evicted.

This prototype makes no confidentiality, verified identity, forward secrecy, durable delivery, or emergency availability guarantee. Do not use it for sensitive messages. A reviewed end-to-end encryption design and security review are required before secure messaging claims.
