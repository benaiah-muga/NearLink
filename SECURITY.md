# Security policy

## Supported versions

Only the latest published release and the current `main` branch are supported for security fixes while the project is in active development.

## Reporting a vulnerability

GitHub private vulnerability reporting is currently disabled for this repository (checked 2026-10-15). Do not post vulnerability details in public issues, discussions, pull requests, or other public channels.

Until private reporting is enabled, open a GitHub issue titled `Maintainer contact request` with only this message: `Please provide a private channel for a security report. I have not included report details here.` This request lets a maintainer contact you without disclosing that information publicly. Do not include affected versions or commits, impact, reproduction steps, vulnerable components or endpoints, proof-of-concept code, payloads, exploit instructions, screenshots, logs, personal data, or secrets in that issue. Do not attach files. Once a maintainer provides a private channel, send the report there.

Maintainers will acknowledge reports within seven days, investigate with the reporter, and coordinate a fix and disclosure timeline. This response target is an operational goal, not a guarantee of resolution time.

Before controlled beta, the repository owner must enable GitHub private vulnerability reporting and verify that the reporting option is available to repository users.

## Current security status

The current prototype relays plaintext. Room identifiers do not authenticate participants. It has no end-to-end encryption and must not be used for sensitive or emergency communication. See [the threat model](docs/security/threat-model.md).

Do not submit exploit code that targets systems or people without permission. Security reports should use a minimal reproduction in a controlled environment.
