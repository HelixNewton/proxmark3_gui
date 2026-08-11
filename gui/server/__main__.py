"""Entry point: ``python3 -m gui.server`` (or the ``gui/pm3-gui`` wrapper)."""

from __future__ import annotations

import argparse
import logging
import sys
import webbrowser
from pathlib import Path

from aiohttp import web

from .app import create_app
from .config import AppConfig, find_client_binary

BANNER = r"""
   ___  __  ______  _______  __  _______  ___  __ _______
  / _ \/  |/  /_  |/ ___/ / / / / __/ _ \/ _ \/ // / __/
 / ___/ /|_/ / __// (_ / /_/ / _\ \/ // / , _/ _  / _/
/_/  /_/  /_/____/\___/\____/ /___/\___/_/|_/_//_/___/   COMMAND CENTRE
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="pm3-gui",
        description="Web command centre for the Proxmark3 client.")
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8788,
                        help="listen port (default: 8788)")
    parser.add_argument("-p", "--serial-port", default=None,
                        help="serial port of the Proxmark3 (default: auto-detect)")
    parser.add_argument("--offline", action="store_true",
                        help="start the client without connecting to a device")
    parser.add_argument("--no-autostart", action="store_true",
                        help="do not launch the proxmark3 client at startup")
    parser.add_argument("--client", default=None,
                        help="path to the proxmark3 binary (default: auto-detect)")
    parser.add_argument("--incognito", action="store_true",
                        help="client writes no history, preferences or log files")
    parser.add_argument("--token", default=None,
                        help="require this access token (auto-generated for "
                             "non-loopback binds)")
    parser.add_argument("--open", action="store_true",
                        help="open the interface in a browser once started")
    parser.add_argument("--debug", action="store_true", help="verbose logging")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S")

    binary = Path(args.client).expanduser().resolve() if args.client else find_client_binary()
    config = AppConfig(
        host=args.host,
        port=args.port,
        client_binary=binary,
        serial_port="" if args.offline else args.serial_port,
        autostart=not args.no_autostart,
        incognito=args.incognito,
        auth_token=args.token,
        open_browser=args.open,
        debug=args.debug,
    )

    print(BANNER)
    if binary:
        print(f"  client binary .... {binary}")
    else:
        print("  client binary .... NOT FOUND — run `make client` in the repo root.")
        print("                     The interface still starts; it will show the")
        print("                     missing-binary state instead of fake data.")

    url = f"http://{'127.0.0.1' if config.host in ('0.0.0.0', '::') else config.host}:{config.port}/"
    if config.auth_token:
        url += f"?token={config.auth_token}"
        print(f"  access token ..... {config.auth_token}")
        if not args.token:
            print("                     (generated because the bind address is not "
                  "loopback)")
    print(f"  interface ........ {url}\n")
    # stdout is block-buffered when it is not a terminal, which would hide the
    # access token from anyone running this under a supervisor or a pipe.
    sys.stdout.flush()

    app = create_app(config)
    if config.open_browser:
        app.on_startup.append(lambda _app: _open_browser(url))
    try:
        web.run_app(app, host=config.host, port=config.port, print=None,
                    access_log=None if not args.debug else logging.getLogger("access"))
    except OSError as exc:
        print(f"[!!] Could not bind {config.host}:{config.port} — {exc}", file=sys.stderr)
        return 1
    return 0


async def _open_browser(url: str) -> None:  # pragma: no cover - convenience
    try:
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
