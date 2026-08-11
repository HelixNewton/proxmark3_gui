"""ANSI/OSC handling for proxmark3 client output.

The client emits SGR colour codes (when enabled), OSC-8 hyperlinks (always, e.g.
around the "Proxmark3" banner word) and in-place spinner updates using ``\\r``.
Structured parsing always runs on stripped text; the console view keeps the raw
bytes so it looks like a real terminal.
"""

from __future__ import annotations

import re

# CSI sequences, OSC sequences terminated by BEL or ST, and single-char escapes.
_CSI = r"\x1b\[[0-9;?]*[ -/]*[@-~]"
_OSC = r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
_OTHER = r"\x1b[@-Z\\-_]"
_ANSI_RE = re.compile(f"{_CSI}|{_OSC}|{_OTHER}")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

#: Message severity prefixes emitted by ``PrintAndLogEx`` (client/src/ui.c).
LEVEL_BY_PREFIX = {
    "!!": "critical",
    "-": "error",
    "!": "warning",
    "+": "success",
    "=": "info",
    "#": "debug",
    "?": "hint",
}

_PREFIX_RE = re.compile(r"^\[(!!|[-!+=#?])\]\s?(.*)$")


def strip(text: str) -> str:
    """Remove escape sequences, leaving printable text."""
    return _ANSI_RE.sub("", text)


def clean(text: str) -> str:
    """Strip escapes, collapse in-place ``\\r`` rewrites and drop stray controls.

    A PTY translates every outgoing ``\\n`` into ``\\r\\n`` (ONLCR), so those pairs
    are normalised first — otherwise every single line would look like an
    in-place rewrite and be discarded.
    """
    text = strip(text).replace("\r\n", "\n")
    out_lines = []
    for line in text.split("\n"):
        # A bare carriage return means the client redrew the line (INPLACE
        # spinners and progress counters); keep only the final state.
        if "\r" in line:
            line = line.split("\r")[-1]
        out_lines.append(_CTRL_RE.sub("", line))
    return "\n".join(out_lines)


def classify(line: str) -> tuple[str, str]:
    """Split a client output line into ``(level, message)``.

    Lines without a known prefix are reported as ``normal`` so that tables and
    banners are not mislabelled as log records.
    """
    stripped = clean(line).rstrip()
    match = _PREFIX_RE.match(stripped.lstrip())
    if not match:
        return "normal", stripped
    return LEVEL_BY_PREFIX.get(match.group(1), "info"), match.group(2)
