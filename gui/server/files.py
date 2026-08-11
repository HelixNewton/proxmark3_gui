"""Path-constrained filesystem access for the resource browser.

Every filesystem endpoint goes through :func:`resolve_in_root`, which resolves
symlinks *before* the containment check — so neither ``../`` segments nor a
symlink planted inside a root can reach outside the configured directories.
Writes are limited to explicit, separately-guarded operations.
"""

from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path

MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_LIST_ENTRIES = 2000

#: Extensions the viewer renders as text; anything else gets a hex preview.
TEXT_SUFFIXES = {
    ".txt", ".md", ".json", ".lua", ".py", ".cmd", ".dic", ".pm3", ".log",
    ".csv", ".xml", ".yml", ".yaml", ".sh", ".c", ".h", ".cfg", ".ini", ".eml",
}


class PathDenied(PermissionError):
    """Raised when a request tries to escape its root."""


@dataclass(frozen=True)
class Resolved:
    root_name: str
    root: Path
    path: Path

    @property
    def relative(self) -> str:
        rel = self.path.relative_to(self.root)
        return "" if str(rel) == "." else str(rel)


def resolve_in_root(roots: dict[str, Path], root_name: str, relative: str = "") -> Resolved:
    root = roots.get(root_name)
    if root is None:
        raise PathDenied(f"Unknown root '{root_name}'")
    root = root.resolve()

    relative = (relative or "").strip().lstrip("/")
    if "\x00" in relative:
        raise PathDenied("Invalid path")
    candidate = (root / relative).resolve()
    # `strict=False` resolution above already collapsed symlinks and `..`.
    if candidate != root and root not in candidate.parents:
        raise PathDenied("Path escapes its root directory")
    return Resolved(root_name=root_name, root=root, path=candidate)


def describe(path: Path, root: Path) -> dict:
    try:
        stat = path.stat()
    except OSError as exc:
        return {"name": path.name, "error": str(exc)}
    rel = str(path.relative_to(root)) if path != root else ""
    return {
        "name": path.name,
        "path": rel,
        "isDir": path.is_dir(),
        "size": stat.st_size if path.is_file() else None,
        "modified": stat.st_mtime,
        "suffix": path.suffix.lower(),
        "kind": classify_kind(path),
    }


def classify_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if path.is_dir():
        return "dir"
    if suffix in (".pm3", ".trace"):
        return "trace"
    if suffix == ".dic":
        return "dictionary"
    if suffix in (".lua", ".py", ".cmd"):
        return "script"
    if suffix in (".bin", ".eml", ".mfd", ".json") and "dump" in path.name.lower():
        return "dump"
    if suffix in (".bin", ".eml", ".mfd"):
        return "dump"
    if suffix in (".txt", ".log"):
        return "log"
    return "file"


def list_directory(roots: dict[str, Path], root_name: str, relative: str = "",
                   query: str = "", kinds: set[str] | None = None) -> dict:
    resolved = resolve_in_root(roots, root_name, relative)
    if not resolved.path.exists():
        raise FileNotFoundError(f"{resolved.relative or root_name} does not exist")
    if not resolved.path.is_dir():
        raise NotADirectoryError(f"{resolved.relative} is not a directory")

    entries: list[dict] = []
    truncated = False
    try:
        with os.scandir(resolved.path) as iterator:
            for count, item in enumerate(iterator):
                if count >= MAX_LIST_ENTRIES:
                    truncated = True
                    break
                if item.name.startswith("."):
                    continue
                entry = describe(Path(item.path), resolved.root)
                if query and query.lower() not in entry["name"].lower():
                    continue
                if kinds and entry.get("kind") not in kinds and not entry.get("isDir"):
                    continue
                entries.append(entry)
    except OSError as exc:
        raise FileNotFoundError(str(exc)) from exc

    entries.sort(key=lambda e: (not e.get("isDir"), e["name"].lower()))
    return {
        "root": root_name,
        "path": resolved.relative,
        "absolute": str(resolved.path),
        "parent": str(Path(resolved.relative).parent) if resolved.relative else None,
        "entries": entries,
        "truncated": truncated,
    }


def read_file(roots: dict[str, Path], root_name: str, relative: str,
              max_bytes: int = MAX_TEXT_BYTES) -> dict:
    resolved = resolve_in_root(roots, root_name, relative)
    if not resolved.path.is_file():
        raise FileNotFoundError(f"{relative} is not a file")
    size = resolved.path.stat().st_size
    data = resolved.path.read_bytes()[:max_bytes]
    is_text = resolved.path.suffix.lower() in TEXT_SUFFIXES or _looks_textual(data)
    payload = {
        "root": root_name,
        "path": resolved.relative,
        "absolute": str(resolved.path),
        "size": size,
        "truncated": size > max_bytes,
        "isText": is_text,
        "mime": mimetypes.guess_type(resolved.path.name)[0] or "application/octet-stream",
    }
    if is_text:
        payload["text"] = data.decode("utf-8", "replace")
    else:
        payload["hex"] = data[:8192].hex()
    return payload


def _looks_textual(data: bytes) -> bool:
    if not data:
        return True
    sample = data[:4096]
    if b"\x00" in sample:
        return False
    printable = sum(1 for byte in sample if 32 <= byte < 127 or byte in (9, 10, 13))
    return printable / len(sample) > 0.85


def absolute_path(roots: dict[str, Path], root_name: str, relative: str) -> Path:
    """Resolve to a real path for download/streaming, verifying it is a file."""
    resolved = resolve_in_root(roots, root_name, relative)
    if not resolved.path.is_file():
        raise FileNotFoundError(f"{relative} is not a file")
    return resolved.path


def delete_file(roots: dict[str, Path], root_name: str, relative: str) -> dict:
    """Delete a file inside a root. Directories are never removed."""
    resolved = resolve_in_root(roots, root_name, relative)
    if not resolved.path.is_file():
        raise FileNotFoundError(f"{relative} is not a file")
    resolved.path.unlink()
    return {"deleted": resolved.relative, "root": root_name}
