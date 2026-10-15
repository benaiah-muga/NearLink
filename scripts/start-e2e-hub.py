"""Run the checked-in FastAPI hub with an isolated temporary SQLite database."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HUB_DIR = ROOT / "services" / "local-hub"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="nearlink-playwright-hub-") as directory:
        os.environ["NEARLINK_HUB_DB_PATH"] = str(Path(directory) / "hub.sqlite3")
        sys.path.insert(0, str(HUB_DIR))
        import uvicorn
        from main import app

        app.add_api_route("/health", lambda: {"status": "ok"}, methods=["GET"])
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")


if __name__ == "__main__":
    main()
