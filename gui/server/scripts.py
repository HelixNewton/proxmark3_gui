"""Discovery of the Lua / Cmd / Python scripts the client can run.

``script list`` prints a tree meant for humans; scanning the same directories
directly gives sizes, modification times and the author's own header comment,
which is what the Scripts page needs. Search order matches the client: the repo
directory first, then ``~/.proxmark3`` overrides.
"""

from __future__ import annotations

import re
from pathlib import Path

SUFFIX_BY_KIND = {"lua": ".lua", "cmd": ".cmd", "py": ".py"}

_COMMENT_PREFIXES = ("--", "#", "rem ", "REM ")
_AUTHOR_RE = re.compile(r"author\s*[:=]\s*(.+)", re.I)


def _extract_header(path: Path, max_lines: int = 25) -> dict:
    """Pull a one-line description (and author, if stated) from leading comments."""
    description, author = "", ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= max_lines:
                    break
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#!"):
                    continue
                if not stripped.startswith(_COMMENT_PREFIXES):
                    if index > 3:
                        break
                    continue
                body = stripped.lstrip("-#").lstrip("rem").lstrip("REM").strip(" -=*")
                author_match = _AUTHOR_RE.search(body)
                if author_match and not author:
                    author = author_match.group(1).strip()
                    continue
                if body and not description and len(body) > 8:
                    description = body[:200]
    except OSError:
        pass
    return {"description": description, "author": author}


#: Listing opens every script to read its header comment — ~107 files here. The
#: global search endpoint calls this on each keystroke, so the result is cached
#: and only recomputed when a script directory actually changes.
_CACHE: dict[str, object] = {"signature": None, "value": None}


def _signature(script_dirs: dict[str, list[Path]]) -> tuple:
    """Cheap fingerprint of the search path: which dirs exist and their mtimes."""
    marks = []
    for kind, directories in sorted(script_dirs.items()):
        for directory in directories:
            try:
                marks.append((kind, str(directory), directory.stat().st_mtime_ns))
            except OSError:
                marks.append((kind, str(directory), None))
    return tuple(marks)


def list_scripts(script_dirs: dict[str, list[Path]], use_cache: bool = True) -> dict:
    """Return every runnable script grouped by language, with source directory.

    A directory mtime changes when a script is added, removed or renamed, which
    is what the listing reflects. Editing a script in place does not invalidate
    the cache; the Scripts page passes ``use_cache=False`` so its Rescan button
    always reads from disk.
    """
    signature = _signature(script_dirs)
    if use_cache and _CACHE["signature"] == signature and _CACHE["value"] is not None:
        return _CACHE["value"]  # type: ignore[return-value]

    result = _scan_scripts(script_dirs)
    _CACHE["signature"] = signature
    _CACHE["value"] = result
    return result


def _scan_scripts(script_dirs: dict[str, list[Path]]) -> dict:
    scripts: list[dict] = []
    searched: list[dict] = []

    for kind, directories in script_dirs.items():
        suffix = SUFFIX_BY_KIND[kind]
        for directory in directories:
            exists = directory.exists()
            searched.append({"kind": kind, "path": str(directory), "exists": exists})
            if not exists:
                continue
            for path in sorted(directory.glob(f"*{suffix}")):
                if not path.is_file():
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                header = _extract_header(path)
                scripts.append({
                    "name": path.stem,
                    "file": path.name,
                    "kind": kind,
                    "directory": str(directory),
                    "absolute": str(path),
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "userOverride": ".proxmark3" in str(directory),
                    **header,
                })

    # A user copy shadows the repo copy of the same name (client search order).
    by_key: dict[tuple[str, str], dict] = {}
    for script in scripts:
        key = (script["kind"], script["name"])
        if key not in by_key or script["userOverride"]:
            by_key[key] = script

    result = sorted(by_key.values(), key=lambda s: (s["kind"], s["name"].lower()))
    return {
        "scripts": result,
        "searchPaths": searched,
        "counts": {
            kind: sum(1 for s in result if s["kind"] == kind)
            for kind in SUFFIX_BY_KIND
        },
    }


#: Script names must reach the client as a bare identifier — no paths, no flags.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def validate_script_name(name: str) -> str:
    name = (name or "").strip()
    if not _SAFE_NAME_RE.match(name):
        raise ValueError(
            "Script name may only contain letters, digits, dot, dash and underscore")
    if name.startswith("-") or ".." in name:
        raise ValueError("Invalid script name")
    return name


#: Extra arguments are passed through to the script, so they are restricted to
#: shell-inert characters. The client parses them itself; no shell is involved.
_SAFE_ARG_RE = re.compile(r"^[A-Za-z0-9 ._:,=/@+-]{0,512}$")


def validate_script_args(args: str) -> str:
    args = (args or "").strip()
    if not args:
        return ""
    if not _SAFE_ARG_RE.match(args):
        raise ValueError(
            "Script arguments contain unsupported characters. Allowed: letters, "
            "digits and . _ : , = / @ + - space")
    return args
