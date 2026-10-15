# Security policy

## Supported versions

Only the latest published release and the current `main` branch are supported for security fixes while the project is in active development.

## Reporting a vulnerability

GitHub private vulnerability reporting is enabled for this repository (verified 2026-10-15). Use the repository's [Report a vulnerability flow](https://github.com/benaiah-muga/NearLink/security/advisories/new) to send a report privately. Do not post vulnerability details in public issues, discussions, pull requests, or other public channels.

If private reporting becomes unavailable, open a GitHub issue titled `Maintainer contact request` with only this message: `Please provide a private channel for a security report. I have not included report details here.` This request lets a maintainer contact you without disclosing report details publicly. Do not include affected versions or commits, impact, reproduction steps, vulnerable components or endpoints, proof-of-concept code, payloads, exploit instructions, screenshots, logs, personal data, or secrets in that issue. Do not attach files. Once a maintainer provides a private channel, send the report there.

Maintainers will acknowledge reports within seven days, investigate with the reporter, and coordinate a fix and disclosure timeline. This response target is an operational goal, not a guarantee of resolution time.

The repository owner must keep GitHub private vulnerability reporting enabled and verify that the reporting option is available to repository users before controlled beta.

## Current security status

The current prototype relays plaintext. Room identifiers do not authenticate participants. It has no end-to-end encryption and must not be used for sensitive or emergency communication. See [the threat model](docs/security/threat-model.md).

Do not submit exploit code that targets systems or people without permission. Provide a minimal reproduction only through a private reporting channel and only for a controlled environment.
