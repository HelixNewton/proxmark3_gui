"""Long-lived interactive proxmark3 client session driven over a pseudo-terminal.

Why a PTY rather than ``proxmark3 -c "cmd"`` per request: the client keeps
per-session state that the GUI depends on — the graph buffer, the trace buffer,
the device connection, ``data load`` results and preference changes. Re-spawning
per command would throw all of that away (and re-negotiate USB every time).

The session multiplexes two consumers over one process:

* the Console page, which streams raw output and can type into the PTY, and
* the REST API, which runs one command at a time under a lock and captures the
  output framed by the client's own prompt.

Both see the same stream, so a command issued by a dashboard button shows up in
the terminal exactly as if it had been typed.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import os
import pty
import re
import signal
import struct
import termios
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from . import ansi
from .config import AppConfig
from .events import EventBus

#: ``[usb] pm3 --> `` / ``[offline] pm3 --> `` / ``[fpc|BT] pm3 --> `` (client/src/proxmark3.h)
#: ``\Z`` rather than ``$``: ``$`` also matches before a trailing newline, which
#: would treat the *previous* prompt as the current one and end a capture early.
PROMPT_RE = re.compile(r"\[(offline|usb|fpc)([^\]]*)\] pm3 --> \Z")
PROMPT_ANYWHERE_RE = re.compile(r"\[(offline|usb|fpc)([^\]]*)\] pm3 --> ")

#: Session lifecycle states surfaced to the UI as status pills.
STOPPED = "stopped"
STARTING = "starting"
ONLINE = "online"
OFFLINE = "offline"
ERROR = "error"

DEFAULT_TIMEOUT = 30.0
#: How long a command waits for the client to become free before reporting busy.
QUEUE_TIMEOUT = 20.0
#: How often the attached serial port is checked for disappearance.
PORT_POLL_INTERVAL = 3.0
#: How long a stuck command is waited on before the hold is released.
RESYNC_GIVE_UP = 120.0
SCROLLBACK_BYTES = 256 * 1024


class SessionBusy(RuntimeError):
    """Raised when a command is requested while another one is still running."""


class SessionNotRunning(RuntimeError):
    pass


@dataclass
class CommandResult:
    command: str
    output: str
    duration: float
    timed_out: bool = False
    started: float = field(default_factory=time.time)

    @property
    def lines(self) -> list[str]:
        return self.output.split("\n")

    @property
    def level(self) -> str:
        """Worst severity present in the output — drives toast colour in the UI."""
        worst = "info"
        rank = {"info": 0, "success": 0, "hint": 0, "normal": 0,
                "debug": 0, "warning": 1, "error": 2, "critical": 3}
        for line in self.lines:
            lvl, _ = ansi.classify(line)
            if rank.get(lvl, 0) > rank.get(worst, 0):
                worst = lvl
        return worst

    @property
    def ok(self) -> bool:
        return not self.timed_out and self.level not in ("error", "critical")

    def to_dict(self) -> dict:
        return {
            "command": self.command,
            "output": self.output,
            "duration": round(self.duration, 3),
            "timedOut": self.timed_out,
            "level": self.level,
            "ok": self.ok,
        }


class PM3Session:
    def __init__(self, config: AppConfig, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self.status: str = STOPPED
        self.status_detail: str = "Client not started"
        self.pid: int | None = None
        self.fd: int | None = None
        self.port: str | None = None
        self.started_at: float | None = None
        self.last_error: str | None = None
        self.prompt: str = ""
        self.command_count = 0
        self.last_command: str | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = asyncio.Lock()
        self._scrollback: deque[bytes] = deque()
        self._scrollback_size = 0
        self._capture: list[str] | None = None
        self._prompt_event: asyncio.Event = asyncio.Event()
        self._exit_event: asyncio.Event = asyncio.Event()
        self._tail = ""  # cleaned tail used for prompt detection
        self._last_chunk_at = 0.0
        #: Set when a timed-out command is still producing output.
        self._desynced = False
        self._watchdog: asyncio.Task | None = None

    # ------------------------------------------------------------------ state
    @property
    def running(self) -> bool:
        return self.pid is not None and self.fd is not None

    @property
    def connected(self) -> bool:
        return self.status == ONLINE

    def state(self) -> dict:
        return {
            "status": self.status,
            "detail": self.status_detail,
            "running": self.running,
            "connected": self.connected,
            "pid": self.pid,
            "port": self.port,
            "prompt": self.prompt,
            "startedAt": self.started_at,
            "uptime": (time.time() - self.started_at) if self.started_at else None,
            "commandCount": self.command_count,
            "lastCommand": self.last_command,
            "lastError": self.last_error,
            "busy": self._lock.locked() or self._desynced,
            "desynced": self._desynced,
            "binary": str(self.config.client_binary) if self.config.client_binary else None,
        }

    def _set_status(self, status: str, detail: str = "") -> None:
        if status == self.status and detail == self.status_detail:
            return
        previous = self.status
        self.status, self.status_detail = status, detail
        self.bus.emit("session", state=self.state(), previous=previous)

    # ---------------------------------------------------------------- process
    async def start(self, port: str | None = None) -> dict:
        """Spawn the client. ``port`` of ``""`` forces offline mode."""
        if self.running:
            return self.state()
        binary = self.config.client_binary
        if binary is None or not Path(binary).is_file():
            self.last_error = (
                "proxmark3 client binary not found. Build it with "
                "`make client` in the repository root."
            )
            self._set_status(ERROR, self.last_error)
            raise SessionNotRunning(self.last_error)

        self._loop = asyncio.get_running_loop()
        self.port = port if port else None
        self.last_error = None
        self._exit_event = asyncio.Event()
        self._prompt_event = asyncio.Event()
        self._tail = ""
        self._set_status(STARTING, f"Launching {binary.name}")

        argv = [str(binary)]
        if self.port:
            argv += ["-p", self.port, "-w"]
        argv.append("-i")
        if self.config.incognito:
            argv.append("--incognito")

        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(str(self.config.client_binary.parent.parent))
                env = dict(os.environ)
                # The client links Qt for its legacy plot window; we plot in the
                # browser instead, so keep Qt from spamming the output stream.
                env["QT_LOGGING_RULES"] = "*=false"
                env.setdefault("TERM", "xterm-256color")
                env["PM3_GUI"] = "1"
                os.execve(argv[0], argv, env)
            except Exception:  # pragma: no cover - child process
                os._exit(127)

        self.pid = pid
        self.fd = fd
        self.started_at = time.time()
        self.resize(120, 40)
        os.set_blocking(fd, False)
        self._loop.add_reader(fd, self._on_readable)

        try:
            await asyncio.wait_for(self._prompt_event.wait(), timeout=40)
        except asyncio.TimeoutError:
            self.last_error = "Client did not reach a prompt within 40s"
            self._set_status(ERROR, self.last_error)
            self.bus.notify("error", "Client startup timed out", self.last_error)
            await self.stop()
            raise SessionNotRunning(self.last_error)

        # The prompt event is also set when the process dies, so a client that
        # refuses the device and exits must not be reported as started.
        if not self.running:
            self.last_error = self._exit_reason()
            self._set_status(ERROR, self.last_error)
            raise SessionNotRunning(self.last_error)

        if self.port:
            self._ensure_watchdog()

        self.bus.notify(
            "success" if self.connected else "info",
            "Client started",
            f"{'Device connected on ' + str(self.port) if self.connected else 'Running in OFFLINE mode'}",
        )
        return self.state()

    def _exit_reason(self) -> str:
        """Explain an early exit using the client's own last words."""
        tail = [line for line in ansi.clean(self.scrollback()).split("\n") if line.strip()]
        for line in reversed(tail[-12:]):
            level, message = ansi.classify(line)
            if level in ("error", "critical") and message:
                return f"The client exited: {message}"
        return "The proxmark3 client exited during startup."

    async def stop(self) -> dict:
        if self._watchdog:
            self._watchdog.cancel()
            self._watchdog = None
        if self.fd is not None and self._loop is not None:
            with contextlib.suppress(Exception):
                self._loop.remove_reader(self.fd)
        if self.pid:
            if self.fd is not None:
                with contextlib.suppress(OSError):
                    os.write(self.fd, b"quit\n")
            await asyncio.sleep(0.25)
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(self.pid, signal.SIGTERM)
            for _ in range(20):
                try:
                    wpid, _ = os.waitpid(self.pid, os.WNOHANG)
                    if wpid == self.pid:
                        break
                except ChildProcessError:
                    break
                await asyncio.sleep(0.05)
            else:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(self.pid, signal.SIGKILL)
                with contextlib.suppress(ChildProcessError):
                    os.waitpid(self.pid, 0)
        if self.fd is not None:
            with contextlib.suppress(OSError):
                os.close(self.fd)
        self.pid = None
        self.fd = None
        self.started_at = None
        self.prompt = ""
        self._desynced = False
        self._exit_event.set()
        self._set_status(STOPPED, "Client stopped")
        return self.state()

    async def restart(self, port: str | None = None) -> dict:
        await self.stop()
        await asyncio.sleep(0.2)
        return await self.start(port)

    def resize(self, cols: int, rows: int) -> None:
        """Tell the client how wide the terminal is, so its tables wrap right."""
        if self.fd is None:
            return
        with contextlib.suppress(OSError):
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))

    # ------------------------------------------------------------------- pump
    def _on_readable(self) -> None:
        assert self.fd is not None
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._handle_exit()
            return
        self._ingest(data)

    def _handle_exit(self) -> None:
        if self._loop and self.fd is not None:
            with contextlib.suppress(Exception):
                self._loop.remove_reader(self.fd)
        self._prompt_event.set()
        self._exit_event.set()
        was_running = self.running
        if self.pid:  # reap so the client does not linger as a zombie
            with contextlib.suppress(ChildProcessError, OSError):
                os.waitpid(self.pid, os.WNOHANG)
        if self.fd is not None:
            with contextlib.suppress(OSError):
                os.close(self.fd)
        self.pid = None
        self.fd = None
        if was_running:
            self._set_status(STOPPED, "Client process exited")
            self.bus.notify("warning", "Client exited",
                            "The proxmark3 client process has terminated.")

    def _ingest(self, data: bytes) -> None:
        self._scrollback.append(data)
        self._scrollback_size += len(data)
        while self._scrollback_size > SCROLLBACK_BYTES and len(self._scrollback) > 1:
            self._scrollback_size -= len(self._scrollback.popleft())

        self._last_chunk_at = time.monotonic()
        text = data.decode("utf-8", "replace")
        self.bus.publish("console", text)
        if self._capture is not None:
            self._capture.append(text)

        # The prompt is the last thing written before the client blocks on input,
        # so an idle stream always *ends* with it.
        self._tail = (self._tail + ansi.clean(text))[-400:]
        match = PROMPT_RE.search(self._tail)
        if match:
            self.prompt = match.group(0)
            device = match.group(1)
            if device == "offline":
                self._set_status(OFFLINE, "Client online, no device connected")
            else:
                # A live prompt supersedes any earlier disconnection message.
                if self.last_error and "Device removed" in self.last_error:
                    self.last_error = None
                self._set_status(ONLINE, f"Device connected ({device})")
            self._prompt_event.set()

    def scrollback(self) -> str:
        return b"".join(self._scrollback).decode("utf-8", "replace")

    # --------------------------------------------------------------- commands
    async def execute(self, command: str, timeout: float = DEFAULT_TIMEOUT,
                      queue_timeout: float = QUEUE_TIMEOUT) -> CommandResult:
        """Run one command and capture its output.

        A newline in ``command`` would smuggle a second command past any caller
        that validated only the first, so it is rejected outright.
        """
        command = command.strip()
        if not command:
            raise ValueError("Empty command")
        if "\n" in command or "\r" in command:
            raise ValueError("Command must be a single line")
        if not self.running:
            raise SessionNotRunning("proxmark3 client is not running")
        if self._desynced:
            raise SessionBusy(
                "The client has not finished an earlier command that timed out. "
                "Its output would be mixed into this one.")

        # The client is single-threaded, so commands are serialised. Wait a
        # short while for the lock rather than failing outright: a page that
        # loads two panels at once should queue, not error. A genuinely long
        # command still surfaces as busy once the grace period expires.
        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=queue_timeout)
        except asyncio.TimeoutError:
            raise SessionBusy(
                f"The client is still running `{self.last_command}`. "
                "Wait for it to finish, or abort it.") from None

        try:
            self.command_count += 1
            self.last_command = command
            started = time.time()
            self.bus.emit("command.start", command=command)
            self._capture = []
            self._prompt_event.clear()
            os.write(self.fd, command.encode() + b"\n")

            timed_out = False
            try:
                await asyncio.wait_for(self._prompt_event.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                timed_out = True
                await self.interrupt()
                try:
                    await asyncio.wait_for(self._prompt_event.wait(), timeout=10)
                except asyncio.TimeoutError:
                    # The command ignored the abort. Its remaining output would
                    # be captured as the *next* command's, so refuse further
                    # commands until the prompt comes back.
                    self._desynced = True
                    asyncio.create_task(self._resync(), name="pm3-resync")

            if timed_out and not self._desynced:
                # Consume the extra prompt the abort keystroke produces, so it
                # cannot be mistaken for the next command's.
                await self._settle()

            raw = "".join(self._capture or [])
            self._capture = None
            result = CommandResult(
                command=command,
                output=self._trim(raw, command),
                duration=time.time() - started,
                timed_out=timed_out,
                started=started,
            )
            self.bus.emit("command.end", **result.to_dict())
            return result
        finally:
            self._lock.release()

    @staticmethod
    def _trim(raw: str, command: str) -> str:
        """Drop the PTY echo of the command and the trailing prompt."""
        text = ansi.clean(raw)
        lines = text.split("\n")
        if lines and lines[0].strip() == command.strip():
            lines = lines[1:]
        if lines and PROMPT_ANYWHERE_RE.search(lines[-1]):
            lines[-1] = PROMPT_ANYWHERE_RE.sub("", lines[-1]).rstrip()
            if not lines[-1].strip():
                lines.pop()
        return "\n".join(lines).strip("\n")

    async def _settle(self, quiet: float = 0.4, limit: float = 3.0) -> None:
        """Wait for the output stream to fall silent.

        Aborting injects an Enter, which the client answers with an extra prompt
        once the running command finally returns. That prompt arrives after
        `execute` has handed back its result, and would immediately satisfy the
        *next* command's wait — returning empty output for a command that in
        fact ran. Draining to silence while still holding the lock consumes it.
        """
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            idle = time.monotonic() - self._last_chunk_at
            if idle >= quiet:
                return
            await asyncio.sleep(min(quiet - idle, 0.1))

    async def interrupt(self) -> None:
        """Abort the running command the way the client itself documents.

        The client polls ``kbd_enter_pressed()`` in long-running commands and
        prints "Press pm3 button or <Enter> to abort" — so Enter is the abort
        key. ^C is *not*: ``pm3line_install_signals`` re-raises SIGINT to the
        process group after flushing history, which terminates the client. Use
        :meth:`stop` when that is actually what you want.
        """
        if self.fd is not None:
            with contextlib.suppress(OSError):
                os.write(self.fd, b"\n")

    async def _resync(self) -> None:
        """Wait for the client to return to a prompt after a stuck command.

        The hold is never released speculatively. While a command is still
        writing to the PTY, anything sent next would be swallowed as its abort
        keystroke and its trailing output captured as the new command's result —
        the exact corruption this flag exists to prevent. So the hold lifts only
        on a real prompt; after a grace period the session is escalated to ERROR
        so the operator is told to restart rather than being left guessing.
        """
        self.bus.notify(
            "warning", "Client still busy",
            "A command timed out and did not abort. New commands are held until "
            "it finishes.")
        escalate_at = time.time() + RESYNC_GIVE_UP
        escalated = False

        while self.running:
            if self.port and not Path(self.port).exists():
                # The device was pulled. _watch_port owns that message; leaving
                # quietly avoids a contradictory "restart the client" toast.
                self._desynced = False
                return

            self._prompt_event.clear()
            try:
                await asyncio.wait_for(self._prompt_event.wait(), timeout=5)
            except asyncio.TimeoutError:
                if not escalated and time.time() > escalate_at:
                    escalated = True
                    self._set_status(
                        ERROR, "Client unresponsive — a command never finished")
                    self.bus.notify(
                        "error", "Client did not recover",
                        "The command never finished and commands are still held. "
                        "Restart the client from the Hardware page.",
                        link="#/hardware")
                continue

            self._desynced = False
            if escalated:
                self.bus.notify("success", "Client recovered",
                                "The client returned to a prompt.")
            return

        self._desynced = False

    def attach_port(self, port: str) -> None:
        """Record a port attached after startup (``hw connect``) and watch it.

        Without this the session keeps ``port = None`` — the Hardware page would
        show "not attached" while online, and the disconnection watchdog, which
        only runs when a port is known, would never start.
        """
        if not port:
            return
        self.port = port
        # Clear a stale disconnection message, or the Hardware page keeps showing
        # a red error under a healthy status.
        self.last_error = None
        self._ensure_watchdog()
        self.bus.emit("session", state=self.state(), previous=self.status)

    def _ensure_watchdog(self) -> None:
        """(Re)start the port watcher, including after a previous run finished."""
        if self._watchdog and not self._watchdog.done():
            return
        self._watchdog = asyncio.create_task(self._watch_port(), name="pm3-port-watch")

    async def _watch_port(self) -> None:
        """Track whether the attached device is still present.

        Status is otherwise derived only from the client's prompt, so an
        unplugged Proxmark3 would leave the interface reporting ONLINE forever —
        the one thing a status pill must never do.

        This runs for the life of the session rather than stopping at the first
        removal: the client reconnects by itself (``check_comm`` →
        ``StartReconnectProxmark``) without any ``hw connect``, so a one-shot
        watcher would miss every unplug after the first.
        """
        present = True
        while self.running and self.port:
            await asyncio.sleep(PORT_POLL_INTERVAL)
            if not self.running or not self.port:
                return

            now_present = Path(self.port).exists()
            if now_present == present:
                continue
            present = now_present

            if not present:
                detail = f"Device removed — {self.port} no longer exists"
                self.last_error = detail
                self._set_status(ERROR, detail)
                self.bus.notify(
                    "error", "Device disconnected",
                    f"{self.port} disappeared. Re-plug the Proxmark3, then use "
                    f"Attach device on the Hardware page.", link="#/hardware")
            else:
                # Back on the bus. The client may re-attach on its own at the
                # next command; until a prompt proves it, do not claim ONLINE.
                self.last_error = None
                self.bus.notify(
                    "info", "Device detected again",
                    f"{self.port} is back. Use Attach device if the session does "
                    f"not reconnect by itself.", link="#/hardware")

    async def write_raw(self, data: str) -> None:
        """Feed keystrokes straight into the PTY (Console page)."""
        if not self.running:
            raise SessionNotRunning("proxmark3 client is not running")
        with contextlib.suppress(OSError):
            os.write(self.fd, data.encode())

    async def try_execute(self, command: str, timeout: float = DEFAULT_TIMEOUT) -> CommandResult | None:
        """Best-effort execute used by pollers; returns ``None`` if unavailable."""
        try:
            return await self.execute(command, timeout=timeout)
        except (SessionBusy, SessionNotRunning, ValueError):
            return None

    async def aclose(self) -> None:
        if self.running:
            await self.stop()
