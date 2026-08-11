"""REST and WebSocket surface of the PM3 command centre.

Design rules enforced here:

* Every action maps to a real proxmark3 client command. Nothing is simulated.
* Anything that mutates the device or the filesystem is a POST/DELETE and, when
  destructive, additionally requires an explicit ``confirm`` field.
* Commands built from user input are assembled from validated fragments; the
  client's own CLI parser is the only parser involved — no shell, ever.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time

from aiohttp import WSMsgType, web

from . import devices, files, logs, parsers, scripts
from .session import SessionBusy, SessionNotRunning

routes = web.RouteTableDef()

LONG_TIMEOUT = 120.0


# --------------------------------------------------------------------- helpers
def ctx(request: web.Request):
    app = request.app
    return app["config"], app["bus"], app["session"], app["catalog"], app["metrics"]


def ok(payload: dict | list, **extra) -> web.Response:
    body = payload if isinstance(payload, dict) else {"items": payload}
    return web.json_response({"ok": True, **body, **extra})


def fail(message: str, status: int = 400, **extra) -> web.Response:
    return web.json_response({"ok": False, "error": message, **extra}, status=status)


async def body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except (json.JSONDecodeError, ValueError):
        raise web.HTTPBadRequest(text=json.dumps({"ok": False, "error": "Invalid JSON body"}),
                                 content_type="application/json")
    return data if isinstance(data, dict) else {}


async def run_command(request: web.Request, command: str, timeout: float = 30.0):
    """Execute a command, translating session errors into HTTP responses."""
    _, _, session, _, _ = ctx(request)
    try:
        return await session.execute(command, timeout=timeout)
    except SessionNotRunning as exc:
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"ok": False, "error": str(exc), "reason": "not-running"}),
            content_type="application/json")
    except SessionBusy as exc:
        raise web.HTTPConflict(
            text=json.dumps({"ok": False, "error": str(exc), "reason": "busy"}),
            content_type="application/json")
    except ValueError as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": str(exc)}),
            content_type="application/json")


# ------------------------------------------------------------------ status/meta
@routes.get("/api/status")
async def get_status(request: web.Request) -> web.Response:
    config, bus, session, catalog, metrics = ctx(request)
    return ok({
        "session": session.state(),
        "host": metrics.host_info(),
        "catalog": {
            "count": len(catalog.commands),
            "groups": catalog.groups,
            "metadata": catalog.metadata,
            "source": catalog.source,
            "error": catalog.error,
        },
        "paths": {name: str(path) for name, path in config.roots.items()},
        "clientBinary": str(config.client_binary) if config.client_binary else None,
        "serverTime": time.time(),
        "notifications": list(bus.notifications)[-30:],
    })


@routes.get("/api/devices")
async def get_devices(request: web.Request) -> web.Response:
    result = await asyncio.get_running_loop().run_in_executor(None, devices.list_serial_ports)
    return ok(result)


@routes.post("/api/session/start")
async def post_session_start(request: web.Request) -> web.Response:
    config, _, session, _, _ = ctx(request)
    data = await body(request)
    port = data.get("port")
    if port is None and data.get("auto", True):
        port = await asyncio.get_running_loop().run_in_executor(None, devices.auto_detect)
    if port is not None and not isinstance(port, str):
        return fail("port must be a string")
    if port and not port.startswith("/dev/") and not port.startswith("COM"):
        return fail("Refusing to open a path outside /dev")
    try:
        state = await session.start(port or "")
    except SessionNotRunning as exc:
        return fail(str(exc), status=503)
    return ok({"session": state})


@routes.post("/api/session/stop")
async def post_session_stop(request: web.Request) -> web.Response:
    _, _, session, _, _ = ctx(request)
    return ok({"session": await session.stop()})


@routes.post("/api/session/restart")
async def post_session_restart(request: web.Request) -> web.Response:
    _, _, session, _, _ = ctx(request)
    data = await body(request)
    port = data.get("port")
    if port is None and data.get("auto", True):
        port = await asyncio.get_running_loop().run_in_executor(None, devices.auto_detect)
    try:
        return ok({"session": await session.restart(port or "")})
    except SessionNotRunning as exc:
        return fail(str(exc), status=503)


@routes.post("/api/session/interrupt")
async def post_session_interrupt(request: web.Request) -> web.Response:
    """Abort the running command (sends Enter — see ``PM3Session.interrupt``)."""
    _, bus, session, _, _ = ctx(request)
    await session.interrupt()
    bus.emit("session.interrupt")
    return ok({"session": session.state()})


@routes.post("/api/session/connect")
async def post_session_connect(request: web.Request) -> web.Response:
    """Attach to a device from inside the running client (``hw connect``)."""
    data = await body(request)
    port = (data.get("port") or "").strip()
    if port and not port.startswith("/dev/"):
        return fail("Refusing to open a path outside /dev")
    command = f"hw connect -p {port}" if port else "hw connect"
    result = await run_command(request, command, timeout=45)
    _, _, session, _, _ = ctx(request)
    return ok({
        "result": result.to_dict(),
        "connected": session.connected,
        # A recognised failure gets a real explanation; anything else falls back
        # to the client's own output.
        "diagnosis": parsers.diagnose(result.output) if not session.connected else None,
    })


# ---------------------------------------------------------------- command exec
@routes.post("/api/exec")
async def post_exec(request: web.Request) -> web.Response:
    data = await body(request)
    command = (data.get("command") or "").strip()
    if not command:
        return fail("command is required")
    if len(command) > 4096:
        return fail("command too long")
    timeout = float(data.get("timeout") or 30.0)
    timeout = max(1.0, min(timeout, 600.0))
    result = await run_command(request, command, timeout=timeout)
    return ok({"result": result.to_dict()})


@routes.get("/api/commands")
async def get_commands(request: web.Request) -> web.Response:
    _, _, _, catalog, _ = ctx(request)
    query = request.query.get("q", "")
    group = request.query.get("group")
    limit = min(int(request.query.get("limit", 60) or 60), 1000)
    offline_only = request.query.get("offline") == "1"
    results = catalog.search(query, limit=limit if not group else 1000,
                             offline_only=offline_only)
    if group:
        results = [c for c in results if c["group"] == group][:limit]
    return ok({"commands": results, "total": len(catalog.commands),
               "groups": catalog.groups})


@routes.get("/api/commands/detail")
async def get_command_detail(request: web.Request) -> web.Response:
    _, _, _, catalog, _ = ctx(request)
    name = request.query.get("name", "")
    command = catalog.get(name)
    if not command:
        return fail(f"Unknown command '{name}'", status=404)
    return ok({"command": command.to_dict(), "options": catalog.option_flags(name)})


@routes.get("/api/complete")
async def get_complete(request: web.Request) -> web.Response:
    _, _, _, catalog, _ = ctx(request)
    return ok({"suggestions": catalog.complete(request.query.get("q", ""))})


# -------------------------------------------------------------------- hardware
@routes.get("/api/hw/version")
async def get_hw_version(request: web.Request) -> web.Response:
    result = await run_command(request, "hw version", timeout=20)
    return ok({"version": parsers.parse_version(result.output),
               "result": result.to_dict()})


@routes.get("/api/hw/status")
async def get_hw_status(request: web.Request) -> web.Response:
    _, _, session, _, _ = ctx(request)
    if not session.connected:
        return fail("`hw status` needs a connected device", status=409,
                    reason="offline")
    result = await run_command(request, "hw status", timeout=30)
    return ok({"status": parsers.parse_sections(result.output),
               "result": result.to_dict()})


@routes.get("/api/hw/tune")
async def get_hw_tune(request: web.Request) -> web.Response:
    _, _, session, _, _ = ctx(request)
    if not session.connected:
        return fail("`hw tune` needs a connected device", status=409, reason="offline")
    result = await run_command(request, "hw tune", timeout=90)
    return ok({"tune": parsers.parse_tune(result.output), "result": result.to_dict()})


#: Device actions exposed as buttons. Destructive ones require ``confirm: true``.
HW_ACTIONS: dict[str, dict] = {
    "ping":       {"cmd": "hw ping", "label": "Ping device", "timeout": 15},
    "reset":      {"cmd": "hw reset", "label": "Reset device", "timeout": 20,
                   "confirm": True, "note": "The device reboots and the link drops."},
    "fpgaoff":    {"cmd": "hw fpgaoff", "label": "Turn off FPGA/antenna field", "timeout": 15},
    "tia":        {"cmd": "hw tia", "label": "Timing interval acquisition", "timeout": 30},
    "break":      {"cmd": "hw break", "label": "Send break", "timeout": 15},
    "bootloader": {"cmd": "hw bootloader", "label": "Reboot into bootloader", "timeout": 20,
                   "confirm": True,
                   "note": "The client link drops; the device waits for a flash."},
    "lcdreset":   {"cmd": "hw lcdreset", "label": "Reset LCD", "timeout": 15},
}


@routes.get("/api/hw/actions")
async def get_hw_actions(request: web.Request) -> web.Response:
    return ok({"actions": [{"id": key, **{k: v for k, v in value.items() if k != "cmd"},
                            "command": value["cmd"]}
                           for key, value in HW_ACTIONS.items()]})


@routes.post("/api/hw/action")
async def post_hw_action(request: web.Request) -> web.Response:
    data = await body(request)
    action = HW_ACTIONS.get((data.get("action") or "").strip())
    if not action:
        return fail("Unknown hardware action", status=404)
    if action.get("confirm") and not data.get("confirm"):
        return fail(f"{action['label']} requires confirmation", status=428,
                    requiresConfirm=True, note=action.get("note"))
    result = await run_command(request, action["cmd"], timeout=action.get("timeout", 20))
    return ok({"result": result.to_dict()})


@routes.post("/api/hw/dbg")
async def post_hw_dbg(request: web.Request) -> web.Response:
    """Device-side debug verbosity — ``hw dbg -0..-4``."""
    data = await body(request)
    try:
        level = int(data.get("level"))
    except (TypeError, ValueError):
        return fail("level must be an integer 0-4")
    if level not in range(5):
        return fail("level must be 0, 1, 2, 3 or 4")
    result = await run_command(request, f"hw dbg -{level}", timeout=20)
    return ok({"result": result.to_dict()})


# ---------------------------------------------------------------------- memory
@routes.get("/api/mem/spiffs")
async def get_mem_spiffs(request: web.Request) -> web.Response:
    _, _, session, _, _ = ctx(request)
    if not session.connected:
        return fail("Flash memory needs a connected device", status=409, reason="offline")
    info = await run_command(request, "mem spiffs info", timeout=30)
    if parsers.is_unsupported(info.output):
        # SPIFFS lives on the RDV4's external flash chip. Generic boards have
        # none, so say that rather than showing an empty filesystem.
        return ok({
            "supported": False,
            "reason": "This Proxmark3 has no external flash chip, so it has no "
                      "SPIFFS filesystem. The feature is specific to the RDV4 "
                      "(and boards built with PLATFORM_EXTRAS=FLASH).",
            "info": parsers.parse_spiffs_info(info.output),
            "tree": {"files": [], "raw": ""},
        })
    tree = await run_command(request, "mem spiffs tree", timeout=30)
    return ok({
        "supported": True,
        "info": parsers.parse_spiffs_info(info.output),
        "tree": parsers.parse_spiffs_tree(tree.output),
    })


MEM_ACTIONS = {
    "mount":   {"cmd": "mem spiffs mount", "label": "Mount SPIFFS"},
    "unmount": {"cmd": "mem spiffs unmount", "label": "Unmount SPIFFS"},
    "check":   {"cmd": "mem spiffs check", "label": "Check / defragment SPIFFS",
                "timeout": 120},
    "info":    {"cmd": "mem info", "label": "Flash signature info"},
    "wipe":    {"cmd": "mem spiffs wipe", "label": "Wipe all SPIFFS files",
                "confirm": True, "timeout": 120,
                "note": "Every file on the device flash is erased. This cannot be undone."},
}


@routes.get("/api/mem/actions")
async def get_mem_actions(request: web.Request) -> web.Response:
    return ok({"actions": [{"id": key, **{k: v for k, v in value.items() if k != "cmd"},
                            "command": value["cmd"]}
                           for key, value in MEM_ACTIONS.items()]})


@routes.post("/api/mem/action")
async def post_mem_action(request: web.Request) -> web.Response:
    data = await body(request)
    action = MEM_ACTIONS.get((data.get("action") or "").strip())
    if not action:
        return fail("Unknown memory action", status=404)
    if action.get("confirm") and not data.get("confirm"):
        return fail(f"{action['label']} requires confirmation", status=428,
                    requiresConfirm=True, note=action.get("note"))
    result = await run_command(request, action["cmd"], timeout=action.get("timeout", 30))
    return ok({"result": result.to_dict()})


_SPIFFS_NAME_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/")


@routes.post("/api/mem/spiffs/remove")
async def post_spiffs_remove(request: web.Request) -> web.Response:
    data = await body(request)
    name = (data.get("name") or "").strip()
    if not name or set(name) - _SPIFFS_NAME_OK or ".." in name:
        return fail("Invalid SPIFFS filename")
    if not data.get("confirm"):
        return fail(f"Deleting '{name}' from device flash requires confirmation",
                    status=428, requiresConfirm=True)
    result = await run_command(request, f"mem spiffs remove -f {name}", timeout=30)
    return ok({"result": result.to_dict()})


# ----------------------------------------------------------------------- signal
#: Offline-safe graph-buffer transforms exposed as one-click operations.
SIGNAL_OPS = {
    "norm":          {"cmd": "data norm", "label": "Normalise"},
    "autocorr":      {"cmd": "data autocorr -g", "label": "Autocorrelate"},
    "zerocrossings": {"cmd": "data zerocrossings", "label": "Zero crossings"},
    "detectclock":   {"cmd": "data detectclock", "label": "Detect clock"},
    "undecimate":    {"cmd": "data undecimate -n 2", "label": "Undecimate x2"},
    "decimate":      {"cmd": "data decimate -n 2", "label": "Decimate x2"},
    "identify":      {"cmd": "lf search -1", "label": "Identify from buffer",
                      "timeout": 60},
}


@routes.get("/api/signal/ops")
async def get_signal_ops(request: web.Request) -> web.Response:
    return ok({"ops": [{"id": key, "label": value["label"], "command": value["cmd"]}
                       for key, value in SIGNAL_OPS.items()]})


async def _read_graph_buffer(request: web.Request, points: int) -> dict:
    """Export the client's GraphBuffer via ``data save`` and read it back.

    The client never overwrites: given an existing ``foo.pm3`` it writes
    ``foo-001.pm3``, then ``foo-002.pm3`` and so on. Reading the fixed name back
    would therefore return the *first* export forever — real captures silently
    replaced by stale data. So the scratch copies are cleared first and the file
    that appears afterwards is the one that is read.
    """
    config, _, _, _, _ = ctx(request)
    target = config.scratch_dir / "gui_graphbuffer"
    for stale in config.scratch_dir.glob("gui_graphbuffer*.pm3"):
        with contextlib.suppress(OSError):
            stale.unlink()

    save = await run_command(request, f"data save -f {target}", timeout=45)

    written = sorted(config.scratch_dir.glob("gui_graphbuffer*.pm3"))
    if not written:
        return {"points": [], "count": 0,
                "error": "The client did not write a graph buffer file. "
                         "The buffer may be empty.",
                "raw": save.output}
    path = written[0]
    text = path.read_text(encoding="utf-8", errors="replace")
    samples = parsers.parse_pm3_samples(text)
    reduced = parsers.downsample(samples, points)
    return {
        "count": len(samples),
        "points": reduced["points"],
        "envelope": reduced["envelope"],
        "factor": reduced["factor"],
        "min": min(samples) if samples else 0,
        "max": max(samples) if samples else 0,
        "file": str(path),
    }


@routes.get("/api/signal/buffer")
async def get_signal_buffer(request: web.Request) -> web.Response:
    points = min(max(int(request.query.get("points", 1200) or 1200), 100), 8000)
    return ok({"buffer": await _read_graph_buffer(request, points)})


@routes.post("/api/signal/capture")
async def post_signal_capture(request: web.Request) -> web.Response:
    """``data samples`` — pull fresh samples from the device into the graph buffer."""
    _, _, session, _, _ = ctx(request)
    data = await body(request)
    if not session.connected:
        return fail("Capturing samples needs a connected device", status=409,
                    reason="offline")
    try:
        count = int(data.get("samples", 40000))
    except (TypeError, ValueError):
        return fail("samples must be an integer")
    if not (512 <= count <= 40000):
        return fail("samples must be between 512 and 40000")
    points = min(max(int(data.get("points", 1200)), 100), 8000)
    result = await run_command(request, f"data samples -n {count}", timeout=90)
    buffer = await _read_graph_buffer(request, points)
    return ok({"result": result.to_dict(), "buffer": buffer})


@routes.post("/api/signal/load")
async def post_signal_load(request: web.Request) -> web.Response:
    """Load a trace file from an allow-listed root into the graph buffer."""
    config, _, _, _, _ = ctx(request)
    data = await body(request)
    try:
        path = files.absolute_path(config.roots, data.get("root", ""), data.get("path", ""))
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except FileNotFoundError as exc:
        return fail(str(exc), status=404)
    if " " in str(path):
        return fail("The client cannot load paths containing spaces")
    points = min(max(int(data.get("points", 1200)), 100), 8000)
    result = await run_command(request, f"data load -f {path}", timeout=60)
    buffer = await _read_graph_buffer(request, points)
    return ok({"result": result.to_dict(), "buffer": buffer, "source": str(path)})


@routes.post("/api/signal/op")
async def post_signal_op(request: web.Request) -> web.Response:
    data = await body(request)
    op = SIGNAL_OPS.get((data.get("op") or "").strip())
    if not op:
        return fail("Unknown signal operation", status=404)
    points = min(max(int(data.get("points", 1200)), 100), 8000)
    result = await run_command(request, op["cmd"], timeout=op.get("timeout", 45))
    buffer = await _read_graph_buffer(request, points)
    return ok({"result": result.to_dict(), "buffer": buffer})


# ------------------------------------------------------------------------ scan
SCAN_MODES = {
    "hf":   {"cmd": "hf search", "label": "HF search", "timeout": 90},
    "lf":   {"cmd": "lf search", "label": "LF search", "timeout": 90},
    "auto": {"cmd": "auto", "label": "Auto (LF + HF + tune)", "timeout": 180},
}


@routes.get("/api/scan/modes")
async def get_scan_modes(request: web.Request) -> web.Response:
    return ok({"modes": [{"id": key, "label": value["label"], "command": value["cmd"]}
                         for key, value in SCAN_MODES.items()]})


@routes.get("/api/scan/history")
async def get_scan_history(request: web.Request) -> web.Response:
    return ok({"scans": list(request.app["scans"])})


@routes.post("/api/scan")
async def post_scan(request: web.Request) -> web.Response:
    _, bus, session, _, _ = ctx(request)
    data = await body(request)
    mode = SCAN_MODES.get((data.get("mode") or "hf").strip())
    if not mode:
        return fail("Unknown scan mode", status=404)
    if not session.connected:
        return fail(f"{mode['label']} needs a connected device", status=409,
                    reason="offline")
    result = await run_command(request, mode["cmd"], timeout=mode["timeout"])
    parsed = parsers.parse_search(result.output)
    record = {
        "id": f"scan-{int(time.time() * 1000)}",
        "mode": data.get("mode"),
        "command": mode["cmd"],
        "ts": time.time(),
        "duration": round(result.duration, 2),
        **parsed,
    }
    request.app["scans"].appendleft(record)
    bus.notify("success" if parsed["found"] else "info",
               f"{mode['label']} finished",
               "Tag identified" if parsed["found"] else "No known tag found",
               link="#/tags")
    return ok({"scan": record, "result": result.to_dict()})


# ----------------------------------------------------------------------- trace
TRACE_PROTOCOLS = ["14a", "14b", "15", "7816", "calypso", "cryptorf", "des", "felica",
                   "ht1", "ht2", "hts", "htu", "iclass", "legic", "lto", "mf", "mfp",
                   "fmcos20", "raw", "seos", "thinfilm", "topaz"]


@routes.get("/api/trace/protocols")
async def get_trace_protocols(request: web.Request) -> web.Response:
    return ok({"protocols": TRACE_PROTOCOLS})


@routes.post("/api/trace/list")
async def post_trace_list(request: web.Request) -> web.Response:
    data = await body(request)
    protocol = (data.get("protocol") or "").strip()
    if protocol and protocol not in TRACE_PROTOCOLS:
        return fail("Unknown trace protocol", status=400)
    flags = ["trace list"]
    if data.get("useBuffer", True):
        flags.append("-1")
    if data.get("markCrc"):
        flags.append("-c")
    if data.get("relative"):
        flags.append("-r")
    if data.get("microseconds"):
        flags.append("-u")
    if data.get("hexdump"):
        flags.append("-x")
    if data.get("frameDelay"):
        flags.append("--frame")
    if protocol:
        flags += ["-t", protocol]
    result = await run_command(request, " ".join(flags), timeout=60)
    return ok({"result": result.to_dict()})


@routes.post("/api/trace/load")
async def post_trace_load(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    data = await body(request)
    try:
        path = files.absolute_path(config.roots, data.get("root", ""), data.get("path", ""))
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except FileNotFoundError as exc:
        return fail(str(exc), status=404)
    if " " in str(path):
        return fail("The client cannot load paths containing spaces")
    result = await run_command(request, f"trace load -f {path}", timeout=60)
    return ok({"result": result.to_dict(), "source": str(path)})


@routes.post("/api/trace/save")
async def post_trace_save(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    data = await body(request)
    name = (data.get("name") or "").strip()
    if not name or set(name) - set(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"):
        return fail("Name may contain letters, digits, dot, dash and underscore only")
    target = config.scratch_dir / name
    result = await run_command(request, f"trace save -f {target}", timeout=60)
    return ok({"result": result.to_dict(), "path": str(target)})


# --------------------------------------------------------------------- scripts
@routes.get("/api/scripts")
async def get_scripts(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    listing = await asyncio.get_running_loop().run_in_executor(
        None, scripts.list_scripts, config.script_dirs)
    return ok(listing)


@routes.post("/api/scripts/run")
async def post_scripts_run(request: web.Request) -> web.Response:
    data = await body(request)
    try:
        name = scripts.validate_script_name(data.get("name", ""))
        args = scripts.validate_script_args(data.get("args", ""))
    except ValueError as exc:
        return fail(str(exc))
    # `script run <filename> [<params>]...` — parameters follow the name
    # directly; a `--` separator would be handed to the script as an argument.
    command = f"script run {name}"
    if args:
        command += f" {args}"
    timeout = max(5.0, min(float(data.get("timeout") or LONG_TIMEOUT), 600.0))
    result = await run_command(request, command, timeout=timeout)
    return ok({"result": result.to_dict()})


# ----------------------------------------------------------------------- files
@routes.get("/api/files/roots")
async def get_file_roots(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    writable = config.writable_roots()
    roots = []
    for name, path in config.roots.items():
        try:
            count = sum(1 for _ in path.iterdir())
        except OSError:
            count = None
        roots.append({"name": name, "path": str(path), "entries": count,
                      "writable": name in writable})
    return ok({"roots": roots})


@routes.get("/api/files/list")
async def get_file_list(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    try:
        listing = files.list_directory(
            config.roots,
            request.query.get("root", ""),
            request.query.get("path", ""),
            request.query.get("q", ""),
        )
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except (FileNotFoundError, NotADirectoryError) as exc:
        return fail(str(exc), status=404)
    return ok(listing)


@routes.get("/api/files/read")
async def get_file_read(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    try:
        return ok(files.read_file(config.roots, request.query.get("root", ""),
                                  request.query.get("path", "")))
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except (FileNotFoundError, IsADirectoryError) as exc:
        return fail(str(exc), status=404)


@routes.get("/api/files/download")
async def get_file_download(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    try:
        path = files.absolute_path(config.roots, request.query.get("root", ""),
                                   request.query.get("path", ""))
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except FileNotFoundError as exc:
        return fail(str(exc), status=404)
    return web.FileResponse(path, headers={
        "Content-Disposition": f'attachment; filename="{path.name}"',
        "X-Content-Type-Options": "nosniff",
    })


@routes.delete("/api/files")
async def delete_file(request: web.Request) -> web.Response:
    config, bus, _, _, _ = ctx(request)
    root = request.query.get("root", "")
    # Deletion is confined to the user's own ~/.proxmark3 tree; the repository's
    # traces, dictionaries and scripts are never writable through the GUI.
    if root not in config.writable_roots():
        return fail(f"Root '{root}' is read-only in the GUI", status=403)
    if request.query.get("confirm") != "1":
        return fail("Deleting a file requires confirmation", status=428,
                    requiresConfirm=True)
    try:
        result = files.delete_file(config.roots, root, request.query.get("path", ""))
    except files.PathDenied as exc:
        return fail(str(exc), status=403)
    except (FileNotFoundError, IsADirectoryError) as exc:
        return fail(str(exc), status=404)
    except OSError as exc:
        return fail(str(exc), status=500)
    bus.notify("warning", "File deleted", f"{root}/{result['deleted']}")
    return ok(result)


# ------------------------------------------------------------------------ logs
@routes.get("/api/logs/files")
async def get_log_files(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    return ok({"files": logs.list_log_files(config.log_dir),
               "dir": str(config.log_dir),
               "exists": config.log_dir.exists()})


@routes.get("/api/logs")
async def get_logs(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    name = request.query.get("file")
    if name:
        if "/" in name or ".." in name or not name.startswith("log_"):
            return fail("Invalid log file name", status=400)
        path = config.log_dir / name
    else:
        path = logs.newest_log(config.log_dir)
    if path is None:
        return ok({"entries": [], "empty": True, "dir": str(config.log_dir),
                   "reason": "No session log files yet — the client writes one per run."})
    try:
        return ok(logs.read_log(
            path,
            limit=min(int(request.query.get("limit", 1000) or 1000), 20000),
            level=request.query.get("level"),
            query=request.query.get("q"),
        ))
    except FileNotFoundError:
        return fail("Log file not found", status=404)


# ----------------------------------------------------------------------- prefs
#: ``prefs set`` sub-commands the GUI drives, with the exact flags from
#: doc/commands.json. Free-text values are constrained per field.
PREF_SPECS: dict[str, dict] = {
    "color":         {"type": "choice", "label": "Colour output",
                      "group": "Appearance",
                      "help": "ANSI colours in client output. The GUI strips them "
                              "for parsing either way.",
                      "choices": [{"value": "--ansi", "label": "ANSI"},
                                  {"value": "--off", "label": "Off"}]},
    "emoji":         {"type": "choice", "label": "Emoji", "group": "Appearance",
                      "help": "How the client renders emoji in messages.",
                      "choices": [{"value": "--emoji", "label": "Emoji"},
                                  {"value": "--alias", "label": "Alias"},
                                  {"value": "--alttext", "label": "Alt text"},
                                  {"value": "--none", "label": "None"}]},
    "hints":         {"type": "choice", "label": "Hint messages", "group": "Appearance",
                      "help": "Contextual `[?]` hints after commands.",
                      "choices": [{"value": "--on", "label": "On"},
                                  {"value": "--off", "label": "Off"}]},
    "output":        {"type": "choice", "label": "Dump output style",
                      "group": "Appearance",
                      "help": "Dense output collapses repeated identical rows.",
                      "choices": [{"value": "--normal", "label": "Normal"},
                                  {"value": "--dense", "label": "Dense"}]},
    "plotsliders":   {"type": "choice", "label": "Plot sliders", "group": "Appearance",
                      "help": "Legacy Qt plot window sliders. The GUI plots in "
                              "the browser instead.",
                      "choices": [{"value": "--on", "label": "On"},
                                  {"value": "--off", "label": "Off"}]},
    "client.debug":  {"type": "choice", "label": "Client debug level",
                      "group": "Diagnostics",
                      "help": "Verbosity of client-side debug messages.",
                      "choices": [{"value": "--off", "label": "Off"},
                                  {"value": "--simple", "label": "Simple"},
                                  {"value": "--full", "label": "Full"}]},
    "client.delay":  {"type": "int", "label": "Command execution delay",
                      "group": "Timing", "flag": "--ms", "unit": "µs",
                      "min": 0, "max": 10_000_000,
                      "help": "Delay inserted before each command executes."},
    "client.timeout": {"type": "int", "label": "Communication timeout",
                       "group": "Timing", "flag": "-m", "unit": "ms",
                       "min": 0, "max": 600_000,
                       "help": "Client-side serial timeout. 0 keeps the default."},
    "hf.field.timeout_sec": {"type": "int", "label": "HF field inactivity timeout",
                             "group": "Timing", "flag": "-s", "unit": "s",
                             "min": 0, "max": 3600,
                             "help": "Switches the HF field off after inactivity. "
                                     "0 disables the timeout."},
}


@routes.get("/api/prefs")
async def get_prefs(request: web.Request) -> web.Response:
    config, _, _, _, _ = ctx(request)
    result = await run_command(request, "prefs show", timeout=20)
    payload = parsers.parse_prefs(result.output)
    raw_file = None
    if config.prefs_file.exists():
        try:
            raw_file = json.loads(config.prefs_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw_file = None
    return ok({"prefs": payload, "specs": PREF_SPECS, "file": str(config.prefs_file),
               "rawFile": raw_file, "result": result.to_dict()})


@routes.post("/api/prefs/set")
async def post_prefs_set(request: web.Request) -> web.Response:
    _, bus, _, _, _ = ctx(request)
    data = await body(request)
    key = (data.get("key") or "").strip()
    spec = PREF_SPECS.get(key)
    if not spec:
        return fail(f"'{key}' is not an editable preference", status=404)

    value = data.get("value")
    if spec["type"] == "choice":
        allowed = {choice["value"] for choice in spec["choices"]}
        if value not in allowed:
            return fail(f"Value must be one of: {', '.join(sorted(allowed))}")
        argument = value
    elif spec["type"] == "int":
        try:
            number = int(value)
        except (TypeError, ValueError):
            return fail("Value must be an integer")
        if not (spec["min"] <= number <= spec["max"]):
            return fail(f"Value must be between {spec['min']} and {spec['max']}")
        argument = f"{spec['flag']} {number}"
    else:  # pragma: no cover - no other types declared
        return fail("Unsupported preference type", status=500)

    result = await run_command(request, f"prefs set {key} {argument}", timeout=20)
    bus.notify("success" if result.ok else "error",
               "Preference updated" if result.ok else "Preference change failed",
               f"{spec['label']}: {value}", link="#/config")
    return ok({"result": result.to_dict()})


# --------------------------------------------------------------------- metrics
@routes.get("/api/metrics")
async def get_metrics(request: web.Request) -> web.Response:
    config, _, _, _, metrics = ctx(request)
    return ok({
        "available": metrics.available,
        "host": metrics.host_info(),
        "history": metrics.recent(),
        "current": metrics.history[-1] if metrics.history else None,
        "storage": metrics.storage(config.roots),
        "interval": metrics.interval,
    })


# --------------------------------------------------------------- notifications
@routes.get("/api/notifications")
async def get_notifications(request: web.Request) -> web.Response:
    _, bus, _, _, _ = ctx(request)
    return ok({"notifications": list(bus.notifications)})


@routes.post("/api/notifications/clear")
async def post_notifications_clear(request: web.Request) -> web.Response:
    _, bus, _, _, _ = ctx(request)
    bus.clear_notifications()
    return ok({"cleared": True})


# ---------------------------------------------------------------------- search
@routes.get("/api/search")
async def get_search(request: web.Request) -> web.Response:
    """Global search across commands, scripts, log entries and resource files."""
    config, _, _, catalog, _ = ctx(request)
    query = (request.query.get("q") or "").strip()
    if len(query) < 2:
        return ok({"groups": [], "query": query})

    loop = asyncio.get_running_loop()
    groups = [{
        "id": "commands", "label": "Commands",
        "items": [{"title": c["name"], "subtitle": c["description"][:110],
                   "action": "command", "value": c["name"]}
                  for c in catalog.search(query, limit=8)],
    }]

    listing = await loop.run_in_executor(None, scripts.list_scripts, config.script_dirs)
    script_hits = [s for s in listing["scripts"] if query.lower() in s["name"].lower()][:6]
    if script_hits:
        groups.append({"id": "scripts", "label": "Scripts", "items": [
            {"title": f"{s['name']} ({s['kind']})", "subtitle": s["description"][:110],
             "action": "script", "value": s["name"]} for s in script_hits]})

    file_hits: list[dict] = []
    for root_name in ("traces", "dumps", "dictionaries"):
        if root_name not in config.roots:
            continue
        try:
            entries = files.list_directory(config.roots, root_name, "", query)["entries"]
        except (files.PathDenied, FileNotFoundError, NotADirectoryError):
            continue
        for entry in entries[:4]:
            if entry.get("isDir"):
                continue
            file_hits.append({"title": entry["name"], "subtitle": f"{root_name}/",
                              "action": "file",
                              "value": json.dumps({"root": root_name, "path": entry["path"]})})
    if file_hits:
        groups.append({"id": "files", "label": "Files", "items": file_hits[:10]})

    newest = logs.newest_log(config.log_dir)
    if newest:
        try:
            hits = logs.read_log(newest, limit=6, query=query)["entries"]
            if hits:
                groups.append({"id": "logs", "label": "Log entries", "items": [
                    {"title": entry["message"][:90], "subtitle": entry["level"],
                     "action": "log", "value": query} for entry in hits]})
        except FileNotFoundError:
            pass

    return ok({"groups": [g for g in groups if g["items"]], "query": query})


# ------------------------------------------------------------------ websockets
@routes.get("/ws/console")
async def ws_console(request: web.Request) -> web.WebSocketResponse:
    _, bus, session, _, _ = ctx(request)
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    request.app["websockets"].add(ws)

    await ws.send_json({"type": "hello", "session": session.state(),
                        "scrollback": session.scrollback()})

    subscription = bus.subscribe("console")

    async def pump() -> None:
        try:
            while True:
                chunk = await subscription.get()
                await ws.send_json({"type": "output", "data": chunk})
        except (asyncio.CancelledError, ConnectionResetError):
            pass

    pump_task = asyncio.create_task(pump(), name="ws-console-pump")
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(message.data)
            except json.JSONDecodeError:
                continue
            kind = payload.get("type")
            if kind == "input":
                data = payload.get("data", "")
                if isinstance(data, str) and len(data) <= 8192:
                    try:
                        await session.write_raw(data)
                    except SessionNotRunning as exc:
                        await ws.send_json({"type": "error", "error": str(exc)})
            elif kind == "interrupt":
                await session.interrupt()
            elif kind == "resize":
                cols = int(payload.get("cols") or 120)
                rows = int(payload.get("rows") or 40)
                session.resize(max(20, min(cols, 500)), max(5, min(rows, 200)))
    finally:
        pump_task.cancel()
        subscription.close()
        request.app["websockets"].discard(ws)
    return ws


@routes.get("/ws/events")
async def ws_events(request: web.Request) -> web.WebSocketResponse:
    config, bus, session, _, metrics = ctx(request)
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    request.app["websockets"].add(ws)

    await ws.send_json({"type": "hello", "session": session.state(),
                        "metrics": metrics.history[-1] if metrics.history else None,
                        "notifications": list(bus.notifications)[-20:]})

    subscription = bus.subscribe("events")

    async def pump() -> None:
        while True:
            await ws.send_json(await subscription.get())

    pump_task = asyncio.create_task(pump(), name="ws-events-pump")
    try:
        # Draining incoming frames is what surfaces a client disconnect.
        async for _message in ws:
            pass
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    finally:
        pump_task.cancel()
        subscription.close()
        request.app["websockets"].discard(ws)
    return ws
