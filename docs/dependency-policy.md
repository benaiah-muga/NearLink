# Dependency policy

This policy covers dependency declarations and resolved dependency graphs used
by NearLink. It applies to the product workspaces and to separately identified
research projects.

## Ownership and lockfiles

- The repository root `package.json` and `package-lock.json` define the npm
  workspaces. `apps/web/package.json` owns browser application dependencies;
  `packages/protocol/package.json` owns the shared protocol package metadata.
- Update npm manifests and `package-lock.json` together. Commit both files and
  use `npm ci` for clean installs and CI. Do not use floating `latest` specs
  for direct dependencies.
- Each Rust product crate owns its `Cargo.toml` and committed `Cargo.lock`.
  Product builds, tests, and checks use `--locked`.
- The local hub's runtime constraints are in
  `services/local-hub/requirements.txt`. Its pinned development and test graph
  is recorded in `services/local-hub/requirements-dev.lock`. Update the
  runtime constraints deliberately, refresh the pinned development graph, and
  validate that lock.
- A lockfile update must correspond to an intentional dependency or toolchain
  change. Review the full lock diff, including transitive additions, removals,
  versions, source locations, and checksums.

## Supported and tested toolchains

- For full repository development and tests, use Node.js 22.22.2 or newer in
  the 22.x line, Node.js 24.15.0 or newer in the 24.x line, or Node.js 26 or
  newer. These versions meet the declared engine ranges of the locked
  application and test dependency graphs. Vite 8 alone has a lower floor, but
  it does not set the repository's complete dependency range. Node.js 22.16 can
  run local checks but emits unsupported engine warnings for some test
  dependencies. CI uses Node.js 24.18.0 for verification and Node.js 24 for
  the security job.
- Local hub development requires Python 3.11 or newer. CI currently verifies
  with Python 3.12.
- Product Rust work uses the repository-pinned Rust 1.84.1 toolchain. The
  OpenMLS compatibility spike has a separate Rust 1.91.0 requirement and is
  not part of the product toolchain.
- CI toolchains describe tested environments. A successful CI run does not
  imply support for every operating system or runtime version.

## Dependency updates and review

For an update, identify the direct dependency owner, read upstream release and
compatibility notes, change its manifest constraint intentionally, regenerate
the appropriate lockfile with the documented toolchain, and review the
resulting graph. Run the relevant build, tests, and security audits. For
transitive changes, identify why the resolution changed and whether the new
crate or feature enters product runtime code. Record material exceptions in
the owning project documentation and security configuration.

## License and advisory review

Review license metadata and compatibility before introducing or materially
updating a dependency. Metadata scanners and Cargo license expressions are
inventory aids, not legal approval. Resolve unclear licenses before adoption.

CI audits the npm lock with `npm audit`, the pinned Python requirements with
`pip-audit`, and every committed Rust product and research lock with RustSec.
New unreviewed vulnerability findings fail the security job. Review advisory
severity, affected APIs and features, reachable targets, available fixes, and
whether the dependency is in a product or research graph. Do not silence an
advisory with broad thresholds or blanket exceptions. Every exception must
name exact advisory IDs, a bounded lockfile and scope, a rationale, an owner,
and conditions that trigger reassessment.

## Product and research boundary

Only dependencies declared and built by product workspaces enter product
builds. Research crates keep separate manifests, lockfiles, toolchain
requirements, and audit context. Do not import research dependencies into
product manifests or treat research tests, lockfile audits, or compatibility
results as product approval. The OpenMLS spike is experimental research and is
not an audited or approved product cryptography stack.

## Current research exception

`research/openmls-compat-spike/audit.toml` permits only
`RUSTSEC-2026-0330` and `RUSTSEC-2026-0331` for `libcrux-kem` 0.0.9 in the
complete OpenMLS research lock. The locked crate is pulled in by optional
`hpke-rs-libcrux`; the selected provider and tested targets do not activate
that backend. The repository owner named in `GOVERNANCE.md` is accountable for
this temporary exception and must record each reassessment in the research
README. The full lock audit still encounters the advisories, so this is a
scoped audit exception, not a finding that the package is safe. The active
`proc-macro-error2` unmaintained warning remains visible and unignored.

This exception must be reconsidered on every research lockfile or feature
graph change, when RustSec changes the affected versions or advisory details,
and before any proposal to select OpenMLS for product use. Reassessment must
include a fresh complete-lock audit and active feature-graph review. The
research README records the advisory snapshot, rationale, and further review
limits.
