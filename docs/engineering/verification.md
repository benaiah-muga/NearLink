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

The verification command generates the pinned Rust/WASM protocol module, builds
the web client, runs the web unit and FastAPI hub test suites, and scans tracked
and non-ignored untracked project files for the em dash character. The
end-to-end command builds the production client, starts Vite preview and the
checked-in FastAPI hub, and runs Chromium journeys. `npm run test:e2e:compat`
runs a smaller local persistence journey in Playwright Firefox and WebKit. The
real-hub journey uses two independent browser contexts and a temporary SQLite
database. It checks hub acceptance separately from recipient persistence, then
exercises live delivery, reconnect replay, and a bounded history response. It
blocks and fails on
non-loopback HTTP and WebSocket requests. Other journeys cover local queue
behavior, offline service-worker behavior, synchronization, and direct browser
communication. The accessibility journeys scan relevant screens for WCAG 2.1
A/AA and WCAG 2.2 AA issues with axe. Install the Playwright browsers with:

```sh
npx playwright install chromium firefox webkit
```

On a clean Linux host, install the system browser dependencies as well:

```sh
npx playwright install --with-deps chromium firefox webkit
```

Generated output, dependency folders, and the ignored `.unlazy` work ledgers
are excluded from the em dash scan.

GitHub Actions runs the same build, unit, hub, Chromium journeys, Firefox and
WebKit persistence smoke journeys, Rust, and em dash checks on pushes to `main`
and pull requests. It also audits npm, Python, and Rust dependencies for known
advisories. The full browser journey covers Chromium desktop. Firefox and
Playwright WebKit receive only a local persistence smoke, which does not
establish Firefox desktop or Safari support and does not replace the
physical-device and browser compatibility checks in `docs/product-beta.md`.

## Rust protocol core and browser binding

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
cargo +1.84.1 test --manifest-path crates/protocol-wasm/Cargo.toml --locked
cargo +1.84.1 clippy --manifest-path crates/protocol-wasm/Cargo.toml --locked -- -D warnings
npm run build:wasm
npm run test:wasm
```

The `build:wasm` command requires Rust 1.84.1, the `wasm32-unknown-unknown`
target, and `wasm-bindgen-cli` 0.2.103. It generates ignored files under
`apps/web/src/generated/`. The app build and unit-test commands run this build
first. The app fails closed if the generated module cannot initialize. The
`test:wasm` command separately exercises the binding and shared protocol
vectors in Chromium. In the browser synchronization flow, Rust/WASM owns
bounded inventory sequence acceptance, the frozen missing-ID plan and
batching, request replay/conflict checks, requested-message matching, and
staged completion correlation and validation. It selects missing IDs against
accepted-ID snapshots in bounded chunks. TypeScript keeps WASM handles and
peer scheduling/async continuation. It owns bounded IndexedDB reads and durable message acceptance, validates
loaded durable rows, and asks Rust/WASM to compare exact IDs and packets with
tracked state. TypeScript records storage truncation, partial-page, and bounded-peer conditions through the Rust/WASM coverage aggregator. Rust/WASM reports the aggregate partial/final outcome; TypeScript presents it and owns transport sends, timers, and rate budgets. Rust exchange state and the `MessageIndex` are in-memory
and are not the browser's persistent source of truth. These APIs do not
provide peer authentication, encryption, guaranteed-complete synchronization,
or a native mobile target, and there is no native app in the repository.
