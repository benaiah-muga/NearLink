# Local verification

Run the project checks from the repository root with:

```sh
npm run verify:foundation
```

Use Node.js 20 or newer and Python 3.11 or newer. Create and activate a Python
virtual environment, then install the hub test dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r services/local-hub/requirements-dev.lock
```

The foundation command builds the web client, runs the FastAPI hub test suite, and scans
tracked and non-ignored untracked project files for the em dash character.
Generated output, dependency folders, and the ignored `.unlazy` work ledgers
are excluded from the scan.

GitHub Actions installs Node.js and Python, installs JavaScript dependencies
from the npm lockfile and Python dependencies from the pinned development
lockfile, and runs the same command on pushes to `main` and pull requests.
