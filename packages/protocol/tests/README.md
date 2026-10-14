# Protocol v1 test vectors

The shared vectors in `../vectors/v1.json` define the current version 1 packet boundary and run in both the TypeScript validator tests and the native Rust protocol-core tests. They cover valid join, message, joined, acknowledgment, presence, and error packets, plus invalid identifiers, rooms, timestamps, and message bodies.

The Rust crate is pinned to Rust 1.84.1 and uses `serde_json` for parsed JSON values. CI cross-compiles it for `wasm32-unknown-unknown`, but the crate has no JavaScript binding and no browser runtime or interoperability test. The local environment used for the current development run only has the native Linux target installed. The crate is not `no_std` and does not implement cryptography, authentication, or transport behavior.

Protocol identifiers accept 1 to 128 ASCII characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Rooms accept 1 to 64 ASCII characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Display names contain 1 to 64 non-whitespace Unicode code points. Message bodies must contain non-whitespace text and fit within 16 KiB when encoded as UTF-8.

For well-formed Unicode strings, the shared validator uses the same edge whitespace set as Python `str.strip()` in `services/local-hub/main.py`: U+0009 through U+000D, U+001C through U+0020, U+0085, U+00A0, U+1680, U+2000 through U+200A, U+2028, U+2029, U+202F, U+205F, and U+3000. In particular, U+001C through U+001F are whitespace in Python, while U+FEFF, U+180E, and U+001B are not. The tests cover both sets on display names and message bodies.

The shared validator rejects unpaired UTF-16 surrogates in display names and bodies before UTF-8 byte counting. The local hub rejects the same values in display names and message bodies. A malformed body is reported as `invalid_packet`, and the websocket remains usable for subsequent valid packets.

Version compatibility is exact: validators accept only numeric `version: 1`. A different version, a string version, a boolean version, or an unknown packet type is rejected. A future protocol version must add an explicit validator and compatibility decision rather than being accepted by the version 1 validator.

Timestamps use the local hub's accepted ISO 8601 subset: a date, `T`, seconds, an optional fraction of one to three decimal digits, and either `Z` or a numeric timezone offset. Invalid calendar dates and timestamps without an offset are rejected.
