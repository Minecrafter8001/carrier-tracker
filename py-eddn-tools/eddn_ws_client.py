#!/usr/bin/env python3
"""Simple EDDN WebSocket client that reports updates per second."""

from __future__ import annotations

import argparse
import asyncio
import time

from tqdm import tqdm


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Connect to an EDDN WebSocket endpoint and display updates per second.",
    )
    parser.add_argument(
        "--url",
        default="tcp://eddn.edcd.io:9500",
        help="Endpoint URL to connect to (tcp:// for EDDN listener, ws:// or wss:// for WebSocket).",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="How often (in seconds) to print the update rate.",
    )
    parser.add_argument(
        "--reconnect-delay",
        type=float,
        default=3.0,
        help="Delay (in seconds) before reconnecting after a disconnect/error.",
    )
    return parser.parse_args()


async def run_client(url: str, interval: float, reconnect_delay: float) -> None:
    import websockets

    while True:
        pbar = None
        print(f"Connecting to {url}...")
        try:
            async with websockets.connect(url, max_size=None) as ws:
                print("Connected. Press Ctrl+C to stop.")
                pbar = tqdm(
                    total=None,
                    desc="EDDN",
                    unit="msg",
                    mininterval=interval,
                    dynamic_ncols=True,
                )
                next_refresh = time.monotonic() + interval

                while True:
                    timeout = max(0.0, next_refresh - time.monotonic())

                    try:
                        await asyncio.wait_for(ws.recv(), timeout=timeout)
                        pbar.update(1)
                    except asyncio.TimeoutError:
                        pass

                    now = time.monotonic()
                    if now >= next_refresh:
                        pbar.refresh()
                        next_refresh = now + interval

        except asyncio.CancelledError:
            raise
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"Disconnected: {exc}")
            print(f"Reconnecting in {reconnect_delay:.1f}s...")
            await asyncio.sleep(reconnect_delay)
        finally:
            if pbar is not None:
                pbar.close()


def run_tcp_client(url: str, interval: float, reconnect_delay: float) -> None:
    import zmq  # pyright: ignore[reportMissingImports]

    while True:
        socket = None
        pbar = None
        try:
            print(f"Connecting to {url}...")
            context = zmq.Context.instance()
            socket = context.socket(zmq.SUB)
            socket.setsockopt_string(zmq.SUBSCRIBE, "")
            socket.connect(url)
            print("Connected. Press Ctrl+C to stop.")
            pbar = tqdm(
                total=None,
                desc="EDDN",
                unit="msg",
                mininterval=interval,
                dynamic_ncols=True,
            )
            next_refresh = time.monotonic() + interval

            while True:
                timeout_s = max(0.0, next_refresh - time.monotonic())
                timeout_ms = max(1, int(timeout_s * 1000))

                if socket.poll(timeout_ms, zmq.POLLIN):
                    socket.recv()
                    pbar.update(1)

                now = time.monotonic()
                if now >= next_refresh:
                    pbar.refresh()
                    next_refresh = now + interval

        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"Disconnected: {exc}")
            print(f"Reconnecting in {reconnect_delay:.1f}s...")
            time.sleep(reconnect_delay)
        finally:
            if pbar is not None:
                pbar.close()
            if socket is not None:
                socket.close(linger=0)


def main() -> None:
    args = parse_args()
    if args.interval <= 0:
        raise ValueError("--interval must be greater than 0")
    if args.reconnect_delay < 0:
        raise ValueError("--reconnect-delay must be >= 0")

    try:
        if args.url.startswith("tcp://"):
            run_tcp_client(args.url, args.interval, args.reconnect_delay)
        elif args.url.startswith("ws://") or args.url.startswith("wss://"):
            asyncio.run(run_client(args.url, args.interval, args.reconnect_delay))
        else:
            raise ValueError("--url must start with tcp://, ws://, or wss://")
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
