#!/usr/bin/env python3
"""Local EDDN emulator: replays captured traffic and publishes test messages on request.

Replay: messages from a capture made with eddn_capture.py are shuffled and published at the
capture's average rate, looping forever, with timestamps rewritten to "now".

Control (ZMQ REP, JSON):
  {"cmd": "jump"|"dock"|"market", "callsign": "ABC-123", "system": "Sol", "uploader"?: "..."}
  {"cmd": "scenario", "name": "carrier-jump", "callsign": "ABC-123"}
  {"cmd": "status"}
"""

from __future__ import annotations

import argparse
import heapq
import itertools
import json
import random
import time
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import zmq

TOOLS_DIR = Path(__file__).parent
DEFAULT_UPLOADER = "test-emulator"
SOFTWARE = {"softwareName": "carrier-tracker-emulator", "softwareVersion": "1.0"}
MAX_REPLAY_LAG_S = 1.0
STATS_INTERVAL_S = 30.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay captured EDDN traffic and inject test messages.")
    parser.add_argument("--capture", type=Path, default=None, help="Capture file (default: newest in captures/).")
    parser.add_argument("--pub", default="tcp://127.0.0.1:9600", help="Address to publish EDDN messages on.")
    parser.add_argument("--control", default="tcp://127.0.0.1:9601", help="Address for the control socket.")
    parser.add_argument("--scenarios", type=Path, default=TOOLS_DIR / "scenarios")
    return parser.parse_args()


def iso(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def market_id_for(callsign: str) -> int:
    # Stable fake MarketID in the fleet carrier range so the tracker can link sightings.
    return 3_700_000_000 + zlib.crc32(callsign.encode()) % 100_000_000


def load_capture(path: Path) -> tuple[list[dict[str, Any]], float]:
    with path.open(encoding="utf-8") as fh:
        meta = json.loads(fh.readline())["capture"]
        messages = [json.loads(line) for line in fh if line.strip()]
    if not messages:
        raise SystemExit(f"Capture {path} contains no messages")
    interval = float(meta["duration_s"]) / len(messages)
    return messages, interval


def newest_capture() -> Path:
    captures = sorted((TOOLS_DIR / "captures").glob("*.jsonl"))
    if not captures:
        raise SystemExit("No captures found; run eddn_capture.py first or pass --capture")
    return captures[-1]


def with_fresh_timestamps(doc: dict[str, Any], offset_s: float = 0.0) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    out = dict(doc)
    if isinstance(doc.get("header"), dict):
        out["header"] = {**doc["header"], "gatewayTimestamp": now.isoformat().replace("+00:00", "Z")}
    if isinstance(doc.get("message"), dict):
        out["message"] = {**doc["message"], "timestamp": iso(now + timedelta(seconds=offset_s))}
    return out


def build_message(kind: str, callsign: str, system: str, uploader: str | None) -> dict[str, Any]:
    callsign = callsign.upper()
    header = {"uploaderID": uploader or DEFAULT_UPLOADER, **SOFTWARE}
    market_id = market_id_for(callsign)
    journal = {
        "StationName": callsign,
        "StationType": "FleetCarrier",
        "MarketID": market_id,
        "StarSystem": system,
        "SystemAddress": 0,
        "StarPos": [0.0, 0.0, 0.0],
        "horizons": True,
        "odyssey": True,
    }
    if kind == "jump":
        return {
            "$schemaRef": "https://eddn.edcd.io/schemas/journal/1",
            "header": header,
            "message": {"event": "CarrierJump", "Docked": True, **journal},
        }
    if kind == "dock":
        return {
            "$schemaRef": "https://eddn.edcd.io/schemas/journal/1",
            "header": header,
            "message": {"event": "Docked", **journal},
        }
    if kind == "market":
        return {
            "$schemaRef": "https://eddn.edcd.io/schemas/commodity/3",
            "header": header,
            "message": {"systemName": system, "stationName": callsign, "marketId": market_id, "commodities": []},
        }
    raise ValueError(f"unknown message type '{kind}'")


class Emulator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.capture_path = args.capture or newest_capture()
        self.replay_pool, self.replay_interval = load_capture(self.capture_path)
        self.replay_order: list[dict[str, Any]] = []
        self.scenarios_dir: Path = args.scenarios

        ctx = zmq.Context.instance()
        self.pub = ctx.socket(zmq.PUB)
        self.pub.bind(args.pub)
        self.control = ctx.socket(zmq.REP)
        self.control.bind(args.control)

        self.scheduled: list[tuple[float, int, dict[str, Any], float]] = []
        self.seq = itertools.count()
        self.replayed = 0
        self.injected = 0
        print(
            f"Loaded {len(self.replay_pool)} messages from {self.capture_path.name} "
            f"({1 / self.replay_interval:.1f} msg/s)"
        )
        print(f"Publishing on {args.pub}, control on {args.control}")

    def publish(self, doc: dict[str, Any], offset_s: float = 0.0) -> None:
        self.pub.send(zlib.compress(json.dumps(with_fresh_timestamps(doc, offset_s)).encode("utf-8")))

    def next_replay_doc(self) -> dict[str, Any]:
        if not self.replay_order:
            self.replay_order = random.sample(self.replay_pool, len(self.replay_pool))
        return self.replay_order.pop()

    def schedule(self, at: float, doc: dict[str, Any], offset_s: float = 0.0) -> None:
        heapq.heappush(self.scheduled, (at, next(self.seq), doc, offset_s))

    def scenario_names(self) -> list[str]:
        return sorted(p.stem for p in self.scenarios_dir.glob("*.json"))

    def inject(self, kind: str, callsign: str, system: str, uploader: str | None, offset_s: float = 0.0) -> None:
        self.publish(build_message(kind, callsign, system, uploader), offset_s)
        self.injected += 1
        print(f"[inject] {kind} {callsign.upper()} {system} uploader={uploader or DEFAULT_UPLOADER} offset={offset_s:+.0f}s")

    def handle_control(self, req: dict[str, Any]) -> dict[str, Any]:
        cmd = req.get("cmd")
        if cmd == "status":
            return {
                "ok": True,
                "capture": self.capture_path.name,
                "replayed": self.replayed,
                "injected": self.injected,
                "pending": len(self.scheduled),
                "scenarios": self.scenario_names(),
            }

        callsign = req.get("callsign")
        if not isinstance(callsign, str) or not callsign:
            return {"ok": False, "error": "callsign is required"}

        if cmd in ("jump", "dock", "market"):
            system = req.get("system")
            if not isinstance(system, str) or not system:
                return {"ok": False, "error": "system is required"}
            self.inject(cmd, callsign, system, req.get("uploader"))
            return {"ok": True, "sent": 1}

        if cmd == "scenario":
            name = req.get("name")
            # Only names that exist in the scenarios dir are accepted, so no path is built from user input.
            if name not in self.scenario_names():
                return {"ok": False, "error": f"unknown scenario '{name}'", "scenarios": self.scenario_names()}
            spec = json.loads((self.scenarios_dir / f"{name}.json").read_text(encoding="utf-8"))
            start = time.monotonic()
            for step in spec["steps"]:
                doc = build_message(step["type"], callsign, step["system"], step.get("uploader"))
                self.schedule(start + float(step.get("at_s", 0)), doc, float(step.get("ts_offset_s", 0)))
            print(f"[scenario] {name} for {callsign.upper()}: {len(spec['steps'])} steps queued")
            return {"ok": True, "queued": len(spec["steps"]), "description": spec.get("description", "")}

        return {"ok": False, "error": f"unknown cmd '{cmd}'"}

    def run(self) -> None:
        next_replay = time.monotonic()
        next_stats = time.monotonic() + STATS_INTERVAL_S
        while True:
            now = time.monotonic()

            while self.scheduled and self.scheduled[0][0] <= now:
                _, _, doc, offset_s = heapq.heappop(self.scheduled)
                msg = doc["message"]
                self.publish(doc, offset_s)
                self.injected += 1
                print(
                    f"[scenario] sent {msg.get('event') or 'commodity'} "
                    f"{msg.get('StationName') or msg.get('stationName')} "
                    f"{msg.get('StarSystem') or msg.get('systemName')} "
                    f"uploader={doc['header']['uploaderID']} offset={offset_s:+.0f}s"
                )

            if now - next_replay > MAX_REPLAY_LAG_S:
                next_replay = now
            while next_replay <= now:
                self.publish(self.next_replay_doc())
                self.replayed += 1
                next_replay += self.replay_interval

            if now >= next_stats:
                print(f"[stats] replayed={self.replayed} injected={self.injected} pending={len(self.scheduled)}")
                next_stats = now + STATS_INTERVAL_S

            wake = min([next_replay, next_stats] + ([self.scheduled[0][0]] if self.scheduled else []))
            timeout_ms = max(0, int((wake - time.monotonic()) * 1000))
            if self.control.poll(timeout_ms, zmq.POLLIN):
                raw = self.control.recv()
                try:
                    req = json.loads(raw)
                    reply = self.handle_control(req) if isinstance(req, dict) else {"ok": False, "error": "expected object"}
                except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
                    reply = {"ok": False, "error": str(exc)}
                self.control.send_string(json.dumps(reply))


def main() -> None:
    emulator = Emulator(parse_args())
    try:
        emulator.run()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
