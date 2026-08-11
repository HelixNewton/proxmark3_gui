"""Command catalogue built from ``doc/commands.json``.

That file is generated during the client build (``pm3_help2json.py``) and holds
every command's description, usage string, options and offline availability —
896 entries at the time of writing. It powers the command palette, the console
autocomplete and the Command Reference page, so none of that is hand-maintained.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Command:
    name: str
    description: str
    usage: str
    options: list[str]
    notes: list[str]
    offline: bool

    @property
    def group(self) -> str:
        return self.name.split(" ")[0]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "group": self.group,
            "description": self.description,
            "usage": self.usage,
            "options": self.options,
            "notes": self.notes,
            "offline": self.offline,
        }


class CommandCatalog:
    def __init__(self) -> None:
        self.commands: dict[str, Command] = {}
        self.metadata: dict = {}
        self.source: str | None = None
        self.error: str | None = None
        self._groups: dict[str, int] | None = None

    @classmethod
    def load(cls, path: Path) -> "CommandCatalog":
        catalog = cls()
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            catalog.error = f"Could not read {path}: {exc}"
            return catalog

        catalog.source = str(path)
        catalog.metadata = data.get("metadata", {})
        for name, entry in (data.get("commands") or {}).items():
            catalog.commands[name] = Command(
                name=name,
                description=(entry.get("description") or "").strip(),
                usage=(entry.get("usage") or "").strip(),
                options=[o for o in entry.get("options", []) if o.strip()],
                notes=[n for n in entry.get("notes", []) if n.strip()],
                offline=bool(entry.get("offline")),
            )
        return catalog

    # ------------------------------------------------------------------ query
    @property
    def groups(self) -> dict[str, int]:
        """Command count per top-level group. Computed once — the catalogue is
        immutable after load, and this is read on every /api/status."""
        if self._groups is None:
            counts: dict[str, int] = {}
            for command in self.commands.values():
                counts[command.group] = counts.get(command.group, 0) + 1
            self._groups = dict(sorted(counts.items()))
        return self._groups

    def get(self, name: str) -> Command | None:
        return self.commands.get(name.strip())

    def search(self, query: str, limit: int = 40, offline_only: bool = False) -> list[dict]:
        """Fuzzy-ish ranked search: prefix > substring > description match."""
        query = (query or "").strip().lower()
        results: list[tuple[int, Command]] = []
        for command in self.commands.values():
            if offline_only and not command.offline:
                continue
            if not query:
                results.append((0, command))
                continue
            name = command.name.lower()
            if name.startswith(query):
                score = 0
            elif query in name:
                score = 1
            elif all(part in name for part in query.split()):
                score = 2
            elif query in command.description.lower():
                score = 3
            else:
                continue
            results.append((score, command))

        results.sort(key=lambda item: (item[0], len(item[1].name), item[1].name))
        return [command.to_dict() for _, command in results[:limit]]

    def complete(self, partial: str, limit: int = 12) -> list[str]:
        """Console autocomplete: next-token suggestions for a partial command."""
        partial = partial.lstrip()
        lowered = partial.lower()
        seen: list[str] = []
        for name in sorted(self.commands):
            if not name.lower().startswith(lowered):
                continue
            if name not in seen:
                seen.append(name)
            if len(seen) >= limit:
                break
        return seen

    def option_flags(self, name: str) -> list[dict]:
        """Split an entry's option strings into ``{flags, description}`` pairs."""
        command = self.get(name)
        if not command:
            return []
        out = []
        for option in command.options:
            match = re.match(r"^\s*(-{1,2}[^\s,]+(?:,\s*-{1,2}[^\s,]+)*)\s*(.*)$", option)
            if match:
                out.append({"flags": match.group(1), "description": match.group(2).strip()})
            else:
                out.append({"flags": "", "description": option.strip()})
        return out
