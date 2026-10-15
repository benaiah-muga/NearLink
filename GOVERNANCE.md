# NearLink governance

This policy describes how NearLink changes are proposed, reviewed, decided, and
released. NearLink is an early development project, so roles and authority are
kept explicit and limited to what is currently published.

## Published roles

- Repository owner: `benaiah-muga`, as identified by the
  [public repository](https://github.com/benaiah-muga/NearLink).
- Additional maintainers and specialist assignments: none are published.
  Security, privacy, accessibility, release, and community roles are unassigned
  unless a future public record names an assignee.

The repository owner handles repository settings, merges, and release actions
under this policy. Contributors and reviewers may offer advice, but a review or
approval does not grant repository access or release authority. Changes to
these assignments should be made in this document and recorded in the relevant
decision or release record.

## Proposal and contribution lifecycle

1. Check the README, roadmap, relevant design documents, open issues, and
   existing decisions. For a substantial change, open an issue or discussion
   describing the problem, intended outcome, affected users and components,
   alternatives, risks, and how the result can be checked. Small corrections
   can be proposed directly in a pull request.
2. Submit a focused pull request with a clear summary, implementation notes,
   relevant checks, documentation updates, and known security, privacy,
   compatibility, migration, and reliability limits. Do not include secrets,
   private keys, real message content, or vulnerability details in public
   materials.
3. Reviewers assess the change against the criteria below. The repository
   owner resolves review requests and records the decision in the pull request,
   linked issue, or an Architecture Decision Record (ADR).
4. After acceptance, the repository owner merges the change. Release work then
   follows the release gate in this policy and the checklist in
   [`docs/release/README.md`](docs/release/README.md).

Contributors should follow [`CONTRIBUTING.md`](CONTRIBUTING.md), the project
instructions in `AGENTS.md`, and the pull request template. No response or
review-time guarantee is published for ordinary contributions.

## When design review is needed

Request design discussion before implementation when a proposal changes a
public protocol or data format, trust or identity assumptions, cryptographic
behavior, authorization, persistence or migration, transport boundaries,
privacy behavior, platform architecture, or a release claim. Record a durable
decision as an ADR when it affects architecture or has consequences later
contributors need to understand. Include context, options considered, the
decision, consequences, and links to evidence. Routine isolated fixes do not
need an ADR.

Security-sensitive designs require a focused review from someone with relevant
expertise before product integration. A proposal or document is not proof that
the capability has been implemented, independently reviewed, or released.
Keep the current security state aligned with the
[`threat model`](docs/security/threat-model.md).

## Review criteria and decisions

Reviewers should check that a change:

- solves the stated problem and fits the documented architecture;
- validates untrusted input and preserves protocol and transport boundaries;
- handles failure, retry, persistence, migration, and offline states honestly;
- avoids exposing private data or overstating identity, security, delivery, or
  availability guarantees;
- includes appropriate automated checks, manual evidence, and documentation;
- follows the no em dash project rule and uses clear, accessible user-facing
  language.

The repository owner makes the merge decision after considering review
comments, checks, and unresolved risks. Record material decisions and their
rationale in the pull request or issue. Record durable architectural choices
in an ADR. A contributor may ask for reconsideration by adding new evidence or
explaining a concern in the same discussion. The repository owner should
revisit the decision when the evidence or constraints materially change; an
earlier decision is not permanent precedent when its assumptions no longer
hold.

## Security reports and conduct

Report vulnerabilities through the private process in [`SECURITY.md`](SECURITY.md).
Do not disclose exploit details in public issues or pull requests. If private
reporting is unavailable, follow the minimal contact request described there.
The security policy sets an acknowledgment target of seven days; this is an
operational goal, not a resolution guarantee. No security specialist is
currently assigned publicly. The repository owner coordinates reports and
should seek qualified review for security-sensitive decisions.

For abusive or unsafe conduct, contact the repository owner privately through
GitHub. Use GitHub's report tools for platform abuse. The repository owner may
moderate project spaces, restrict participation, or remove content as needed
to protect contributors. Do not put personal or sensitive details in public
reports.

## Release authority and release gate

The repository owner, as the sole publicly identified repository owner, has
authority to approve a release or controlled beta distribution under this
policy. Before release, the owner must review the candidate against
[`docs/release/README.md`](docs/release/README.md), record the exact source
commit and artifact evidence, capture named review outcomes, document open
findings and limitations, and provide a rollback or withdrawal path. Required
device, browser, security, privacy, accessibility, or operational gates that
are not evidenced remain pending and block any release claim that depends on
them. A successful build, CI run, or review artifact alone is not release
approval.

The current product does not have reviewed application-level end-to-end
encryption or emergency-grade reliability. Do not market it for sensitive
communication or emergency coordination. See the
[`product status`](README.md#product-status) and
[`security policy`](SECURITY.md).

## Continuity

Keep decisions, release records, test evidence, and known limitations in the
repository so work can continue if a contributor is unavailable. Keep access
and repository credentials under the account holder's control, use the
repository's documented recovery options, and do not rely on an unpublished
role or private knowledge as the only copy of operational steps. Until
additional maintainers are publicly assigned, project administration and
release actions depend on the repository owner. The roadmap lists open work and
external gates without promising completion dates.
