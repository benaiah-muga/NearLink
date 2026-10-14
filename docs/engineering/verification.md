# Local verification

Run the project checks from the repository root with:

```sh
npm run verify:foundation
npm run test:e2e
```

Use Node.js 20.19 or newer, or 22.12 or newer, and Python 3.11 or newer. Create and activate a Python
virtual environment, then install the hub test dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r services/local-hub/requirements-dev.lock
```

The foundation command builds the web client, runs the web unit and FastAPI hub
test suites, and scans tracked and non-ignored untracked project files for the
em dash character. The end-to-end command builds the production client, starts
Vite preview, and runs the Chromium local-message journey. It scans the initial
and queued-message screens for WCAG 2.1 A/AA and WCAG 2.2 AA issues with axe. Install the
Playwright Chromium build with:

```sh
npx playwright install chromium
```

On a clean Linux host, install the system browser dependencies as well:

```sh
npx playwright install --with-deps chromium
```

Generated output, dependency folders, and the ignored `.unlazy` work ledgers
are excluded from the em dash scan.

GitHub Actions runs the same build, unit, hub, Chromium journey, Rust, and
em dash checks on pushes to `main` and pull requests. It also audits npm,
Python, and Rust dependencies for known advisories. The browser journey covers
Chromium desktop only. It does not replace the physical-device and browser
compatibility checks in `docs/product-beta.md`.

## Rust protocol core

The Rust crate uses the toolchain pinned in `rust-toolchain.toml`. Run its
formatting, test, WebAssembly cross-compilation, and strict Clippy checks with:

```sh
rustup toolchain install 1.84.1 --profile minimal
rustup component add rustfmt --toolchain 1.84.1
rustup component add clippy --toolchain 1.84.1
rustup target add wasm32-unknown-unknown --toolchain 1.84.1
cargo +1.84.1 fmt --manifest-path crates/protocol-core/Cargo.toml -- --check
cargo +1.84.1 test --manifest-path crates/protocol-core/Cargo.toml --locked
cargo +1.84.1 check --target wasm32-unknown-unknown --manifest-path crates/protocol-core/Cargo.toml --locked
cargo +1.84.1 clippy --manifest-path crates/protocol-core/Cargo.toml --locked -- -D warnings
```

The formatter and test run cover the native host target. The target check only
cross-compiles the crate for WebAssembly. It does not provide a WASM binding,
browser runtime integration, or a native mobile target.
