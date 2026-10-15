# Release and beta artifact checklist

This checklist describes how to prepare a reviewable NearLink beta candidate.
It is a process document, not evidence that any release gate has passed.
Complete a fresh release record for each candidate. Do not call a build a
release candidate while required device or browser checks are pending.

## 1. Freeze the candidate

- [ ] Select a source commit and record its full Git SHA.
- [ ] Confirm the working tree is clean and the commit is reachable from the
  intended remote branch.
- [ ] Record the proposed version and release channel.
- [ ] Review all changes since the last candidate, including dependency lockfile
  changes and security-sensitive changes.
- [ ] Confirm no em dash character is present in project files or release copy.
- [ ] Confirm product copy does not claim end-to-end encryption, verified real
  world identity, guaranteed delivery, or emergency-grade reliability.

## 2. Build from a clean checkout

Use the recorded commit in a fresh checkout. Pin the runtime versions used by
the repository workflow, install from the lockfiles, and retain command output.
Do not reuse a developer's existing `node_modules`, Python environment, or
generated build directory as the release input.

Example from the repository root:

```sh
git status --short
git rev-parse HEAD
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r services/local-hub/requirements-dev.lock
npm run verify:foundation
npm run build
```

If the repository workflow or lockfiles change, update this command sequence
from the checked-in source before publishing. Keep the complete stdout, stderr,
exit status, OS, Node version, Python version, and npm version in the release
record. A successful build does not replace browser or device tests.

## 3. Assemble and identify artifacts

The web bundle is produced in `apps/web/dist`. The hub is currently distributed
as source code and Python requirements, not as a standalone executable.

- [ ] Assemble the web archive from the clean output using GNU tar and gzip
  with normalized ownership, file order, and timestamps. Derive the timestamp
  from the source commit and use the same build environment for repeat builds:

  ```sh
  SOURCE_COMMIT=REPLACE_WITH_FULL_GIT_SHA
  RELEASE_VERSION=REPLACE_WITH_VERSION
  SOURCE_DATE_EPOCH="$(git show -s --format=%ct "$SOURCE_COMMIT")"
  tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner -cf - -C apps/web/dist . | gzip -n > "nearlink-${RELEASE_VERSION}-web.tar.gz"
  ```

  Rebuild the archive from the same source commit and pinned runtime versions
  when verifying reproducibility. Compare the archive checksums. If they differ,
  investigate the build environment and generated files before describing the
  package as reproducible.
- [ ] Copy the complete `apps/web/dist` directory without editing generated
  files. Include its HTML, hashed assets, PWA manifest, service worker, and
  icon.
- [ ] Produce a source archive from the exact recorded commit if a source
  archive is being distributed. For example:

  ```sh
  git archive --format=tar --prefix=nearlink-VERSION/ SOURCE_COMMIT | gzip -n > nearlink-VERSION-source.tar.gz
  ```

  Replace `VERSION` and `SOURCE_COMMIT` before running the command.
- [ ] Calculate SHA-256 checksums for every artifact and attach the checksum
  file to the candidate record.
- [ ] Keep the source archive and web bundle tied to the same commit. Record any
  separately deployed hub commit and its dependency lock hash.
- [ ] Include licenses and third-party notices required by the shipped
  dependencies.
- [ ] Confirm the package contains no `.env` files, credentials, real user
  content, SQLite history, local browser data, or debug secrets.
- [ ] Record artifact names, byte sizes, checksums, and storage locations.

The checksum identifies the reviewed artifact. It is not a digital signature.
The normalized archive process aims to make packaging repeatable, but it does
not prove that application builds are bit-for-bit reproducible across machines.
Do not claim reproducible binaries without comparing independent builds.

### Manually build a review artifact

The **NearLink review artifact** workflow can be run manually from GitHub
Actions with a proposed semantic version. It checks out the selected
`github.sha`, requires a clean checkout, installs Node 24.18.0,
repository-pinned Rust 1.84.1, and wasm-bindgen 0.2.103, then installs JavaScript dependencies
from `package-lock.json`. The packaging script builds the web client from clean
Cargo and web output directories, validates the PWA shell and archive paths,
normalizes a web archive, and repeats the clean web build from the same source
commit. The two web archive SHA-256 values must match before the source archive
and `SHA256SUMS.json` are finalized.

The workflow uploads the web archive, source archive, and JSON checksum manifest
as a reviewable Actions artifact retained for 14 days. It does not create a tag,
GitHub Release, deployment, or public distribution. The manifest records the
source commit, proposed version, source timestamp, runner and tool versions,
artifact byte sizes, archive checksums, and the repeat-build result. The repeat
build compares two clean builds on one workflow runner. It is not evidence of
cross-machine reproducibility, a signature, a security review, a release
approval, or a passed device/browser gate. Follow the acceptance checklist
above and keep any incomplete device, security, or accessibility evidence
marked pending.

The artifact path checks screen file and directory names for common secret and
local-state patterns. They are not a comprehensive scan of file contents, so
reviewers must still inspect the source and generated bundle for accidental
secrets before approving distribution.

The release artifact builder pins Node 24.18.0, Rust 1.84.1, and
wasm-bindgen 0.2.103. It records the npm version and Ubuntu runner platform in
the manifest, but does not pin their patch or image-build versions. The builder
uses GNU tar and gzip. Python is used by the CI archive verifier and extractor.

The main foundation CI workflow builds the same web and source archives from
its clean checkout, then runs the packaged web smoke against that archive. The
archive verifier checks the web checksum and size in `SHA256SUMS.json`, requires
the expected package root and PWA files, and rejects traversal paths, duplicate
members, file/directory collisions, links and other special filesystem entries,
and common secret or local-state paths. It caps the manifest at 1 MiB, the
compressed archive at 16 MiB, the decompressed tar at 128 MiB, the archive at
10,000 members, and individual and total extracted file data at 64 MiB and
128 MiB. It extracts regular files manually into a temporary directory.
Chromium serves that extracted directory on loopback,
checks the application JavaScript, CSS, WASM loader and binary, then saves a
profile and queued message. The journey makes the package origin return 503,
requires the navigation response to come from the service worker's CacheStorage
fallback, verifies the same IndexedDB row remains queued, restores the origin,
and proves that the local hub accepts that row once.

This is automated same-host evidence for the release web archive path. It does
not test a downloaded artifact on a separate machine, installation as a PWA,
operating-system browser support, two-device networking, or release approval.
For local checks, run `npm run test:package-archive` for adversarial archive
fixtures. The packaged browser journey needs an artifact directory produced by
the clean-checkout release command:

```sh
NEARLINK_REVIEW_ARTIFACT_DIR=/tmp/nearlink-review-artifact
NEARLINK_RELEASE_VERSION=0.1.0 NEARLINK_ARTIFACT_DIR="$NEARLINK_REVIEW_ARTIFACT_DIR" npm run release:candidate-artifact
npm run test:packaged-smoke -- "$NEARLINK_REVIEW_ARTIFACT_DIR"
```

The CI workflow runs the archive fixtures and browser journey after creating
the candidate archive. This smoke does not change the review artifact workflow
into a release, and it creates no tag or public distribution.

For local script behavior tests, run `npm run test:release-artifact`. To run
the full artifact pipeline locally, use a clean checkout with Node 24.18.0, Rust
1.84.1, wasm-bindgen 0.2.103, GNU tar, and gzip, then run
`NEARLINK_RELEASE_VERSION=0.1.0 NEARLINK_ARTIFACT_DIR=/tmp/nearlink-review-artifact npm run release:candidate-artifact`.
The output directory must be empty and outside the source checkout.

## 4. Run release acceptance checks

- [ ] Foundation verification passes at the release commit.
- [ ] Build and artifact checksums are recorded.
- [ ] Actual device and browser checks meet the [controlled beta acceptance
  criteria](../product-beta.md#beta-acceptance-criteria), or remain clearly
  marked pending and block release.
- [ ] Hub startup, restart, database path, retention, and data removal behavior
  are exercised by the operator.
- [ ] Hub and direct transport ACK semantics are accurate in the user guide.
- [ ] The feedback path requests no message content, room code, call sign,
  sender ID, SDP, complete fingerprint, raw local database, or unreviewed logs.
- [ ] The app loads at its intended origin. PWA install and offline-shell
  behavior are checked in every browser for which they are claimed.
- [ ] Privacy, security, and accessibility reviews have named reviewers and
  findings. Blocking findings are resolved or the candidate is not released.
- [ ] A rollback or withdrawal action is documented for the distribution
  channel.

## Offline local hub history management

Run these commands from the repository root while the local hub is stopped or
when its SQLite database is otherwise available for a short write transaction.
The CLI uses `NEARLINK_HUB_DB_PATH`, or `nearlink-hub.sqlite3` in the current
directory when the variable is unset. It opens an existing regular file only,
checks for the supported schema version, and does not initialize or migrate an
unsupported database.

```sh
python services/local-hub/main.py history list
python services/local-hub/main.py history purge --room ROOM_CODE
python services/local-hub/main.py history purge --all
python services/local-hub/main.py history backup --output /secure/local/path/nearlink-history.sqlite3
```

The list reports retained message counts and each room's `historyTruncated`
state. Purging a room or all rooms deletes matching message rows in one SQLite
transaction and preserves a truncation marker. This stops the hub from
replaying those deleted rows, but does not erase copies already stored in
browsers, peers, backups, SQLite pages, or sidecar files. SQLite may retain
recoverable remnants after deletion. These commands do not securely erase
history. Hub packets are plaintext, so protect the database directory and
backups as message content.

The backup command reads the configured existing database through SQLite's
backup API, so committed rows in a live WAL are included. It only creates a
new destination in an existing trusted directory, verifies SQLite integrity,
the hub schema, retained row counts, and truncation markers, then publishes the
owner-only file atomically. Its working copy stays in a private temporary
directory. It rejects symbolic-link path components and directories writable
by other users unless the sticky bit protects their entries. It prints counts
and marker state without message contents. Stop the hub during routine
maintenance so no new messages arrive while preparing or restoring a snapshot.

Backups contain plaintext packets and are as sensitive as the live database.
Restrict access to the backup directory, include backups in retention reviews,
and remove expired backup files using the normal filesystem process for that
storage. Deleting a file does not promise secure erasure, and other copies may
remain in snapshots or storage media.

To restore a snapshot, stop the hub and confirm the configured database path.
Keep a rollback copy of the current database and its `-wal` and `-shm` sidecars
in protected storage. Move the active database and any sidecars out of the
active directory, copy the selected backup to the configured database path,
and restrict the restored database to its owner. Start the hub and run
`history list` to confirm the retained counts and truncation markers. This is
an operator procedure, not a restore command in the hub CLI. Treat rollback
copies and the selected snapshot as plaintext message data, and remove
unneeded copies through the normal retention process.

## 5. Publish and monitor a controlled beta

- [ ] Give participants the candidate version, artifact checksums, supported
  browser list, onboarding guide, known limitations, and feedback checklist.
- [ ] Ask participants to use test-only content and a network they control.
- [ ] Provide a maintainer contact and a process for withdrawing the candidate.
- [ ] Track reports by candidate commit and classify severity without copying
  sensitive user content into public issue trackers.
- [ ] Stop distributing a candidate if a data loss, privacy exposure, identity
  confusion, or message integrity issue makes the published instructions
  inaccurate.

## Candidate record template

Copy this section for each candidate and fill every field. Use `pending` or
`not run` where evidence does not exist.

```text
Candidate version:
Release channel:
Source commit:
Hub commit, if separately deployed:
Clean checkout confirmed:
Working tree clean:
Build host and OS:
Node version:
npm version:
Python version:
Foundation verification command and result:
Production build command and result:
Browser/device evidence links:
Supported browser matrix:
Web bundle artifact name, size, and SHA-256:
Source archive artifact name, size, and SHA-256:
Hub dependency lock hash:
Privacy/security reviewer and outcome:
Accessibility reviewer and outcome:
Open findings and owners:
Known limitations shared with participants:
Rollback or withdrawal instructions:
Prepared by and date:
Release decision and approver:
```

## Current gate state

No completed physical browser or two-device acceptance record is included in
this repository at the time this checklist was written. The guide must continue
to show those checks as pending until a dated candidate record contains the
actual evidence. Automated CI status alone does not satisfy the device gates.
