"""Serial port discovery for Proxmark3 hardware.

Detection mirrors the ``pm3`` launcher script: a port is considered a Proxmark3
when its USB vendor/product ID matches one of the known pairs, or when udev
reports ``ID_VENDOR=proxmark.org``. Ports that merely *look* plausible are
returned too, flagged as unconfirmed, so the user can still pick a UART/BT link.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
from pathlib import Path

try:
    from serial.tools import list_ports
except ImportError:  # pragma: no cover - optional dependency
    list_ports = None  # type: ignore

#: (vendor, product) pairs from driver/proxmark3.inf and the udev rules.
KNOWN_IDS = {
    (0x9AC4, 0x4B8F): "Proxmark3 (proxmark.org)",
    (0x2D2D, 0x504D): "Proxmark3 (legacy VID)",
    (0x502D, 0x502D): "Proxmark3 Easy",
}
#: The Blue Shark add-on presents as a CP2104 UART bridge.
BT_BRIDGE_IDS = {(0x10C4, 0xEA60): "CP2104 UART bridge (Blue Shark?)"}


def _udev_is_pm3(device: str) -> bool:
    if not shutil.which("udevadm"):
        return False
    try:
        out = subprocess.run(
            ["udevadm", "info", "-q", "property", "-n", device],
            capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "ID_VENDOR=proxmark.org" in out


def _access(path: str) -> dict:
    """Report whether the current user can actually open the port."""
    readable = os.access(path, os.R_OK)
    writable = os.access(path, os.W_OK)
    detail = None
    if not (readable and writable):
        try:
            group = Path(path).group()
            detail = (f"No read/write access. The port belongs to group '{group}' — "
                      f"add your user to it and re-login.")
        except (KeyError, OSError):
            detail = "No read/write access to this port."
    return {"readable": readable, "writable": writable, "detail": detail}


def list_serial_ports() -> dict:
    """Enumerate candidate ports. Never raises — returns a diagnosable result."""
    ports: list[dict] = []
    warnings: list[str] = []

    if list_ports is not None:
        for info in list_ports.comports():
            vid_pid = (info.vid, info.pid)
            label = KNOWN_IDS.get(vid_pid) or BT_BRIDGE_IDS.get(vid_pid)
            confirmed = vid_pid in KNOWN_IDS or _udev_is_pm3(info.device)
            ports.append({
                "path": info.device,
                "description": info.description or "",
                "manufacturer": info.manufacturer or "",
                "product": info.product or "",
                "serialNumber": info.serial_number or "",
                "vid": info.vid,
                "pid": info.pid,
                "vidPid": f"{info.vid:04x}:{info.pid:04x}" if info.vid and info.pid else None,
                "match": label,
                "isProxmark": confirmed,
                "kind": "usb" if info.vid else "serial",
                "access": _access(info.device),
            })
    else:
        warnings.append("pyserial is not installed — falling back to /dev scanning.")
        for path in sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")):
            ports.append({
                "path": path, "description": "", "manufacturer": "", "product": "",
                "serialNumber": "", "vid": None, "pid": None, "vidPid": None,
                "match": None, "isProxmark": _udev_is_pm3(path),
                "kind": "serial", "access": _access(path),
            })

    # Bluetooth rfcomm links the pm3 script also looks for.
    for path in sorted(glob.glob("/dev/rfcomm*")):
        if any(p["path"] == path for p in ports):
            continue
        ports.append({
            "path": path, "description": "Bluetooth rfcomm link", "manufacturer": "",
            "product": "", "serialNumber": "", "vid": None, "pid": None, "vidPid": None,
            "match": "rfcomm", "isProxmark": False, "kind": "bluetooth",
            "access": _access(path),
        })

    ports.sort(key=lambda p: (not p["isProxmark"], p["path"]))
    if not ports:
        warnings.append(
            "No serial ports detected. Connect a Proxmark3 over USB, or check that "
            "your user may access /dev/ttyACM* (dialout/uucp group).")
    return {"ports": ports, "warnings": warnings}


def auto_detect() -> str | None:
    """Return the single best Proxmark3 port, or ``None`` when ambiguous/absent."""
    confirmed = [p["path"] for p in list_serial_ports()["ports"] if p["isProxmark"]]
    return confirmed[0] if len(confirmed) == 1 else (confirmed[0] if confirmed else None)
