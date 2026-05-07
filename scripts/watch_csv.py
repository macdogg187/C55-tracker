"""Watch a folder for new VantagePoint CSV drops and re-run the pipeline.

Local-first: stdlib-only polling watcher, no extra deps required. Compatible
with Windows / macOS / Linux. Designed to run alongside `npm run dev` on a
local workstation without IT involvement.

Behavior
--------
1. Polls --inbox every --interval seconds.
2. For each new *.csv file:
     a. Computes sha256; skips files we've already ingested.
     b. Invokes `python data_pipeline.py --sensor-csv <file>`.
     c. Moves the source CSV into --archive after a successful merge.
3. Persists ingest state in `.csv_watch_state.json` to survive restarts.

Usage
-----
    python scripts/watch_csv.py
    python scripts/watch_csv.py --inbox /path/to/drop --interval 5
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_INBOX = Path("inbox")
DEFAULT_ARCHIVE = Path("archive")
STATE_FILE = Path(".csv_watch_state.json")


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict[str, str]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_state(state: dict[str, str]) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def run_pipeline(sensor_csv: Path, mtbf_xlsx: Path, output: Path) -> bool:
    cmd = [
        sys.executable,
        "data_pipeline.py",
        "--sensor-csv", str(sensor_csv),
        "--mtbf-xlsx",  str(mtbf_xlsx),
        "--output",     str(output),
    ]
    print(f"[watch] running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print("[watch] pipeline FAILED:")
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        return False
    print(proc.stdout.strip())
    return True


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--inbox",    type=Path, default=DEFAULT_INBOX,
                   help="Folder to watch for *.csv drops.")
    p.add_argument("--archive",  type=Path, default=DEFAULT_ARCHIVE,
                   help="Folder to move successfully-ingested CSVs to.")
    p.add_argument("--mtbf-xlsx", type=Path, default=Path("MTBF Tracker_cursor.xlsx"))
    p.add_argument("--output",   type=Path, default=Path("public/pipeline.json"))
    p.add_argument("--interval", type=float, default=3.0,
                   help="Polling interval in seconds.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    args.inbox.mkdir(parents=True, exist_ok=True)
    args.archive.mkdir(parents=True, exist_ok=True)

    print(f"[watch] watching {args.inbox.resolve()} every {args.interval}s; "
          f"output → {args.output}; ctrl-c to stop.")

    state = load_state()
    try:
        while True:
            for csv_path in sorted(args.inbox.glob("*.csv")):
                # Wait for the file to stop growing (in case it's still being copied).
                size_a = csv_path.stat().st_size
                time.sleep(0.4)
                if size_a != csv_path.stat().st_size:
                    continue  # next pass

                digest = sha256_of(csv_path)
                if state.get(digest):
                    print(f"[watch] skip duplicate {csv_path.name} (sha={digest[:10]}…)")
                    continue

                ok = run_pipeline(csv_path, args.mtbf_xlsx, args.output)
                if not ok:
                    continue

                state[digest] = csv_path.name
                save_state(state)

                target = args.archive / csv_path.name
                if target.exists():
                    target = args.archive / f"{csv_path.stem}.{digest[:8]}{csv_path.suffix}"
                shutil.move(str(csv_path), target)
                print(f"[watch] archived → {target}")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[watch] stopped.")


if __name__ == "__main__":
    main()
