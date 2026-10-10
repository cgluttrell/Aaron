#!/usr/bin/env python3
"""Count state-lifecycle contention log records by UTC hour.

Reads existing OpenClaw JSONL or plain-text logs; never opens state databases.
Recognizes the v2026.9.8 state-owner records and the earlier coordinator ones.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import glob
import json
import re
import sys

PHRASE = "another OpenClaw process owns state-lifecycle"
OWNER_PHRASE = "state owner contention at "
OWNER_ERROR = "GatewayStateOwnerContentionError"
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")


def has_structured_contention(value):
    if isinstance(value, dict):
        if (
            value.get("name") == "StateDatabaseCoordinatorContentionError"
            and value.get("family") == "state-lifecycle"
        ):
            return True
        if value.get("name") == OWNER_ERROR:
            return True
        return any(has_structured_contention(child) for child in value.values())
    if isinstance(value, list):
        return any(has_structured_contention(child) for child in value)
    return False


def is_contention(record):
    if isinstance(record, dict):
        if has_structured_contention(record.get("error")) or has_structured_contention(
            record.get("1")
        ):
            return True
        detail = record.get("1")
        if isinstance(detail, dict) and detail.get("errorName") == "StateDatabaseCoordinatorContentionError":
            return PHRASE in str(record.get("2", ""))
        first = record.get("0")
        if isinstance(first, str) and first.startswith("Embedded agent failed before reply: "):
            return PHRASE in first
        subsystem = str(record.get("0", "")) + str(record.get("_meta", {}).get("name", ""))
        if "state/owner" in subsystem:
            return OWNER_PHRASE in str(record.get("message", "")) or OWNER_PHRASE in str(
                record.get("1", "")
            )
        if "state/coordinator" in subsystem:
            return PHRASE in str(record.get("message", "")) or PHRASE in str(record.get("2", ""))
        if "state/" in subsystem:
            return isinstance(detail, dict) and PHRASE in str(detail.get("error", ""))
        return False
    if isinstance(record, str) and "[state/owner]" in record:
        return OWNER_PHRASE in record
    return isinstance(record, str) and (
        "[state/coordinator]" in record or "StateDatabaseCoordinatorContentionError" in record
    ) and PHRASE in record


def record_hour(line):
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        record = line
    if not is_contention(record):
        return None
    if isinstance(record, dict):
        stamp = record.get("time") or record.get("_meta", {}).get("date")
    else:
        found = STAMP.search(line)
        stamp = found.group() if found else None
    if not isinstance(stamp, str):
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc).strftime(
            "%Y-%m-%dT%H:00Z"
        )
    except ValueError:
        return None


def count_paths(paths):
    counts = Counter()
    for file in paths:
        with file.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                hour = record_hour(line)
                if hour:
                    counts[hour] += 1
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="*", help="log files (default: /tmp/openclaw/openclaw-*.log)")
    args = parser.parse_args()
    paths = [Path(name) for name in args.logs] if args.logs else [
        Path(name) for name in sorted(glob.glob("/tmp/openclaw/openclaw-*.log"))
    ]
    counts = count_paths(paths)
    for hour, count in sorted(counts.items()):
        print(f"{hour} {count}")
    if not paths:
        print("No log files found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
