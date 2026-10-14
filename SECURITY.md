# Security policy

## Supported versions

Only the latest published release and the current `main` branch are supported for security fixes while the project is in active development.

## Reporting a vulnerability

Do not report vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository. Include affected versions or commits, impact, reproduction steps, and any suggested mitigation. Avoid including real user data or secrets.

If private vulnerability reporting is unavailable, contact the maintainers using the contact information displayed on the repository profile and ask for a private reporting channel.

Maintainers will acknowledge reports within seven days, investigate with the reporter, and coordinate a fix and disclosure timeline. This response target is an operational goal, not a guarantee of resolution time.

## Current security status

The current prototype relays plaintext. Room identifiers do not authenticate participants. It has no end-to-end encryption and must not be used for sensitive or emergency communication. See [the threat model](docs/security/threat-model.md).

Do not submit exploit code that targets systems or people without permission. Security reports should use a minimal reproduction in a controlled environment.
