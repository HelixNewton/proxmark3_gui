"""Runtime configuration and filesystem layout discovery for the PM3 command centre.

Everything the GUI touches on disk is resolved through :class:`AppConfig` so that
file-serving endpoints can be constrained to a fixed set of roots (see
``server/files.py``).  Nothing here invents paths: they mirror the layout that the
proxmark3 client itself uses (see ``doc/path_notes.md``).
"""

from __future__ import annotations

import os
import secrets
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

# Repo root == parent of gui/
GUI_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = GUI_DIR.parent
WEB_DIR = GUI_DIR / "web"


def _first_existing(*candidates: Path) -> Path | None:
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def find_client_binary() -> Path | None:
    """Locate the proxmark3 client the same way the ``pm3`` launcher script does."""
    candidates = [
        REPO_ROOT / "client" / "proxmark3",
        REPO_ROOT / "client" / "build" / "proxmark3",
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    which = shutil.which("proxmark3")
    return Path(which) if which else None


def user_dir() -> Path:
    """``~/.proxmark3`` — created lazily by the client, may not exist yet."""
    return Path(os.path.expanduser("~")) / ".proxmark3"


@dataclass
class AppConfig:
    host: str = "127.0.0.1"
    port: int = 8788
    client_binary: Path | None = field(default_factory=find_client_binary)
    #: Serial port to attach to; ``None`` means auto-detect, ``""`` means stay offline.
    serial_port: str | None = None
    autostart: bool = True
    #: Do not write history/prefs/log files (mirrors the client's --incognito).
    incognito: bool = False
    #: Token required on every request when bound to a non-loopback address.
    auth_token: str | None = None
    open_browser: bool = False
    #: Extra roots the file browser is allowed to read (never written to).
    debug: bool = False

    #: `roots` stats every client directory and is read several times per
    #: request, so results are held briefly. Short enough that a directory
    #: appearing mid-session is picked up promptly.
    ROOTS_TTL = 5.0

    def __post_init__(self) -> None:
        self._roots_cache: tuple[float, dict[str, Path]] | None = None
        if not self.is_loopback and not self.auth_token:
            # Never expose an arbitrary-command-execution surface unauthenticated.
            self.auth_token = secrets.token_urlsafe(24)

    @property
    def is_loopback(self) -> bool:
        return self.host in ("127.0.0.1", "::1", "localhost")

    # ---- filesystem roots exposed through the file APIs -------------------
    @property
    def roots(self) -> dict[str, Path]:
        """Named, read-constrained roots. Missing directories are simply omitted."""
        if self._roots_cache is not None:
            stamped, cached = self._roots_cache
            if time.monotonic() - stamped < self.ROOTS_TTL:
                return cached
        user = user_dir()
        candidates = {
            "traces": _first_existing(user / "traces", REPO_ROOT / "traces"),
            "repo-traces": REPO_ROOT / "traces",
            # Strictly the dumps directory: falling back to ~/.proxmark3 would
            # label the whole user directory "dumps".
            "dumps": user / "dumps",
            "dictionaries": _first_existing(
                REPO_ROOT / "client" / "dictionaries", user / "dictionaries"
            ),
            "luascripts": _first_existing(
                REPO_ROOT / "client" / "luascripts", user / "luascripts"
            ),
            "cmdscripts": _first_existing(
                REPO_ROOT / "client" / "cmdscripts", user / "cmdscripts"
            ),
            "pyscripts": _first_existing(
                REPO_ROOT / "client" / "pyscripts", user / "pyscripts"
            ),
            "resources": _first_existing(
                REPO_ROOT / "client" / "resources", user / "resources"
            ),
            "logs": user / "logs",
            "user": user,
        }
        resolved: dict[str, Path] = {}
        seen: set[Path] = set()
        for name, path in candidates.items():
            if not path or not path.exists():
                continue
            real = path.resolve()
            # When ~/.proxmark3/traces does not exist, "traces" already points at
            # the repository copy; listing it twice would just be confusing.
            if real in seen:
                continue
            seen.add(real)
            resolved[name] = real
        self._roots_cache = (time.monotonic(), resolved)
        return resolved

    def writable_roots(self) -> set[str]:
        """Roots the GUI may delete from: only the user's own ``~/.proxmark3``.

        Derived from the resolved path rather than the root's name — when
        ``~/.proxmark3/traces`` is absent, the ``traces`` root *is* the
        repository's sample collection and must stay read-only.
        """
        user = user_dir()
        try:
            user = user.resolve()
        except OSError:
            return set()
        return {
            name for name, path in self.roots.items()
            if path == user or user in path.parents
        }

    @property
    def script_dirs(self) -> dict[str, list[Path]]:
        """Script search path per language, repo dir first then the user dir."""
        user = user_dir()
        return {
            "lua": [REPO_ROOT / "client" / "luascripts", user / "luascripts"],
            "cmd": [REPO_ROOT / "client" / "cmdscripts", user / "cmdscripts"],
            "py": [REPO_ROOT / "client" / "pyscripts", user / "pyscripts"],
        }

    @property
    def commands_json(self) -> Path:
        return REPO_ROOT / "doc" / "commands.json"

    @property
    def log_dir(self) -> Path:
        return user_dir() / "logs"

    @property
    def prefs_file(self) -> Path:
        return user_dir() / "preferences.json"

    @property
    def scratch_dir(self) -> Path:
        """Where the server drops short-lived files (graph buffer exports, etc.)."""
        d = user_dir() / "gui-scratch"
        d.mkdir(parents=True, exist_ok=True)
        return d
