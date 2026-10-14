# Protocol v1 test vectors

The executable vectors in `protocol.test.ts` define the current version 1 packet boundary. They cover valid join, message, joined, acknowledgment, presence, and error packets, plus invalid identifiers, rooms, timestamps, and message bodies.

Protocol identifiers accept 1 to 128 ASCII characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Rooms accept 1 to 64 ASCII characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Display names contain 1 to 64 non-whitespace Unicode code points. Message bodies must contain non-whitespace text and fit within 16 KiB when encoded as UTF-8.

For well-formed Unicode strings, the shared validator uses the same edge whitespace set as Python `str.strip()` in `services/local-hub/main.py`: U+0009 through U+000D, U+001C through U+0020, U+0085, U+00A0, U+1680, U+2000 through U+200A, U+2028, U+2029, U+202F, U+205F, and U+3000. In particular, U+001C through U+001F are whitespace in Python, while U+FEFF, U+180E, and U+001B are not. The tests cover both sets on display names and message bodies.

The shared validator rejects unpaired UTF-16 surrogates in display names and bodies before UTF-8 byte counting. The local hub rejects the same values in display names and message bodies. A malformed body is reported as `invalid_packet`, and the websocket remains usable for subsequent valid packets.

Version compatibility is exact: validators accept only numeric `version: 1`. A different version, a string version, a boolean version, or an unknown packet type is rejected. A future protocol version must add an explicit validator and compatibility decision rather than being accepted by the version 1 validator.

Timestamps use the local hub's accepted ISO 8601 subset: a date, `T`, seconds, an optional fraction of one to three decimal digits, and either `Z` or a numeric timezone offset. Invalid calendar dates and timestamps without an offset are rejected.
