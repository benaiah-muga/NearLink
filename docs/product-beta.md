# NearLink controlled beta guide

Status: preparation guide for a controlled technical beta. This is not a public
release authorization. The compatibility work and real-device checks listed
below remain open until a release record links to evidence.

NearLink is an early local-first messaging prototype. This guide helps a small
group exercise the current browser client, optional local hub, and manual direct
peer path without mistaking those features for a dependable or secure service.

## Who should participate

Use this beta only with people who understand that software and device checks
are incomplete and can report problems without sharing message contents. Use
test messages and a non-sensitive room code. Do not rely on NearLink for urgent,
confidential, or otherwise sensitive communication.

## What is available to try

- A browser client that saves a local call sign, room selection, and message
  history in browser storage.
- Local hub messaging over WebSocket. The hub can keep bounded SQLite room
  history and replay recent messages when clients reconnect.
- Direct browser peer messaging over a WebRTC data channel after manually
  exchanging signaling JSON and comparing the full session fingerprint through
  a separate trusted channel.
- Queued outgoing messages, retry controls, connection status, and bounded
  history warnings.

The local hub ACK means that the hub accepted a message into its local store. It
does not mean another participant received or read it. Direct peer acceptance
means the peer application saved that message on its device. It does not mean
the person read it. Neither status is a delivery guarantee while a device is
offline.

## Before a session

1. Choose two devices on a network you control. For a hub session, both must be
   able to reach the same hub. For a direct session, both must have browser
   support for WebRTC data channels and a network path that permits the direct
   connection.
2. Use a current browser with JavaScript, IndexedDB, WebSocket, and WebRTC
   support. Installable PWA behavior also depends on the browser and a secure
   application origin. Localhost is treated specially by browsers; ordinary
   HTTP LAN addresses are not equivalent to HTTPS origins.
3. Decide who operates the local hub. The operator can read plaintext messages
   and must protect the hub's data directory. See the [hub operating notes](../services/local-hub/README.md).
4. Pick a disposable room code and test-only content. Room codes route traffic
   and do not authenticate participants.
5. For a direct session, arrange a separate authenticated channel for
   comparing fingerprints. Do not use the same signaling exchange as the
   fingerprint comparison.

## Join with the local hub

1. Start the hub on a device reachable from both clients. Follow the hub's
   [local run instructions](../services/local-hub/README.md).
2. Open NearLink in each browser. Enter a call sign, the shared room code, and
   the hub's WebSocket URL. Use the host's LAN address on the second device,
   for example `ws://192.168.1.20:8000/ws` when the page's security context
   permits that connection. An HTTPS app origin may block an unsecured `ws://`
   connection as mixed content. In that case, the hub must be reachable through
   `wss://` or the app must use another browser-permitted secure setup.
3. Save or join the room on both devices and confirm that each shows the other
   participant in the connected count.
4. Send short test messages in both directions. The sender should see hub
   acceptance; the recipient should see the message after saving it locally.
5. Disconnect one browser, send a test message from the other, then reconnect.
   Confirm what history is replayed and whether the app warns that older history
   may be missing. History is bounded and can expire or be evicted.
6. Reload each page and confirm which messages remain on that device.

The hub stores plaintext in its local SQLite database. Anyone who can read that
database can read message contents. Protect it as sensitive data and use only
test content during beta.

## Join with a direct peer link

1. Set the call sign and same room on both devices. Direct signaling does not
   require joining the hub.
2. On the initiating device, choose **Create offer** and share the complete
   signaling JSON with the other participant using a channel you control.
3. On the other device, paste the offer and choose **Accept offer**. Share the
   generated answer back to the initiating device.
4. On the initiating device, paste the answer and choose **Accept answer**.
   Wait for both browsers to report a connected direct channel.
5. Each participant must compare the complete displayed DTLS fingerprint with
   the peer's value through the separate trusted channel, then confirm the
   comparison in the app. If the values differ, close the link and do not send
   a test message over it.
6. Choose **Direct peer** as the send transport and exchange test messages.
   The sender should see peer acceptance only after the receiving application
   saves the message locally.
7. Close the direct link and confirm that unaccepted outgoing messages remain
   queued on the sending device.

This is a host-only ICE configuration with no public STUN or TURN service. A
direct connection may fail across networks, NATs, firewalls, VPNs, or browser
policies. The fingerprint comparison verifies the current DTLS session only. It
does not establish a durable device identity or prove who controls the device.
Signaling JSON can reveal network addressing information. Share it privately
and do not attach it to bug reports.

## Compatibility and verification status

The table distinguishes automated software coverage from runtime verification.
Automated tests and a successful bundle build do not prove that an actual
browser, operating system, network, or device works. Record browser version,
operating system, test date, network setup, and the linked run or test evidence
before changing a row to verified.

| Target or behavior | Current evidence | Status |
| --- | --- | --- |
| TypeScript production bundle | Build command is part of the repository verification workflow. | Automated check available; latest run must be linked in the release record. |
| Browser application behavior | Unit and UI tests run in a simulated DOM with browser storage test support. | Automated coverage only; no real-browser verification is recorded here. |
| Chromium desktop | No browser-specific release run or manual smoke-test evidence is recorded here. | Pending |
| Chromium Android, installed and browser modes | No physical Android device check is recorded here. | Pending |
| Safari on macOS and iOS, installed and browser modes | No real Safari or Apple device check is recorded here. | Pending |
| Firefox desktop | No real Firefox release run is recorded here. | Pending |
| Microsoft Edge desktop | No real Edge release run is recorded here. | Pending |
| Local hub, same-network two-device exchange without internet | Automated hub and client tests cover parts of the flow. No physical two-device run is recorded here. | Pending device check |
| Hub reconnect, replay, and bounded history | Automated hub and client tests cover persistence, replay, and related failure handling. | Automated checks available; runtime and operator recovery check pending |
| Direct WebRTC, same reachable local network | Automated transport and app-flow tests cover connection behavior. No cross-browser two-device run is recorded here. | Pending device check |
| Direct WebRTC across separate networks | No public STUN or TURN service is configured. | Not supported as a beta expectation |
| PWA installation and offline shell | Service worker and install affordance exist in the client. No browser installation matrix is recorded here. | Pending browser checks |
| Accessibility and responsive layout | Automated UI assertions may catch regressions, but no independent assistive technology or device review is recorded here. | Pending manual review |

Do not convert a pending row to verified based on a simulated DOM test, a
developer's assumption, or a successful build. The release record must include
the exact tested app commit and test conditions.

## Diagnostics and feedback

When reporting a problem, include only information needed to reproduce it.
Never include message bodies, room codes, call signs, identity IDs, signaling
JSON, full fingerprints, screenshots containing conversation content, or hub
database files. These values can reveal private content, local network
addresses, or persistent identifiers.

### Feedback checklist

- App version or source commit, plus whether this was a packaged build or a
  development server.
- Browser name and full version, operating system version, and device class.
- Network arrangement: same Wi-Fi, hotspot, wired LAN, VPN, or separate
  networks. Do not include public or private IP addresses.
- Transport selected: local hub or direct peer.
- Hub operator arrangement and whether the hub process was running, without
  sharing its address or database.
- Expected result and actual result, with the approximate time and the steps
  immediately before the issue.
- Whether either page was reloaded, backgrounded, disconnected, or reconnected.
- A screenshot only after confirming that it contains no message text,
  identifiers, room codes, fingerprints, or network addresses.
- Whether the issue repeats with fresh test call signs and a new test room.

### Safe diagnostic summary

If requested by a maintainer, provide a manually prepared summary containing:

```text
App commit or release:
Browser and version:
Operating system and version:
Transport: hub or direct
Network arrangement:
Connection state observed:
Message state observed: queued, accepted by hub, accepted by peer, or failed
Approximate time and timezone:
Reproduction steps:
Sensitive values removed: yes
```

Do not paste browser storage exports, raw WebSocket frames, console logs, SDP,
fingerprints, or hub database contents unless a maintainer has established a
specific safe process and the data has been reviewed for sensitive values.

## Privacy and security limits

- The hub transport uses WebSocket and message envelopes are plaintext. A hub
  operator and anyone with access to stored SQLite history can read them.
- Room codes and call signs do not authenticate people or devices. Other room
  participants can impersonate a display name.
- Hub history is bounded and may be deleted by age or storage limits. A hub ACK
  confirms hub acceptance, not peer receipt or reading.
- Browser IndexedDB and local settings are stored on the device. Browser data
  clearing, profile removal, storage eviction, device loss, or local access by
  another person may expose or erase them.
- Direct WebRTC uses a DTLS protected data channel, but NearLink has no reviewed
  end-to-end encryption protocol or durable identity system. Fingerprint
  comparison is a manual check for one live session. Endpoints still hold
  plaintext.
- Direct links use host-only ICE candidates and have no public STUN or TURN
  relay. Connectivity is limited to network paths those candidates can reach.
- Signaling data and network metadata should be treated as sensitive. Message
  acceptance indicators do not establish reading or availability.
- NearLink has no validated emergency service level, guaranteed availability,
  background delivery guarantee, or independently audited cryptographic
  integration.

Use ordinary test messages only. Keep another dependable communication method
available during every beta exercise.

## Beta acceptance criteria

A candidate may be described as ready for a **controlled technical beta** only
when all applicable items below have an evidence link and a named reviewer in
the [release record](release/README.md):

1. A clean checkout at the recorded commit installs from the lockfile and
   passes the repository foundation verification.
2. The production web bundle is built from that same commit and its checksum is
   recorded with the release artifact.
3. At least one actual two-device, same-network hub run exchanges messages in
   both directions with internet access disabled. The run also checks local
   persistence, hub restart, replay behavior, and a history truncation warning
   or records why truncation could not be induced.
4. At least one actual two-device direct run completes manual offer and answer
   exchange, verifies matching fingerprints through a separate authenticated
   channel, exchanges messages in both directions, and checks local persistence
   after reload. Record browser and network details.
5. Every browser and platform named as supported has a completed compatibility
   record. Anything untested remains explicitly unsupported or pending.
6. A privacy and security reviewer confirms that beta materials disclose
   plaintext hub storage, identity limits, direct-network limits, local data
   behavior, and the lack of emergency-grade reliability.
7. Feedback instructions are available and a maintainer can triage a report
   without collecting message content, signaling JSON, or persistent identity
   values.

These criteria authorize only a controlled technical beta with informed
participants. They do not authorize a secure messaging claim, sensitive use,
or emergency use. Public release requires the separate security and release
gates in the repository's security documentation.
