#!/usr/bin/env python3
"""Capture raw EDDN traffic to a JSONL file for later replay by eddn_emulator.py."""

from __future__ import annotations

import argparse
import json
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import zmq

CAPTURES_DIR = Path(__file__).parent / "captures"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="tcp://eddn.edcd.io:9500")
    parser.add_argument("--duration", type=float, default=240.0, help="Capture length in seconds.")
    parser.add_argument("--out", type=Path, default=None, help="Output .jsonl path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    started = datetime.now(timezone.utc)
    out = args.out or CAPTURES_DIR / f"eddn_{started:%Y%m%dT%H%M%SZ}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)

    socket = zmq.Context.instance().socket(zmq.SUB)
    socket.setsockopt_string(zmq.SUBSCRIBE, "")
    socket.connect(args.url)
    print(f"Capturing {args.url} for {args.duration:.0f}s...")

    messages: list[str] = []
    deadline = time.monotonic() + args.duration
    next_report = time.monotonic() + 10
    try:
        while (remaining := deadline - time.monotonic()) > 0:
            if socket.poll(int(min(remaining, 1.0) * 1000), zmq.POLLIN):
                raw = socket.recv()
                try:
                    doc = json.loads(zlib.decompress(raw))
                except (zlib.error, json.JSONDecodeError, UnicodeDecodeError):
                    continue
                messages.append(json.dumps(doc, separators=(",", ":")))
            if time.monotonic() >= next_report:
                print(f"  {len(messages)} messages, {max(0, deadline - time.monotonic()):.0f}s left")
                next_report += 10
    except KeyboardInterrupt:
        print("Interrupted, saving what was captured.")
    finally:
        socket.close(linger=0)

    duration = min(args.duration, (datetime.now(timezone.utc) - started).total_seconds())
    meta = {"capture": {"duration_s": round(duration, 1), "count": len(messages), "started_utc": started.isoformat()}}
    with out.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps(meta) + "\n")
        for line in messages:
            fh.write(line + "\n")
    print(f"Saved {len(messages)} messages to {out}")


if __name__ == "__main__":
    main()
