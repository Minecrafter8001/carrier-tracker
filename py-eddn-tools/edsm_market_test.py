#!/usr/bin/env python3
"""Test EDSM station market API with a specific market ID."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

API_URL = "https://www.edsm.net/api-system-v1/stations/market"
MARKET_ID = 3962982914


def main() -> int:
    params = urllib.parse.urlencode({"marketId": MARKET_ID})
    url = f"{API_URL}?{params}"

    print(f"Request URL: {url}")

    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "User-Agent": "eddn-market-test/1.0",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = response.getcode()
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP error: {exc.code} {exc.reason}")
        if error_body:
            print(error_body)
        return 1
    except urllib.error.URLError as exc:
        print(f"Network error: {exc}")
        return 1

    print(f"HTTP status: {status}")

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print("Response is not valid JSON.")
        print(body)
        return 1

    if isinstance(data, dict):
        system_name = data.get("systemName") or data.get("name") or "<missing>"
        station_name = data.get("stationName") or data.get("sName") or "<missing>"
        station_type = data.get("type") or data.get("stationType") or "<missing>"
        market_id = data.get("marketId") or "<missing>"

        print("Summary:")
        print(f"  system: {system_name}")
        print(f"  station: {station_name}")
        print(f"  station type: {station_type}")
        print(f"  marketId: {market_id}")

    print("\nFull JSON:")
    print(json.dumps(data, indent=2, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
