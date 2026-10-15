# Contributing

NearLink is developed in the open. Keep changes focused, document protocol or architecture changes, and describe known limitations clearly.

## Local setup

See the root README for the web client and local hub setup.

## Change guidelines

- Follow `AGENTS.md` and preserve the no em dash project rule.
- Keep UI, protocol, storage, and transport responsibilities separate.
- Validate all data received over network boundaries.
- Do not describe the current prototype as end-to-end encrypted.
- Include user-visible failure and offline states for communication changes.
- Use conventional commit messages and commit completed milestones.

## Security reports

GitHub private vulnerability reporting is currently disabled for this repository (checked 2026-10-15). Do not post vulnerability details in public issues, discussions, pull requests, or other public channels.

Until private reporting is enabled, open a GitHub issue titled `Maintainer contact request` with only this message: `Please provide a private channel for a security report. I have not included report details here.` This request lets a maintainer contact you without disclosing that information publicly. Do not include affected versions or commits, impact, reproduction steps, vulnerable components or endpoints, proof-of-concept code, payloads, exploit instructions, screenshots, logs, personal data, or secrets in that issue. Do not attach files. Once a maintainer provides a private channel, send the report there.

The repository owner must enable GitHub private vulnerability reporting and verify that the reporting option is available to repository users before controlled beta.
