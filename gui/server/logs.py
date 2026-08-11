"""Reader and live tailer for the client's rolling session logs.

The client writes ``~/.proxmark3/logs/log_YYYYMMDDHHMMSS.txt`` per run
(``client/src/ui.c``). Each line carries the same severity prefix as the console,
so the viewer can filter by level without any extra instrumentation.
"""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path

from . import ansi

_TS_RE = re.compile(r"^(?P<ts>\d{2}:\d{2}:\d{2})\s+(?P<rest>.*)$")
MAX_TAIL_BYTES = 4 * 1024 * 1024


def list_log_files(log_dir: Path) -> list[dict]:
    if not log_dir.exists():
        return []
    entries = []
    for path in log_dir.glob("log_*.txt"):
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append({
            "name": path.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })
    entries.sort(key=lambda e: e["modified"], reverse=True)
    return entries


def newest_log(log_dir: Path) -> Path | None:
    files = list_log_files(log_dir)
    return (log_dir / files[0]["name"]) if files else None


def parse_line(line: str, index: int) -> dict:
    """Split a log line into ``{level, time, message}``."""
    text = ansi.clean(line).rstrip()
    stamp = None
    match = _TS_RE.match(text)
    if match:
        stamp = match.group("ts")
        text = match.group("rest")
    level, message = ansi.classify(text)
    return {"n": index, "time": stamp, "level": level, "message": message, "raw": text}


def read_log(path: Path, limit: int = 2000, level: str | None = None,
             query: str | None = None) -> dict:
    """Read the tail of a log file with optional level/substring filtering."""
    if not path.is_file():
        raise FileNotFoundError(str(path))
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > MAX_TAIL_BYTES:
            handle.seek(size - MAX_TAIL_BYTES)
            handle.readline()  # discard the partial first line
        data = handle.read()

    raw_lines = data.decode("utf-8", "replace").split("\n")
    entries = [parse_line(line, i) for i, line in enumerate(raw_lines) if line.strip()]

    if level and level != "all":
        wanted = {level}
        if level == "problems":
            wanted = {"warning", "error", "critical"}
        entries = [e for e in entries if e["level"] in wanted]
    if query:
        lowered = query.lower()
        entries = [e for e in entries if lowered in e["raw"].lower()]

    total = len(entries)
    return {
        "file": path.name,
        "path": str(path),
        "size": size,
        "truncated": size > MAX_TAIL_BYTES,
        "total": total,
        "entries": entries[-limit:],
        "counts": _count_levels(entries),
    }


def _count_levels(entries: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry["level"]] = counts.get(entry["level"], 0) + 1
    return counts


class LogTailer:
    """Polls the newest log file and publishes appended lines on the bus.

    Polling (rather than inotify) keeps the dependency surface at zero and is
    cheap: one ``stat`` plus a short read per interval.
    """

    def __init__(self, bus, log_dir: Path, interval: float = 1.0) -> None:
        self.bus = bus
        self.log_dir = log_dir
        self.interval = interval
        self.current: Path | None = None
        self._offset = 0
        self._task: asyncio.Task | None = None
        self._counter = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="log-tailer")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        while True:
            try:
                self._poll()
            except Exception as exc:
                self.bus.emit("logs.error", error=str(exc))
            await asyncio.sleep(self.interval)

    def _poll(self) -> None:
        newest = newest_log(self.log_dir)
        if newest is None:
            return
        if newest != self.current:
            self.current = newest
            # Start at EOF: history is fetched over REST, the stream is live-only.
            self._offset = newest.stat().st_size
            self.bus.emit("logs.rotated", file=newest.name)
            return

        size = newest.stat().st_size
        if size < self._offset:  # truncated / replaced
            self._offset = 0
        if size == self._offset:
            return

        with newest.open("rb") as handle:
            handle.seek(self._offset)
            chunk = handle.read(size - self._offset)
            self._offset = handle.tell()

        text = chunk.decode("utf-8", "replace")
        lines = text.split("\n")
        if lines and not text.endswith("\n"):
            # Keep the trailing partial line for the next poll.
            self._offset -= len(lines[-1].encode("utf-8"))
            lines = lines[:-1]

        batch = []
        for line in lines:
            if not line.strip():
                continue
            self._counter += 1
            batch.append(parse_line(line, self._counter))
        if batch:
            self.bus.publish("events", {"type": "logs.append", "ts": time.time(),
                                        "file": newest.name, "entries": batch})
