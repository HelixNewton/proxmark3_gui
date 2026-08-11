"""Host and client-process resource sampling.

Every value here comes from ``psutil`` or ``/proc`` — nothing is synthesised. If
``psutil`` is unavailable the sampler reports ``available: False`` and the UI
shows an explicit "metric unavailable" state instead of a flat line.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from collections import deque
from typing import Any

try:
    import psutil
except ImportError:  # pragma: no cover - optional dependency
    psutil = None  # type: ignore

HISTORY = 180  # samples; at 2s interval that is 6 minutes of history


class MetricsSampler:
    """Polls host metrics on a fixed interval and keeps a rolling history."""

    def __init__(self, bus, session, interval: float = 2.0) -> None:
        self.bus = bus
        self.session = session
        self.interval = interval
        self.history: deque[dict] = deque(maxlen=HISTORY)
        self._task: asyncio.Task | None = None
        self._last_net: tuple[float, int, int] | None = None
        self._proc: Any = None
        self._boot_time = psutil.boot_time() if psutil else None

    @property
    def available(self) -> bool:
        return psutil is not None

    # ------------------------------------------------------------- lifecycle
    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="metrics-sampler")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        if psutil:
            psutil.cpu_percent(percpu=True)  # prime the delta counters
        while True:
            try:
                sample = self.sample()
                self.history.append(sample)
                self.bus.publish("events", {"type": "metrics", "ts": sample["ts"],
                                            "sample": sample})
            except Exception as exc:  # keep sampling despite a transient failure
                self.bus.emit("metrics.error", error=str(exc))
            await asyncio.sleep(self.interval)

    # ---------------------------------------------------------------- sample
    def sample(self) -> dict:
        now = time.time()
        if not psutil:
            return {"ts": now, "available": False}

        cpu_per_core = psutil.cpu_percent(percpu=True)
        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        net = psutil.net_io_counters()

        rx_rate = tx_rate = 0.0
        if self._last_net:
            last_ts, last_rx, last_tx = self._last_net
            delta = max(now - last_ts, 1e-6)
            rx_rate = max(0.0, (net.bytes_recv - last_rx) / delta)
            tx_rate = max(0.0, (net.bytes_sent - last_tx) / delta)
        self._last_net = (now, net.bytes_recv, net.bytes_sent)

        return {
            "ts": now,
            "available": True,
            "cpu": {
                "percent": round(sum(cpu_per_core) / len(cpu_per_core), 1) if cpu_per_core else 0.0,
                "perCore": [round(v, 1) for v in cpu_per_core],
                "cores": len(cpu_per_core),
                "loadAvg": [round(v, 2) for v in psutil.getloadavg()]
                if hasattr(psutil, "getloadavg") else None,
            },
            "memory": {
                "total": memory.total,
                "used": memory.used,
                "available": memory.available,
                "percent": memory.percent,
                "swapTotal": swap.total,
                "swapUsed": swap.used,
                "swapPercent": swap.percent,
            },
            "net": {
                "rxRate": round(rx_rate, 1),
                "txRate": round(tx_rate, 1),
                "rxTotal": net.bytes_recv,
                "txTotal": net.bytes_sent,
            },
            "client": self._client_metrics(),
        }

    def _client_metrics(self) -> dict:
        """Resource usage of the proxmark3 client process itself."""
        pid = getattr(self.session, "pid", None)
        if not psutil or not pid:
            self._proc = None
            return {"running": False}
        try:
            if self._proc is None or self._proc.pid != pid:
                self._proc = psutil.Process(pid)
                self._proc.cpu_percent(None)
            with self._proc.oneshot():
                return {
                    "running": True,
                    "pid": pid,
                    "cpuPercent": round(self._proc.cpu_percent(None), 1),
                    "rss": self._proc.memory_info().rss,
                    "threads": self._proc.num_threads(),
                    "createdAt": self._proc.create_time(),
                }
        except Exception:
            self._proc = None
            return {"running": False, "pid": pid}

    # ------------------------------------------------------------------ disk
    def storage(self, paths: dict[str, Any]) -> list[dict]:
        """Disk usage for the filesystems holding the client's directories.

        Several client directories usually share one filesystem, so results are
        grouped by mount point and labelled with the mount — not with whichever
        directory happened to be enumerated first.
        """
        mounts = self._mount_points()
        grouped: dict[str, dict] = {}
        for name, path in paths.items():
            try:
                usage = shutil.disk_usage(str(path))
            except OSError:
                continue
            mount = self._mount_for(str(path), mounts)
            entry = grouped.setdefault(mount, {
                "name": mount,
                "mount": mount,
                "paths": [],
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": round(usage.used / usage.total * 100, 1) if usage.total else 0,
            })
            entry["paths"].append({"name": name, "path": str(path)})

        for entry in grouped.values():
            entry["path"] = ", ".join(item["name"] for item in entry["paths"])
        return sorted(grouped.values(), key=lambda entry: entry["mount"])

    @staticmethod
    def _mount_points() -> list[str]:
        if not psutil:
            return ["/"]
        try:
            return sorted((part.mountpoint for part in psutil.disk_partitions(all=False)),
                          key=len, reverse=True)
        except Exception:
            return ["/"]

    @staticmethod
    def _mount_for(path: str, mounts: list[str]) -> str:
        for mount in mounts:
            if path == mount or path.startswith(mount.rstrip("/") + "/"):
                return mount
        return "/"

    def host_info(self) -> dict:
        info: dict = {"available": self.available}
        if not psutil:
            return info
        import platform
        info.update({
            "hostname": platform.node(),
            "system": f"{platform.system()} {platform.release()}",
            "machine": platform.machine(),
            "python": platform.python_version(),
            "cores": psutil.cpu_count(logical=True),
            "physicalCores": psutil.cpu_count(logical=False),
            "bootTime": self._boot_time,
            "uptime": time.time() - self._boot_time if self._boot_time else None,
        })
        try:
            freq = psutil.cpu_freq()
            if freq:
                info["cpuFreqMhz"] = round(freq.current, 0)
        except Exception:
            pass
        return info

    def recent(self, limit: int = HISTORY) -> list[dict]:
        return list(self.history)[-limit:]
