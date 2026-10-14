# Native platform readiness

**Assessment date:** 2026-10-14

**Status:** Readiness assessment only. NearLink has no native application yet.

## Current project state

The repository contains a React and TypeScript browser application in
`apps/web`, a protocol package in `packages/protocol`, and Rust crates in
`crates/protocol-core` and `crates/protocol-wasm`. The core validates protocol
v1 JSON structures, bounded in-memory message reconciliation, and synchronization
inventory/request state. The WASM facade exposes these APIs to JavaScript.
Generated browser bindings are built by the checked-in script. The browser uses
Rust/WASM for packet validation, bounded inventory sequence acceptance, and
bounded request/completion validation and tracking. TypeScript retains
pending-request bookkeeping and owns IndexedDB access, accepted message
snapshots, missing-ID selection and batching, transport sends,
persist-before-completion verification, rate budgets, and UI state. The Rust
`MessageIndex` is in-memory and is not persistent browser storage. Neither crate
implements identity or encryption. There is no Tauri configuration, Tauri
dependency, native UI, platform adapter, or Android project in the repository.

The browser UI currently uses browser facilities directly. For example,
`apps/web/src/App.tsx` reads and writes `localStorage`, and the storage and
WebRTC modules rely on browser APIs. That code is not a native adapter layer.
The portable-core direction in
[`ADR 0002`](../architecture/adr/0002-portable-core.md) remains an architecture
decision, not completed platform support.

## Local environment observations

These observations were collected on the assessment date. They describe this
development host only.

| Area | Observed state | Meaning |
| --- | --- | --- |
| Rust | `rust-toolchain.toml` pins 1.84.1. The local Rust compiler and Cargo report 1.84.1. | The installed target list contains `x86_64-unknown-linux-gnu` and `wasm32-unknown-unknown`. Android targets are not installed. |
| Android SDK | `$HOME/Android/Sdk` exists with platforms 31, 34, and 35, build-tools versions 29.0.2, 31.0.0, 34.0.0, 35.0.0, and 35.0.1, plus command-line tools and platform-tools. | Some SDK components are present. This does not establish that a NearLink Android project builds. |
| ADB | The SDK-local `platform-tools/adb` executable reports version 35.0.2. It is not on the shell `PATH`. An ADB device listing showed no connected devices. | Physical-device validation was not available in this check. |
| Android emulators | The SDK emulator lists `Medium_Phone_API_35` and `Pixel_2_API_35`. | Emulator definitions exist. They have not been used to build or exercise NearLink. |
| Android NDK | No `$HOME/Android/Sdk/ndk` directory was found. `NDK_HOME` and `ANDROID_HOME` are unset in the current shell. | Tauri Android prerequisites are incomplete in this shell. |
| Java | OpenJDK 17.0.20 is installed. `JAVA_HOME` is unset in the current shell. | Java is available, but the Android build environment is not configured as Tauri documents. |
| Tauri | No Tauri dependency or configuration was found in the project manifests. No `tauri` executable is on `PATH`. | Tauri is only a possible route discussed for future implementation, not a selected or working app stack. |
| Linux desktop webview dependencies | `pkg-config` could not find `webkit2gtk-4.1` or `gtk+-3.0`. OpenSSL 3.0.2 was found. | This host does not currently satisfy the checked Tauri Linux desktop dependency probes. |

The checks above did not install or change packages. The Rust version checks
used the already installed toolchain directly to avoid triggering rustup
network synchronization.

## Tauri prerequisites if that framework is selected

Tauri remains an option, not a decision. Its current v2 prerequisite guide
lists Rust and operating-system dependencies for desktop builds. On Linux, the
documented dependency set includes WebKitGTK 4.1 and GTK-related development
packages. The checks above found WebKitGTK 4.1 and GTK development metadata
unavailable through `pkg-config` on this host. A working desktop build would
also need the project to add and pin Tauri dependencies and configuration.

For Android, Tauri's v2 guide calls for Android Studio, a configured JDK via
`JAVA_HOME`, Android SDK platform, platform-tools, NDK side by side, build-tools,
command-line tools, `ANDROID_HOME` and `NDK_HOME`, and Rust Android targets. The
host has some SDK components, Java, ADB, and emulator definitions, but no NDK,
no Android Rust targets, and no configured Android environment variables.
These components are prerequisites to resolve before attempting a Tauri Android
build. No Android build has been attempted as part of this assessment.

Tauri's setup instructions are maintained at
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/). Recheck
that upstream guide when implementation begins because its supported versions
and platform requirements can change.

## Adapter boundaries before native implementation

Keep protocol behavior independent of the UI and transport. Define stable
interfaces before moving the browser implementation into a native shell:

- **Protocol core:** parse and validate shared message envelopes, apply
  transport-independent state transitions, and expose behavior through a
  versioned interface. Expand the current structural validator only after
  concrete behavior and security requirements are reviewed.
- **Storage adapter:** browser persistence remains in browser storage. A native
  implementation needs a separately reviewed local database, migration,
  backup, and data-deletion policy. Storage APIs must not leak into protocol
  rules.
- **Transport adapter:** the hub WebSocket client and direct peer transport
  need a shared application-facing contract. Browser `RTCPeerConnection`
  cannot be assumed to be available with the same behavior through a native
  webview or native networking implementation.
- **Platform adapter:** permissions, notifications, background execution,
  network changes, and lifecycle handling belong in platform-specific code.
  They must not become requirements for the transport-independent protocol.
- **UI:** React can be reused only if the selected native shell's webview
  behavior and required browser APIs are supported and verified. A shared UI
  does not imply shared storage, network, or lifecycle semantics.

Avoid adding a native shell that merely embeds the current browser UI and then
describing NearLink as a supported native client. The behavior and platform
limitations must be tested on the actual target.

## Readiness gates

### Shared code and boundary gate

- Identify the message and synchronization behavior that belongs in the
  portable core, then implement it with documented input and output contracts.
  The browser's current Rust/WASM synchronization state covers bounded
  inventory sequencing and bounded request/completion validation; TypeScript
  also retains pending-request bookkeeping. This does not move persistence or
  transport I/O into Rust.
- Keep native storage, UI, permissions, background lifecycle, and transport I/O
  behind explicit adapters.
- Run the same protocol vectors and state-transition cases through the browser
  implementation and the portable core. Add interoperability tests before
  replacing browser behavior.
- Select and review the native framework, dependency versions, supported
  operating systems, data location, update path, and signing process.

### Desktop gate

- Build and package on every operating system that will be named as supported.
- Verify installation, upgrade, uninstall, data retention and deletion, and
  local hub address configuration on a clean user profile.
- Exercise room history, reconnect, direct connection setup, permission and
  network failures, and application restart using real desktop installations.
- Record OS version, app build, test steps, results, and known limitations.

### Android gate

- Pin and document JDK, SDK, NDK, Android API, Rust target, and build-tool
  versions. Produce a reproducible debug build before distribution work.
- Install and upgrade on physical Android devices. Check first launch,
  persistence, permission prompts, airplane mode, local-network changes,
  screen lock, app backgrounding, process termination, and restart.
- Test hub and direct connection behavior between at least two physical
  devices on representative networks. Emulator-only results do not establish
  radio, local-network, NAT, sleep, or background behavior on phones.
- Check release signing, update and rollback behavior, data deletion, and
  Android version compatibility before calling any Android version supported.

### Release evidence gate

For each claimed platform, attach a build record and a manual device record to
the release checklist. Automated host tests do not substitute for installed
application checks. Do not claim end-to-end encryption or emergency-grade
reliability from a native build, an emulator run, or a shared portable core.

## Current decision

Native readiness is **not established**. The repository has a Rust protocol
validator, bounded in-memory reconciliation and synchronization-state APIs, a
tested WebAssembly binding used by the browser, and an existing browser
prototype, but no native application or
platform adapters. Android SDK pieces are present on this host, but the NDK,
Android Rust targets, environment configuration, and connected device are
missing. Linux Tauri webview dependencies were not found by the checks above.
Treat desktop and Android support as pending until the relevant readiness and
release gates have recorded successful evidence.
