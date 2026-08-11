"""aiohttp application assembly: middleware, static assets, lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import deque
from urllib.parse import urlparse

from aiohttp import WSCloseCode, web

from . import api
from .catalog import CommandCatalog
from .config import WEB_DIR, AppConfig
from .events import EventBus
from .logs import LogTailer
from .metrics import MetricsSampler
from .session import PM3Session, SessionNotRunning

log = logging.getLogger("pm3gui")

#: Headers applied to every response. The CSP keeps the frontend self-contained:
#: no third-party scripts, styles, fonts or XHR targets are permitted.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'none'"
    ),
}


@web.middleware
async def security_middleware(request: web.Request, handler):
    config: AppConfig = request.app["config"]

    # --- token auth (mandatory whenever we are not bound to loopback) -------
    if config.auth_token:
        supplied = (request.headers.get("X-PM3-Token")
                    or request.query.get("token")
                    or "")
        if supplied != config.auth_token:
            return web.json_response(
                {"ok": False, "error": "Invalid or missing access token"}, status=401)

    # --- cross-origin protection for state-changing calls and sockets -------
    if request.method not in ("GET", "HEAD", "OPTIONS") or request.path.startswith("/ws/"):
        origin = request.headers.get("Origin")
        if origin:
            host = urlparse(origin).netloc
            if host != request.headers.get("Host"):
                return web.json_response(
                    {"ok": False, "error": "Cross-origin request rejected"}, status=403)

    response = await handler(request)
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


@web.middleware
async def error_middleware(request: web.Request, handler):
    """Return JSON errors for /api routes so the UI can always render a state."""
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if request.path.startswith("/api/") and exc.content_type != "application/json":
            return web.json_response({"ok": False, "error": exc.reason},
                                     status=exc.status)
        raise
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("Unhandled error handling %s", request.path)
        if request.path.startswith("/api/"):
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=500)
        raise


async def index(request: web.Request) -> web.Response:
    response = web.FileResponse(WEB_DIR / "index.html")
    response.headers["Cache-Control"] = "no-cache"
    return response


async def on_startup(app: web.Application) -> None:
    config: AppConfig = app["config"]
    app["metrics"].start()
    app["logtailer"].start()

    if not config.autostart:
        return

    port = config.serial_port
    if port is None:
        from . import devices
        port = await asyncio.get_running_loop().run_in_executor(None, devices.auto_detect)

    # A USB-CDC port can still be held for a moment by a previous client, so a
    # single failure is not conclusive; retry briefly before deciding.
    attempts = 3 if port else 1
    for attempt in range(1, attempts + 1):
        try:
            await app["session"].start(port or "")
            return
        except SessionNotRunning as exc:
            log.warning("Client autostart attempt %d/%d failed: %s",
                        attempt, attempts, exc)
            if not port:
                app["bus"].notify(
                    "error", "Client not started", str(exc),
                    hint="Build it with `make client` or start it from the Hardware page.")
                return
            if attempt < attempts:
                await asyncio.sleep(2)

    # Starting against the detected device failed — most often a firmware/client
    # version mismatch, where the client exits rather than falling back. Retry
    # offline so the interface is still usable and say why.
    from . import parsers
    diagnosis = parsers.diagnose(app["session"].scrollback())
    try:
        await app["session"].start("")
        app["bus"].notify(
            "warning",
            diagnosis["title"] if diagnosis else f"Could not attach {port}",
            (diagnosis["remedy"] if diagnosis
             else "The client is running in OFFLINE mode instead."),
            link="#/hardware")
    except SessionNotRunning as exc:
        log.warning("Offline fallback failed too: %s", exc)
        app["bus"].notify(
            "error", "Client not started", str(exc),
            hint="Start it from the Hardware page.")


async def on_shutdown(app: web.Application) -> None:
    """Close live WebSockets before the runner waits on them.

    aiohttp's graceful shutdown blocks until open connections finish, and a
    WebSocket never finishes on its own — so a browser tab left open would hold
    the server (and therefore the proxmark3 client, and therefore the serial
    port) for the full shutdown timeout. Closing them here makes stopping
    prompt, which matters because the next start has to reopen that port.
    """
    for ws in set(app["websockets"]):
        with contextlib.suppress(Exception):
            await ws.close(code=WSCloseCode.GOING_AWAY, message=b"server shutdown")
    app["websockets"].clear()


async def on_cleanup(app: web.Application) -> None:
    await app["metrics"].stop()
    await app["logtailer"].stop()
    await app["session"].aclose()


def create_app(config: AppConfig) -> web.Application:
    app = web.Application(middlewares=[error_middleware, security_middleware],
                          client_max_size=16 * 1024 * 1024)
    bus = EventBus()
    session = PM3Session(config, bus)

    app["config"] = config
    app["bus"] = bus
    app["session"] = session
    app["catalog"] = CommandCatalog.load(config.commands_json)
    app["metrics"] = MetricsSampler(bus, session)
    app["logtailer"] = LogTailer(bus, config.log_dir)
    app["scans"] = deque(maxlen=50)
    #: Live WebSockets, so shutdown can close them instead of waiting.
    app["websockets"] = set()

    app.add_routes(api.routes)
    app.router.add_get("/", index)
    app.router.add_static("/assets/", WEB_DIR / "assets", name="assets", follow_symlinks=False)
    app.router.add_static("/css/", WEB_DIR / "css", name="css", follow_symlinks=False)
    app.router.add_static("/js/", WEB_DIR / "js", name="js", follow_symlinks=False)

    # SPA fallback: unknown non-API paths render the shell and the hash router
    # takes over.
    async def spa_fallback(request: web.Request) -> web.Response:
        if request.path.startswith(("/api/", "/ws/")):
            return web.json_response({"ok": False, "error": "Not found"}, status=404)
        return await index(request)

    app.router.add_route("GET", "/{tail:.*}", spa_fallback)

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app
