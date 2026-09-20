#!/usr/bin/env bash
# ship_game_events.sh — POST signed JSONL game events to /v1/game/events.
#
# The game server appends one complete signed event object per line
# (server_signature included); this shipper reads the file in batches and
# POSTs each batch. Delivery is at-least-once: the backend deduplicates by
# idempotency hash, so re-shipping after a crash is safe.
#
# Usage:
#   scripts/ship_game_events.sh --file /var/lib/neonrelay/game_events.jsonl \
#       --backend http://127.0.0.1:8787 [--batch 500] [--timeout 15]
#
# Exit codes: 0 all batches accepted (or duplicates), 1 transport/HTTP failure,
# 2 usage error. Rejected events are reported per batch but do not fail the
# run — signature/validation failures need investigation, not retries.
set -euo pipefail

FILE=""
BACKEND=""
BATCH=500
TIMEOUT=15

while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:?--file needs a path}"; shift 2 ;;
    --backend) BACKEND="${2:?--backend needs a URL}"; shift 2 ;;
    --batch) BATCH="${2:?--batch needs a number}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$FILE" ] || { echo "--file is required" >&2; exit 2; }
[ -n "$BACKEND" ] || { echo "--backend is required" >&2; exit 2; }
[ -f "$FILE" ] || { echo "not a file: $FILE" >&2; exit 2; }
case "$BATCH" in (*[!0-9]*|"") echo "--batch must be 1..500" >&2; exit 2 ;; esac
[ "$BATCH" -ge 1 ] && [ "$BATCH" -le 500 ] || { echo "--batch must be 1..500" >&2; exit 2; }

export SHIP_FILE="$FILE" SHIP_BACKEND="$BACKEND" SHIP_BATCH="$BATCH" SHIP_TIMEOUT="$TIMEOUT"
python3 - <<'PY'
import json
import os
import sys
import urllib.request

path = os.environ["SHIP_FILE"]
backend = os.environ["SHIP_BACKEND"].rstrip("/")
batch_size = int(os.environ["SHIP_BATCH"])
timeout = int(os.environ["SHIP_TIMEOUT"])

with open(path, "r", encoding="utf-8") as fh:
    lines = [ln.strip() for ln in fh if ln.strip()]

if not lines:
    print("ship_game_events: nothing to ship")
    raise SystemExit(0)

events = []
for i, line in enumerate(lines, start=1):
    try:
        events.append(json.loads(line))
    except json.JSONDecodeError as err:
        print(f"ship_game_events: line {i} is not JSON ({err}); aborting", file=sys.stderr)
        raise SystemExit(1)

accepted = duplicates = rejected = 0
for start in range(0, len(events), batch_size):
    chunk = events[start:start + batch_size]
    req = urllib.request.Request(
        f"{backend}/v1/game/events",
        data=json.dumps({"events": chunk}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except Exception as err:  # transport or HTTP error: stop, keep offset for retry
        print(f"ship_game_events: batch at line {start + 1} failed ({err}); "
              f"re-run to resume (server deduplicates)", file=sys.stderr)
        raise SystemExit(1)
    for item in payload.get("results", []):
        status = item.get("status", "")
        if status == "accepted":
            accepted += 1
        elif status == "duplicate":
            duplicates += 1
        else:
            rejected += 1
            print(f"ship_game_events: rejected {item.get('idempotency_hash')}: "
                  f"{status} {item.get('reason', '')}", file=sys.stderr)

print(f"ship_game_events: {accepted} accepted, {duplicates} duplicates, "
      f"{rejected} rejected out of {len(events)}")
PY
