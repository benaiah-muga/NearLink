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
- A station setup selector for up to 10 valid recent room codes, stored locally
  on the device. The selected room remains the last-selected room after reload.
  These codes are routing values and do not identify or verify participants.
- Local hub messaging over WebSocket. The hub can keep bounded SQLite room
  history and replay recent messages when clients reconnect.
- Bounded message-ID reconciliation runs over the joined local hub relay or a
  confirmed direct WebRTC session. It exchanges at most 4,096 accepted local
  IDs per inventory and requests missing ordinary messages in batches of 100.
  Large hub exchanges can take many minutes because message replies are paced
  under the relay's message budget. Transfers are bounded to 4,096 IDs per
  inventory. Rate-limit contention or unavailable messages can leave an
  exchange partial, especially in large rooms with many peer inventories;
  reconnecting restarts from messages saved on the device.
- Direct browser peer messaging over a WebRTC data channel after manually
  exchanging signaling JSON and comparing the full session fingerprint through
  a separate trusted channel.
- Queued outgoing messages, retry controls, connection status, and bounded
  history warnings.
- A per-room control to delete that room's saved and queued messages from the
  current browser. The local identity and settings stay saved. The action does
  not delete hub-retained history, which may replay after reconnecting.
- The hub operator can inspect and purge hub history offline with the local
  history commands. They use the configured `NEARLINK_HUB_DB_PATH`, or
  `nearlink-hub.sqlite3` in the current directory. They report retained counts
  and truncation state. Purging history makes a room report
  `historyTruncated` and prevents the hub from replaying those deleted rows.
  It does not remove copies already saved by browser clients or peers, and
  SQLite file remnants may remain. This is not secure erasure.

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

On first use, the station setup panel explains the three values to enter:
choose a call sign that participants will see, agree on the same shared room
code, and enter the WebSocket address provided by the local hub operator.
These values are saved on the device. Call signs and room codes do not verify
who a participant is.

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
   Hub message packets are paced below the hub's 120-per-minute connection
   limit and the next queued packet waits for the current packet's acceptance ACK.
   The live scheduler holds at most 64 pending hub entries. Larger persisted
   outboxes refill in batches as each batch drains; older saved messages stay
   ahead of newly composed messages, which remain queued until their turn.
   Synchronization packets
   fail the current exchange if the scheduler is full, so the app does not
   report a skipped sync packet as complete.
   If the hub does not acknowledge a message within 10 seconds, the app
   reconnects and retries the same saved ID. A rate-limited message remains
   queued on this device while the app reconnects before retrying it.
5. Disconnect one browser, send a test message from the other, then reconnect.
   The hub replays its joined-room messages first. Use **Load older messages**
   to request retained pages, and confirm each page appears in the hub's
   accepted order. The next page uses the oldest ID from the previous page as
   its exclusive boundary. Page retries reuse that boundary and deduplicate
   messages already saved on the device. The app warns when history may have a
   retention gap. History is bounded and can expire or be evicted.
6. Reload each page and confirm which messages remain on that device.

If NearLink says the hub is not reachable, check that the hub process is
running, both devices can reach its host on the local network, and the address
uses that host's LAN address and the `/ws` path. An HTTPS app page may block a
plain `ws://` address. Ask the hub operator for a browser-permitted secure
address when that happens. Messages remain saved on the device while the app
retries; correct the address and save the setup again if needed.

Older history pages require a hub with versioned history support. If the app
reports that the hub does not support history pages, update the local hub before
trying this step. A failed page save can be retried without moving its cursor.

The hub stores plaintext in its local SQLite database. Anyone who can read that
database can read message contents. Protect it as sensitive data and use only
test content during beta.

## Join with a direct peer link

Manual direct peer setup is an optional advanced path in the station controls.
It remains available when hub access is not being used, but requires the
participants to exchange signaling data and compare fingerprints through a
separate authenticated channel. Follow these steps only when that is the
intended setup.

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

The direct adapter holds at most 64 pending entries and 1 MiB of queued payload,
and keeps the channel buffer at or below 256 KiB. Its 64 KiB low-water value is
the idle default. When the FIFO head does not fit in the remaining buffer space,
the adapter adjusts the low-water event threshold to the amount of buffered data
at which that payload fits, then restores the default after the queue drains. If
the adapter queue is full, the message keeps its saved ID and exposes Retry.
Closing or failing the link drops only adapter memory; messages without a peer
acceptance remain saved locally. Local enqueue into the adapter does not mark a
message accepted. Only the peer's ACK after local save changes the sender's
delivery state.

This is a host-only ICE configuration with no public STUN or TURN service. A
direct connection may fail across networks, NATs, firewalls, VPNs, or browser
policies. The fingerprint comparison verifies the current DTLS session only. It
does not establish a durable device identity or prove who controls the device.
Signaling JSON can reveal network addressing information. Share it privately
and do not attach it to bug reports.

## Compatibility and verification status

The most recent completed CI run before the NL-52 compatibility journey used
source commit
[`15762bce371e9d93f69423e8ce603c31a5000c6e`](https://github.com/benaiah-muga/NearLink/commit/15762bce371e9d93f69423e8ce603c31a5000c6e)
and successful GitHub Actions run
[`38812980383`](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383).
The run used Ubuntu 24.04, Node 24, and Playwright's Chromium, Firefox, and
WebKit projects. It passed both `verify` and `security-audit`, but predates the
NL-52 real-hub browser journey below. In local production-build checks on
2026-10-16, the NL-52 journey passed in Chromium and Firefox. WebKit could not
launch on this development host because `libavif13` is missing. The NL-52 CI
result is pending. These automated checks do not establish support for a named
operating system, physical device, browser release, or network configuration.

| Target or behavior | Current evidence | Status |
| --- | --- | --- |
| Production build and foundation checks | CI run [38812980383](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383), source commit [`15762bce`](https://github.com/benaiah-muga/NearLink/commit/15762bce371e9d93f69423e8ce603c31a5000c6e), passed `npm run verify:all`, the production build, protocol checks, and `test:wasm`. | Automated CI passed on the recorded commit. This is not a release artifact or device sign-off, and the run predates NL-52. |
| Chromium production E2E | CI run [38812980383](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383) passed the production E2E suite on Chromium. It includes queued-message persistence, layout, hub history paging, a real local hub conversation, direct WebRTC between browser contexts, and service-worker offline emulation with hub resume. The NL-52 local-hub compatibility journey also passed locally in Chromium on 2026-10-16. | Automated Chromium coverage passed. Browser contexts run on one host, not on two physical devices. The current CI run predates NL-52. |
| Firefox and WebKit persistence | CI run [38812980383](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383) passed one persistence-across-reload smoke in each Playwright engine. The path saves a profile and queued message, reloads, and checks that both remain. | Automated engine smokes passed. This is not Firefox or Safari release support, mobile support, or OS sign-off. Playwright WebKit does not replace testing Safari on Apple devices. |
| Production local-hub compatibility journey | The NL-52 journey opens two independent contexts in the selected Playwright engine, connects to the checked-in local hub, verifies hub ACK and recipient IndexedDB persistence, disconnects a recipient while sending, and checks reconnect replay is duplicate-free. Non-loopback HTTP and WebSocket requests are blocked. Local runs passed in Chromium and Firefox on 2026-10-16. The WebKit run could not launch because this host lacks `libavif13`; NL-52 CI is pending. | Automated same-host engine coverage only. It does not establish two-device LAN behavior, physical browser support, or Safari support. |
| Automated accessibility checks | Chromium E2E invokes axe scans on selected setup, diagnostics, queue, deletion, narrow viewport, and history states, using WCAG 2.0 A/AA, WCAG 2.1 A/AA, and WCAG 2.2 AA tags. Those scans passed in CI run [38812980383](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383). | Automated axe coverage only. It is not a complete accessibility audit or manual assistive-technology review. |
| Unit and simulated DOM UI behavior | `npm run verify:all` passed in CI run [38812980383](https://github.com/benaiah-muga/NearLink/actions/runs/38812980383). The app UI tests run in jsdom and use test storage setup. | Automated unit and simulated DOM UI coverage passed. It does not prove real browser, operating system, or device behavior. |
| Chromium on a named desktop OS or physical device | CI runs Playwright Chromium on Ubuntu 24.04. No actual end-user OS or device acceptance record is included. | Pending manual OS and device acceptance. |
| Chromium Android, installed and browser modes | No physical Android device check or installation record is included. | Pending. No Android support claim. |
| Safari on macOS and iOS, installed and browser modes | WebKit engine smoke only; no real Safari, Apple OS, or device acceptance record is included. | Pending. No Safari or Apple device support claim. |
| Firefox desktop or Microsoft Edge desktop | Firefox engine persistence smoke only; no release browser or OS acceptance record is included. No Edge run is recorded. | Pending manual acceptance. No Firefox or Edge support claim. |
| Local hub, same-network two-device exchange without internet | CI exercises a local hub with two browser contexts on one host. No physical two-device LAN run or offline-from-internet acceptance record is included. | Pending two-device acceptance. |
| Hub reconnect, replay, and bounded history | Chromium E2E covers local hub acceptance, replay, persistence, and history paging on the CI host. No physical-device or operator recovery record is included. | Automated flow passed; manual runtime and operator checks pending. |
| Direct WebRTC between separate physical devices | Chromium E2E covers a direct session between browser contexts on the CI host. No physical two-device or cross-browser acceptance record is included. | Pending device acceptance. |
| Direct WebRTC across separate networks | The app uses host-only ICE candidates and no public STUN or TURN service. | Not a beta expectation. |
| PWA installation and offline shell | Chromium E2E verifies the production service worker shell using browser network-offline emulation, reloads the saved conversation, and resumes the hub after restoring network access. No installed PWA or browser installation matrix is recorded. | Automated Chromium offline-shell flow passed; installation and device checks pending. |
| Accessibility and responsive behavior on actual devices | Automated axe scans and Chromium viewport assertions cover selected UI states. No independent assistive-technology or physical-device review is recorded. | Manual review pending. |
| Controlled technical beta readiness | The [release record checklist](release/README.md) requires a dated candidate record, named reviewers, and actual two-device hub and direct acceptance. No completed candidate record is included. | Not ready to describe as a controlled technical beta. |

Do not convert a pending row to verified based on simulated DOM tests,
browser-engine automation, a developer assumption, or a successful build. A
future release record must include the exact tested app commit, linked run,
browser and version, operating system and version, device, test date, network
setup, and named reviewer. The present CI evidence is tied to the source commit
and run linked above; it is not a manual acceptance record.

## Diagnostics and feedback

When reporting a problem, include only information needed to reproduce it.
Never include message bodies, room codes, call signs, identity IDs, signaling
JSON, full fingerprints, screenshots containing conversation content, or hub
database files. These values can reveal private content, local network
addresses, or persistent identifiers.

The app's **Connection diagnostics** disclosure provides an optional summary of
allowlisted hub, direct peer, protocol, and browser storage states. When the
selected conversation is loaded and stable, it also includes message counts
from that room's local rows. Counts are hidden while the conversation loads or
changes. The summary excludes message content and station or room details. Use
the copy button to copy it, or select the visible text area and copy manually
if clipboard access is unavailable.

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
- Hub message packets are stored as plaintext in the operator's local SQLite
  database. The offline history commands can count retained messages and delete
  one room or all hub rows. A purge preserves a truncation marker so clients can
  distinguish an empty room from history that the hub removed. The marker does
  not restore deleted messages. Deleted rows may remain in SQLite pages, WAL
  files, backups, or other copies, so the command is not a secure erase.
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
- Message reconciliation uses untrusted IDs and peer-provided inventories, so
  it cannot prove message authorship or that a conversation is complete. It
  stops on conflicting session data or storage failure and restarts from new
  inventories after a reconnect.
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
