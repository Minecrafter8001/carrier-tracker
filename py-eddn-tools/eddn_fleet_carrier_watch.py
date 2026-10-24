#!/usr/bin/env python3
"""Watch EDDN for FleetCarrier station messages and print the system name."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from typing import Any


UNKNOWN_SYSTEM = "<unknown system>"
UNKNOWN_STATION = "<unknown station>"
FC_STATION_NAME_RE = re.compile(r"^[A-Z0-9]{3}-[A-Z0-9]{3}$")
MISSING_SYSTEM_EVENTS = {"DockingGranted", "DockingDenied"}
EDSM_MARKET_API_URL = "https://www.edsm.net/api-system-v1/stations/market"
DEFAULT_HISTORY_SIZE = 8
DEFAULT_EDSM_LAG_GRACE_SECONDS = 180.0
LOOP_TICK_SECONDS = 1.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Listen to EDDN and report messages where StationType is FleetCarrier "
            "and show the system."
        ),
    )
    parser.add_argument(
        "--url",
        default="tcp://eddn.edcd.io:9500",
        help="Endpoint URL (tcp:// for EDDN listener, ws:// or wss:// for WebSocket).",
    )
    parser.add_argument(
        "--reconnect-delay",
        type=float,
        default=3.0,
        help="Delay (in seconds) before reconnecting after a disconnect/error.",
    )
    parser.add_argument(
        "--stats-interval",
        type=float,
        default=5.0,
        help="How often (in seconds) to print scan stats.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help=(
            "Pause and dump the full message for FleetCarrier hits that do not "
            "resolve a system name."
        ),
    )
    parser.add_argument(
        "--rapid-move-seconds",
        type=float,
        default=300.0,
        help=(
            "Flag carrier moves faster than this threshold as likely filtering issues."
        ),
    )
    parser.add_argument(
        "--verify-cache-ttl-seconds",
        type=float,
        default=120.0,
        help=(
            "How long to cache EDSM market verification results when debug mode is enabled."
        ),
    )
    parser.add_argument(
        "--history-size",
        type=int,
        default=DEFAULT_HISTORY_SIZE,
        help="How many recent messages to keep per marketId/uploaderID for diagnostics.",
    )
    parser.add_argument(
        "--edsm-lag-grace-seconds",
        type=float,
        default=DEFAULT_EDSM_LAG_GRACE_SECONDS,
        help=(
            "Grace window for EDSM mismatches before escalating to filtering issues."
        ),
    )
    return parser.parse_args()


def decode_eddn_payload(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, str):
        try:
            data = json.loads(payload)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None

    if not isinstance(payload, (bytes, bytearray)):
        return None

    raw = bytes(payload)

    # EDDN ZMQ commonly provides zlib-compressed JSON bytes.
    for candidate in (raw, zlib.decompress(raw) if raw else b""):
        if not candidate:
            continue
        try:
            data = json.loads(candidate.decode("utf-8"))
            return data if isinstance(data, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError, zlib.error):
            continue

    return None


def find_key_recursive(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for value in obj.values():
            found = find_key_recursive(value, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_key_recursive(value, key)
            if found is not None:
                return found
    return None


def get_system_name(message_obj: dict[str, Any]) -> str:
    for key in ("StarSystem", "SystemName", "systemName", "System"):
        value = find_key_recursive(message_obj, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return UNKNOWN_SYSTEM


def get_station_name(message_obj: dict[str, Any]) -> str:
    for key in ("StationName", "stationName"):
        value = find_key_recursive(message_obj, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return UNKNOWN_STATION


def get_uploader_id(doc: dict[str, Any]) -> str | None:
    header = doc.get("header")
    if not isinstance(header, dict):
        return None
    uploader_id = header.get("uploaderID")
    if isinstance(uploader_id, str) and uploader_id.strip():
        return uploader_id.strip()
    return None


def is_valid_fc_station_name(station_name: str) -> bool:
    if station_name == UNKNOWN_STATION:
        return False
    return FC_STATION_NAME_RE.fullmatch(station_name.upper()) is not None


def get_carrier_kind(station_name: str) -> str:
    if is_valid_fc_station_name(station_name):
        return "personal"
    return "squadron"


def get_market_id(message_obj: dict[str, Any]) -> int | None:
    value = find_key_recursive(message_obj, "MarketID")
    if isinstance(value, int):
        return value
    return None


def get_message_timestamp_epoch(message_obj: dict[str, Any]) -> float:
    raw_ts = find_key_recursive(message_obj, "timestamp")
    if isinstance(raw_ts, str) and raw_ts:
        try:
            return datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return datetime.now(timezone.utc).timestamp()


def get_carrier_key(message_obj: dict[str, Any]) -> str | None:
    market_id = get_market_id(message_obj)
    if market_id is not None:
        return f"market:{market_id}"

    station_name = get_station_name(message_obj)
    if station_name != UNKNOWN_STATION:
        return f"station:{station_name.upper()}"

    return None


def update_system_cache(
    doc: dict[str, Any],
    message_obj: dict[str, Any],
    station_to_system: dict[str, str],
    market_to_system: dict[int, str],
    uploader_to_system: dict[str, str],
) -> None:
    system_name = get_system_name(message_obj)
    if system_name == UNKNOWN_SYSTEM:
        return

    station_name = get_station_name(message_obj)
    if station_name != UNKNOWN_STATION:
        station_to_system[station_name] = system_name

    market_id = get_market_id(message_obj)
    if market_id is not None:
        market_to_system[market_id] = system_name

    uploader_id = get_uploader_id(doc)
    if uploader_id is not None:
        uploader_to_system[uploader_id] = system_name


def resolve_system_from_cache(
    doc: dict[str, Any],
    message_obj: dict[str, Any],
    station_to_system: dict[str, str],
    market_to_system: dict[int, str],
    uploader_to_system: dict[str, str],
) -> tuple[str, str]:
    market_id = get_market_id(message_obj)
    if market_id is not None:
        by_market = market_to_system.get(market_id)
        if by_market:
            return by_market, "market-cache"

    station_name = get_station_name(message_obj)
    if station_name != UNKNOWN_STATION:
        by_station = station_to_system.get(station_name)
        if by_station:
            return by_station, "station-cache"

    uploader_id = get_uploader_id(doc)
    if uploader_id is not None:
        by_uploader = uploader_to_system.get(uploader_id)
        if by_uploader:
            return by_uploader, "uploader-cache"

    return UNKNOWN_SYSTEM, "none"


def emit_debug_event(
    doc: dict[str, Any] | None,
    reason: str,
    debug: bool,
    debug_payload: Any | None = None,
) -> None:
    print(f"DEBUG EVENT: {reason}")
    if not debug:
        return

    payload_to_print = debug_payload if debug_payload is not None else doc
    if payload_to_print is None:
        return

    if isinstance(payload_to_print, (dict, list)):
        print(json.dumps(payload_to_print, indent=2, sort_keys=True, ensure_ascii=True))
    else:
        print(str(payload_to_print))

    try:
        input("Press Enter to continue...")
    except EOFError:
        # Non-interactive terminal: continue without blocking.
        pass


def append_history(
    history_map: dict[str, list[str]],
    key: str,
    entry: str,
    history_size: int,
) -> None:
    bucket = history_map.setdefault(key, [])
    bucket.append(entry)
    if len(bucket) > history_size:
        del bucket[: len(bucket) - history_size]


def build_history_entry(
    message_obj: dict[str, Any],
    resolved_system: str,
    system_source: str,
) -> str:
    msg_ts = find_key_recursive(message_obj, "timestamp")
    event_name = find_key_recursive(message_obj, "event")
    station_name = get_station_name(message_obj)
    market_id = get_market_id(message_obj)
    return (
        f"ts={msg_ts or '?'} event={event_name or '?'} station={station_name} "
        f"marketId={market_id if market_id is not None else '?'} "
        f"resolved={resolved_system} source={system_source}"
    )


def format_history_block(title: str, entries: list[str]) -> str:
    if not entries:
        return f"{title}: <empty>"
    lines = [title]
    for idx, entry in enumerate(entries, start=1):
        lines.append(f"  {idx}. {entry}")
    return "\n".join(lines)


def fetch_edsm_system_for_market_id(
    market_id: int,
) -> tuple[str | None, str | None, Any | None]:
    params = urllib.parse.urlencode({"marketId": market_id})
    url = f"{EDSM_MARKET_API_URL}?{params}"
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "User-Agent": "eddn-fleet-carrier-watch/1.0",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code} {exc.reason}", error_body
    except urllib.error.URLError as exc:
        return None, f"network error: {exc}", None

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, "invalid JSON response", body

    if not isinstance(data, dict):
        return None, "unexpected response type", data

    system_name = data.get("systemName") or data.get("name")
    if isinstance(system_name, str) and system_name.strip():
        return system_name.strip(), None, data

    return None, "system name missing in API response", data


def verify_resolved_position_with_edsm(
    doc: dict[str, Any],
    message_obj: dict[str, Any],
    inferred_system: str,
    system_source: str,
    debug: bool,
    edsm_market_cache: dict[int, tuple[float, str | None, str | None]],
    verify_cache_ttl_seconds: float,
    market_history: dict[str, list[str]],
    uploader_history: dict[str, list[str]],
    mismatch_tracker: dict[int, tuple[float, int, str, str, str, str | None]],
    edsm_lag_grace_seconds: float,
) -> str:
    if not debug:
        return ""
    if system_source not in {"market-cache", "uploader-cache"}:
        return ""

    market_id = get_market_id(message_obj)
    if market_id is None:
        emit_debug_event(
            doc,
            "EDSM verify skipped: cache-resolved system has no MarketID",
            debug,
        )
        return " [edsm-verify skipped: no MarketID]"

    now = time.monotonic()
    cached = edsm_market_cache.get(market_id)
    api_system: str | None
    api_error: str | None
    api_payload: Any | None
    if cached is not None and (now - cached[0]) <= verify_cache_ttl_seconds:
        api_system, api_error, api_payload = cached[1], cached[2], None
    else:
        api_system, api_error, api_payload = fetch_edsm_system_for_market_id(market_id)
        edsm_market_cache[market_id] = (now, api_system, api_error)

    if api_error is not None:
        emit_debug_event(
            doc,
            f"EDSM verify failed for marketId {market_id}: {api_error}",
            debug,
            debug_payload={
                "source": "edsm-api",
                "marketId": market_id,
                "response": api_payload,
            },
        )
        return " [edsm-verify error]"

    if api_system is None:
        emit_debug_event(
            doc,
            f"EDSM verify failed for marketId {market_id}: empty system",
            debug,
            debug_payload={
                "source": "edsm-api",
                "marketId": market_id,
                "response": api_payload,
            },
        )
        return " [edsm-verify empty]"

    if api_system != inferred_system:
        source_label = "marketId" if system_source == "market-cache" else "uploaderID"
        now = time.monotonic()
        previous_mismatch = mismatch_tracker.get(market_id)
        if previous_mismatch is None:
            first_seen = now
            mismatch_count = 1
        else:
            first_seen, mismatch_count, _, _, _, _ = previous_mismatch
            mismatch_count += 1

        uploader_id = get_uploader_id(doc)

        mismatch_tracker[market_id] = (
            first_seen,
            mismatch_count,
            inferred_system,
            api_system,
            source_label,
            uploader_id,
        )

        elapsed = now - first_seen
        if elapsed < edsm_lag_grace_seconds:
            return " [edsm pending]"

        reason = (
            f"FILTERING ISSUE ({source_label}_MISMATCH): persistent cache-resolved system "
            f"differs from EDSM (marketId={market_id}, inferred='{inferred_system}', "
            f"edsm='{api_system}', duration={elapsed:.1f}s, occurrences={mismatch_count})"
        )

        market_block = format_history_block(
            f"Recent marketId history ({market_id})",
            market_history.get(f"market:{market_id}", []),
        )

        uploader_entries: list[str] = []
        if uploader_id is not None:
            uploader_entries = uploader_history.get(f"uploader:{uploader_id}", [])
        uploader_block = format_history_block(
            f"Recent uploaderID history ({uploader_id if uploader_id is not None else '?'})",
            uploader_entries,
        )

        emit_debug_event(doc, f"{reason}\n{market_block}\n{uploader_block}", debug)
        return " [edsm mismatch]"

    mismatch_tracker.pop(market_id, None)
    return " [edsm ok]"


def process_pending_edsm_rechecks(
    debug: bool,
    mismatch_tracker: dict[int, tuple[float, int, str, str, str, str | None]],
    edsm_market_cache: dict[int, tuple[float, str | None, str | None]],
    market_history: dict[str, list[str]],
    uploader_history: dict[str, list[str]],
    edsm_lag_grace_seconds: float,
) -> None:
    now = time.monotonic()
    pending_market_ids = list(mismatch_tracker.keys())

    for market_id in pending_market_ids:
        first_seen, mismatch_count, inferred_system, _, source_label, uploader_id = (
            mismatch_tracker[market_id]
        )
        elapsed = now - first_seen
        if elapsed < edsm_lag_grace_seconds:
            continue

        api_system, api_error, _ = fetch_edsm_system_for_market_id(market_id)
        edsm_market_cache[market_id] = (now, api_system, api_error)

        if api_error is not None:
            emit_debug_event(
                None,
                (
                    f"EDSM recheck failed for marketId {market_id}: {api_error} "
                    f"(elapsed={elapsed:.1f}s)"
                ),
                debug,
            )
            continue

        if api_system == inferred_system:
            emit_debug_event(
                None,
                (
                    f"EDSM recheck resolved for marketId {market_id}: "
                    f"inferred='{inferred_system}' now matches EDSM after {elapsed:.1f}s"
                ),
                debug,
            )
            mismatch_tracker.pop(market_id, None)
            continue

        market_block = format_history_block(
            f"Recent marketId history ({market_id})",
            market_history.get(f"market:{market_id}", []),
        )
        uploader_entries: list[str] = []
        if uploader_id is not None:
            uploader_entries = uploader_history.get(f"uploader:{uploader_id}", [])
        uploader_block = format_history_block(
            f"Recent uploaderID history ({uploader_id if uploader_id is not None else '?'})",
            uploader_entries,
        )

        emit_debug_event(
            None,
            (
                f"FILTERING ISSUE ({source_label}_MISMATCH): persistent cache-resolved system "
                f"differs from EDSM on timed recheck (marketId={market_id}, "
                f"inferred='{inferred_system}', edsm='{api_system}', "
                f"duration={elapsed:.1f}s, occurrences={mismatch_count})\n"
                f"{market_block}\n{uploader_block}"
            ),
            debug,
        )
        mismatch_tracker.pop(market_id, None)


def handle_message(
    doc: dict[str, Any],
    debug: bool,
    station_to_system: dict[str, str],
    market_to_system: dict[int, str],
    uploader_to_system: dict[str, str],
    carrier_last_seen: dict[str, tuple[str, float]],
    rapid_move_seconds: float,
    edsm_market_cache: dict[int, tuple[float, str | None, str | None]],
    verify_cache_ttl_seconds: float,
    market_history: dict[str, list[str]],
    uploader_history: dict[str, list[str]],
    history_size: int,
    mismatch_tracker: dict[int, tuple[float, int, str, str, str, str | None]],
    edsm_lag_grace_seconds: float,
) -> bool:
    message_obj = doc.get("message")
    if not isinstance(message_obj, dict):
        return False

    update_system_cache(
        doc, message_obj, station_to_system, market_to_system, uploader_to_system
    )

    station_type = find_key_recursive(message_obj, "StationType")
    if station_type != "FleetCarrier":
        return False

    system_name = get_system_name(message_obj)
    system_source = "message"
    if system_name == UNKNOWN_SYSTEM:
        system_name, system_source = resolve_system_from_cache(
            doc, message_obj, station_to_system, market_to_system, uploader_to_system
        )

    station_name = get_station_name(message_obj)
    carrier_kind = get_carrier_kind(station_name)
    event_name = find_key_recursive(message_obj, "event")

    if system_name == UNKNOWN_SYSTEM and event_name in MISSING_SYSTEM_EVENTS:
        system_name = "unknown"

    history_entry = build_history_entry(message_obj, system_name, system_source)
    market_id = get_market_id(message_obj)
    if market_id is not None:
        append_history(
            market_history,
            f"market:{market_id}",
            history_entry,
            history_size,
        )
    uploader_id = get_uploader_id(doc)
    if uploader_id is not None:
        append_history(
            uploader_history,
            f"uploader:{uploader_id}",
            history_entry,
            history_size,
        )

    verify_suffix = verify_resolved_position_with_edsm(
        doc,
        message_obj,
        system_name,
        system_source,
        debug,
        edsm_market_cache,
        verify_cache_ttl_seconds,
        market_history,
        uploader_history,
        mismatch_tracker,
        edsm_lag_grace_seconds,
    )

    movement_suffix = ""
    carrier_key = get_carrier_key(message_obj)
    message_epoch = get_message_timestamp_epoch(message_obj)
    if carrier_key is not None and system_name not in (UNKNOWN_SYSTEM, "unknown"):
        previous = carrier_last_seen.get(carrier_key)
        if previous is not None:
            previous_system, previous_epoch = previous
            if previous_system != system_name:
                movement_suffix = f" [moved: {previous_system} -> {system_name}]"
                move_delta = message_epoch - previous_epoch
                if move_delta < 0:
                    movement_suffix = (
                        f" [moved: {previous_system} -> {system_name} "
                        "(out-of-order timestamp)]"
                    )
                elif move_delta < rapid_move_seconds:
                    emit_debug_event(
                        doc,
                        (
                            "FILTERING ISSUE: rapid carrier movement detected "
                            f"({move_delta:.1f}s, threshold={rapid_move_seconds:.1f}s)"
                        ),
                        debug,
                    )

        # Do not let out-of-order/backfilled events move the tracking cursor backward.
        if previous is None or message_epoch >= previous[1]:
            carrier_last_seen[carrier_key] = (system_name, message_epoch)

    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    suffix = ""
    if system_source == "market-cache":
        suffix = " [resolved via MarketID cache]"
    elif system_source == "station-cache":
        suffix = " [resolved via StationName cache]"
    elif system_source == "uploader-cache":
        suffix = " [resolved via uploaderID cache]"
    print(
        f"[{timestamp}] FleetCarrier in system: {system_name} | station: {station_name} "
        f"({carrier_kind}){suffix}{movement_suffix}{verify_suffix}"
    )

    if debug and system_name == UNKNOWN_SYSTEM and event_name not in MISSING_SYSTEM_EVENTS:
        emit_debug_event(doc, "FleetCarrier message missing known system field", debug)

    return True


async def run_ws(
    url: str,
    reconnect_delay: float,
    stats_interval: float,
    debug: bool,
    rapid_move_seconds: float,
    verify_cache_ttl_seconds: float,
    history_size: int,
    edsm_lag_grace_seconds: float,
) -> None:
    import websockets

    station_to_system: dict[str, str] = {}
    market_to_system: dict[int, str] = {}
    uploader_to_system: dict[str, str] = {}
    carrier_last_seen: dict[str, tuple[str, float]] = {}
    edsm_market_cache: dict[int, tuple[float, str | None, str | None]] = {}
    market_history: dict[str, list[str]] = {}
    uploader_history: dict[str, list[str]] = {}
    mismatch_tracker: dict[int, tuple[float, int, str, str, str, str | None]] = {}

    while True:
        scanned = 0
        matched = 0
        last_stats = time.monotonic()

        print(f"Connecting to {url}...")
        try:
            async with websockets.connect(url, max_size=None) as ws:
                print("Connected. Press Ctrl+C to stop.")

                while True:
                    raw = None
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=LOOP_TICK_SECONDS)
                    except asyncio.TimeoutError:
                        pass

                    if raw is not None:
                        doc = decode_eddn_payload(raw)
                        if doc is not None:
                            scanned += 1
                            if handle_message(
                                doc,
                                debug,
                                station_to_system,
                                market_to_system,
                                uploader_to_system,
                                carrier_last_seen,
                                rapid_move_seconds,
                                edsm_market_cache,
                                verify_cache_ttl_seconds,
                                market_history,
                                uploader_history,
                                history_size,
                                mismatch_tracker,
                                edsm_lag_grace_seconds,
                            ):
                                matched += 1

                    process_pending_edsm_rechecks(
                        debug,
                        mismatch_tracker,
                        edsm_market_cache,
                        market_history,
                        uploader_history,
                        edsm_lag_grace_seconds,
                    )

                    now = time.monotonic()
                    if now - last_stats >= stats_interval:
                        print(f"Scanned: {scanned} | FleetCarrier matches: {matched}")
                        last_stats = now

        except asyncio.CancelledError:
            raise
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"Disconnected: {exc}")
            print(f"Reconnecting in {reconnect_delay:.1f}s...")
            await asyncio.sleep(reconnect_delay)


def run_tcp(
    url: str,
    reconnect_delay: float,
    stats_interval: float,
    debug: bool,
    rapid_move_seconds: float,
    verify_cache_ttl_seconds: float,
    history_size: int,
    edsm_lag_grace_seconds: float,
) -> None:
    import zmq  # pyright: ignore[reportMissingImports]

    station_to_system: dict[str, str] = {}
    market_to_system: dict[int, str] = {}
    uploader_to_system: dict[str, str] = {}
    carrier_last_seen: dict[str, tuple[str, float]] = {}
    edsm_market_cache: dict[int, tuple[float, str | None, str | None]] = {}
    market_history: dict[str, list[str]] = {}
    uploader_history: dict[str, list[str]] = {}
    mismatch_tracker: dict[int, tuple[float, int, str, str, str, str | None]] = {}

    while True:
        socket = None
        scanned = 0
        matched = 0
        last_stats = time.monotonic()

        print(f"Connecting to {url}...")
        try:
            context = zmq.Context.instance()
            socket = context.socket(zmq.SUB)
            socket.setsockopt_string(zmq.SUBSCRIBE, "")
            socket.connect(url)
            print("Connected. Press Ctrl+C to stop.")

            while True:
                if socket.poll(int(LOOP_TICK_SECONDS * 1000), zmq.POLLIN):
                    raw = socket.recv()
                    doc = decode_eddn_payload(raw)
                    if doc is not None:
                        scanned += 1
                        if handle_message(
                            doc,
                            debug,
                            station_to_system,
                            market_to_system,
                            uploader_to_system,
                            carrier_last_seen,
                            rapid_move_seconds,
                            edsm_market_cache,
                            verify_cache_ttl_seconds,
                            market_history,
                            uploader_history,
                            history_size,
                            mismatch_tracker,
                            edsm_lag_grace_seconds,
                        ):
                            matched += 1

                process_pending_edsm_rechecks(
                    debug,
                    mismatch_tracker,
                    edsm_market_cache,
                    market_history,
                    uploader_history,
                    edsm_lag_grace_seconds,
                )

                now = time.monotonic()
                if now - last_stats >= stats_interval:
                    print(f"Scanned: {scanned} | FleetCarrier matches: {matched}")
                    last_stats = now

        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"Disconnected: {exc}")
            print(f"Reconnecting in {reconnect_delay:.1f}s...")
            time.sleep(reconnect_delay)
        finally:
            if socket is not None:
                socket.close(linger=0)


def main() -> None:
    args = parse_args()

    if args.reconnect_delay < 0:
        raise ValueError("--reconnect-delay must be >= 0")
    if args.stats_interval <= 0:
        raise ValueError("--stats-interval must be > 0")
    if args.rapid_move_seconds <= 0:
        raise ValueError("--rapid-move-seconds must be > 0")
    if args.verify_cache_ttl_seconds <= 0:
        raise ValueError("--verify-cache-ttl-seconds must be > 0")
    if args.history_size <= 0:
        raise ValueError("--history-size must be > 0")
    if args.edsm_lag_grace_seconds <= 0:
        raise ValueError("--edsm-lag-grace-seconds must be > 0")

    try:
        if args.url.startswith("tcp://"):
            run_tcp(
                args.url,
                args.reconnect_delay,
                args.stats_interval,
                args.debug,
                args.rapid_move_seconds,
                args.verify_cache_ttl_seconds,
                args.history_size,
                args.edsm_lag_grace_seconds,
            )
        elif args.url.startswith("ws://") or args.url.startswith("wss://"):
            asyncio.run(
                run_ws(
                    args.url,
                    args.reconnect_delay,
                    args.stats_interval,
                    args.debug,
                    args.rapid_move_seconds,
                    args.verify_cache_ttl_seconds,
                    args.history_size,
                    args.edsm_lag_grace_seconds,
                )
            )
        else:
            raise ValueError("--url must start with tcp://, ws://, or wss://")
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
