"""Parsers for proxmark3 client text output.

The client formats almost everything as ``[=] Label........ value`` under
``[=] --- Section ---`` headers, so one generic parser covers ``hw version``,
``hw status``, ``mem info``, ``prefs show`` and friends. Where a value is genuinely
structured (antenna voltages, SPIFFS usage) a targeted extractor runs on top.

Every parser also returns the raw text: when the client prints something the
parser does not recognise, the UI shows the real output rather than an empty
panel pretending the data does not exist.
"""

from __future__ import annotations

import re

from . import ansi

# "  Compiler.................. GCC 15.3.0"  /  "[=]     emoji....... alttext"
_KV_RE = re.compile(r"^(?P<key>[^.]*?)\s*\.{2,}\s*(?P<value>.*)$")
# Some labels are long enough that the dot padding collapses to a single dot,
# e.g. "Readline/Linenoise support.absent". Accepting one dot unconditionally
# would misread values like "125.00 kHz", so require a long, non-numeric key.
_KV_ONE_DOT_RE = re.compile(r"^(?P<key>[^.]{10,}?[^.\d\s])\.(?P<value>[^\s.][^.]*)$")


def match_kv(text: str) -> re.Match | None:
    return _KV_RE.match(text) or _KV_ONE_DOT_RE.match(text)


# "-------- LF Antenna ----------"  /  " [ Client ]"
_SECTION_DASH_RE = re.compile(r"^-{2,}\s*(?P<name>.+?)\s*-{2,}$")
_SECTION_BRACKET_RE = re.compile(r"^\[\s*(?P<name>[^\]]+?)\s*\]$")
_HAS_WORD_RE = re.compile(r"[A-Za-z0-9]")


#: `hw status` groups by indentation rather than by decoration: the firmware
#: prints "Memory" flush-left and its readings indented beneath it. Guards keep
#: ordinary prose (paths, sentences, log lines) from being mistaken for a
#: heading.
_BARE_HEADING_RE = re.compile(r"^[A-Z][\w][\w \-/]{1,38}$")


def match_bare_heading(body: str) -> str | None:
    """Detect an unindented, undecorated section heading.

    ``body`` must still carry its original leading whitespace — the indentation
    *is* the signal.
    """
    if body[:1].isspace() or not body.strip():
        return None
    candidate = body.strip()
    if any(ch in candidate for ch in "`:.=|"):
        return None
    return candidate if _BARE_HEADING_RE.match(candidate) else None


def match_section(text: str) -> str | None:
    """Return a section name, or ``None`` if this is not a section header.

    ``hw status`` draws table rules like
    ``---------------------------+-----+-----+-----+------``, whose middle the
    dash pattern would otherwise capture as a heading. A real heading always
    contains a letter or digit.
    """
    match = _SECTION_DASH_RE.match(text) or _SECTION_BRACKET_RE.match(text)
    if not match:
        return None
    name = match.group("name").strip()
    return name if _HAS_WORD_RE.search(name) else None


def _lines(text: str) -> list[str]:
    return [ansi.clean(l).rstrip() for l in text.split("\n")]


def parse_sections(text: str) -> dict:
    """Turn dotted key/value output into ``{sections: [{name, entries[]}], raw}``."""
    sections: list[dict] = []
    current: dict = {"name": "", "entries": [], "lines": []}
    messages: list[dict] = []

    for raw_line in _lines(text):
        level, body = ansi.classify(raw_line)
        stripped = body.strip()
        if not stripped:
            continue

        # `body` still carries its indentation, which is how `hw status` marks
        # its headings; `stripped` is used for everything else.
        section_name = match_section(stripped) or match_bare_heading(body)
        if section_name is not None:
            if current["entries"] or current["lines"]:
                sections.append(current)
            current = {"name": section_name, "entries": [], "lines": []}
            continue

        kv = match_kv(stripped)
        if kv and kv.group("key").strip():
            current["entries"].append({
                "key": kv.group("key").strip(),
                "value": kv.group("value").strip(),
                "level": level,
                # Keep the original line: some sections (FPGA bitstream lists)
                # are prose that merely looks like a dotted key/value.
                "raw": stripped,
            })
            continue

        if level in ("warning", "error", "critical"):
            messages.append({"level": level, "text": stripped})
        elif not _SECTION_DASH_RE.match(stripped):
            current["lines"].append(stripped)

    if current["entries"] or current["lines"]:
        sections.append(current)
    return {"sections": sections, "messages": messages, "raw": text}


def flatten(parsed: dict) -> dict[str, str]:
    """``{"section.key": value}`` lookup helper for the targeted extractors."""
    out: dict[str, str] = {}
    for section in parsed.get("sections", []):
        for entry in section["entries"]:
            out[f"{section['name']}.{entry['key']}".strip(".")] = entry["value"]
            out.setdefault(entry["key"], entry["value"])
    return out


# --------------------------------------------------------------------- hw version
def parse_version(text: str) -> dict:
    parsed = parse_sections(text)
    flat = flatten(parsed)
    result = dict(parsed)
    result["client"] = {
        "version": _first_bare_line(text, "Client"),
        "compiler": flat.get("Compiler"),
        "platform": flat.get("Platform"),
        "readline": flat.get("Readline/Linenoise support"),
        "qt": flat.get("QT GUI support"),
        "bluetooth": flat.get("Native BT support"),
        "python": flat.get("Python script support"),
        "lua": flat.get("Lua script support"),
    }
    # Device-side facts only appear once a Proxmark3 is attached; key names are
    # those the firmware actually prints (client/src/cmdhw.c + armsrc):
    #   [ Model ]  Firmware.... PM3 GENERIC
    #   [ ARM ]    Bootrom....  <version>      OS....  <version>
    #   [ FPGA ]   bare lines, one per bitstream image
    result["firmware"] = {
        "model": flat.get("Model.Firmware") or flat.get("Firmware"),
        "bootrom": flat.get("ARM.Bootrom") or flat.get("Bootrom"),
        "os": flat.get("ARM.OS") or flat.get("OS"),
        "compiler": flat.get("ARM.Compiler"),
        "fpgaImages": next(
            ([entry["raw"] for entry in section["entries"]] + section["lines"]
             for section in parsed["sections"]
             if section["name"].upper() == "FPGA"), []),
    }
    result["firmware"]["present"] = bool(result["firmware"]["os"])
    return result


def _first_bare_line(text: str, after_header: str) -> str | None:
    """Return the first non-key/value line following ``[ header ]``."""
    seen = False
    for line in _lines(text):
        _, body = ansi.classify(line)
        body = body.strip()
        if not body:
            continue
        if match_section(body) is not None and _SECTION_BRACKET_RE.match(body):
            seen = after_header.lower() in body.lower()
            continue
        if seen and not match_kv(body):
            return body
    return None


# ------------------------------------------------------------------------ hw tune
_VOLT_RE = re.compile(r"^(?P<label>[\d.]+\s*(?:kHz|MHz)[^.]*?)\s*\.{2,}\s*(?P<v>[\d.]+)\s*V")
# The client prints the two verdicts in different shapes — "LF antenna...... ok"
# but "HF antenna ( ok )" — so both forms have to be accepted.
_JUDGE_RE = re.compile(
    r"^(?P<band>LF|HF) antenna\s*(?:\.{2,}\s*(?P<dotted>\w+)|\(\s*(?P<paren>\w+)\s*\))",
    re.I)
#: Q-factor figures are printed per band under identical labels.
_QUALITY_KEYS = ("Frequency bandwidth", "Peak voltage")


def parse_tune(text: str) -> dict:
    """Extract antenna measurements from ``hw tune``.

    Produces the LF sweep points, the HF carrier voltage and the client's own
    usable/marginal/unusable verdicts — no thresholds are re-invented here.
    """
    measurements: list[dict] = []
    verdicts: dict[str, str] = {}
    # Keyed by band: both sections print "Peak voltage", so a flat dict would
    # let the HF reading silently overwrite the LF one.
    quality: dict[str, dict[str, float]] = {}
    band = None

    for line in _lines(text):
        _, body = ansi.classify(line)
        body = body.strip()
        if not body:
            continue
        section = match_section(body)
        if section:
            name = section.upper()
            if "LF" in name:
                band = "LF"
            elif "HF" in name:
                band = "HF"
            continue

        judge = _JUDGE_RE.match(body)
        if judge:
            verdict = judge.group("dotted") or judge.group("paren")
            verdicts[judge.group("band").upper()] = verdict.lower()
            continue

        volt = _VOLT_RE.match(body)
        if volt:
            label = volt.group("label").strip()
            freq_match = re.match(r"([\d.]+)\s*(kHz|MHz)", label)
            freq_khz = None
            if freq_match:
                freq_khz = float(freq_match.group(1))
                if freq_match.group(2) == "MHz":
                    freq_khz *= 1000
            measurements.append({
                "band": band or ("HF" if freq_khz and freq_khz > 1000 else "LF"),
                "label": label,
                "freqKHz": freq_khz,
                "volts": float(volt.group("v")),
                "optimal": "optimal" in label.lower(),
            })
            continue

        q = match_kv(body)
        if q and q.group("key").strip() in _QUALITY_KEYS:
            try:
                value = float(q.group("value").split()[0])
            except (ValueError, IndexError):
                continue
            quality.setdefault(band or "LF", {})[q.group("key").strip()] = value

    return {
        "measurements": measurements,
        "verdicts": verdicts,
        "quality": quality,
        "lfPeak": max((m for m in measurements if m["band"] == "LF"),
                      key=lambda m: m["volts"], default=None),
        "hf": next((m for m in measurements if m["band"] == "HF"), None),
        "raw": text,
    }


# ----------------------------------------------------------------- mem spiffs info
_SPIFFS_RE = re.compile(r"(?P<key>[\w \-/]+?)\s*\.{2,}\s*(?P<value>[\d]+)")


def parse_spiffs_info(text: str) -> dict:
    parsed = parse_sections(text)
    flat = flatten(parsed)
    used = total = None
    for key, value in flat.items():
        digits = re.match(r"^(\d+)", value.strip())
        if not digits:
            continue
        number = int(digits.group(1))
        lowered = key.lower()
        if "used" in lowered:
            used = number
        elif "total" in lowered or "size" in lowered:
            total = number
    parsed["used"] = used
    parsed["total"] = total
    parsed["free"] = (total - used) if (total is not None and used is not None) else None
    return parsed


def parse_spiffs_tree(text: str) -> dict:
    """Extract ``name  size`` rows from the SPIFFS tree listing."""
    files = []
    for line in _lines(text):
        _, body = ansi.classify(line)
        body = body.strip()
        match = re.match(r"^(?P<name>[\w\-./]+)\s+(?P<size>\d+)\s*$", body)
        if match:
            files.append({"name": match.group("name"), "size": int(match.group("size"))})
    return {"files": files, "raw": text}


# --------------------------------------------------------------------- prefs show
#: ``prefs show`` label -> the ``prefs set`` sub-command that changes it.
PREF_SETTERS = {
    "emoji": "emoji",
    "hints": "hints",
    "color": "color",
    "client debug": "client.debug",
    "show plot sliders": "plotsliders",
    "barmode": "barmode",
    "cmd execution delay": "client.delay",
    "output": "output",
    "communication timeout": "client.timeout",
    "HF field timeout": "hf.field.timeout_sec",
    "default save path": "savepaths",
    "dump save path": "savepaths",
    "trace save path": "savepaths",
    "MQTT server": "mqtt",
    "MQTT port": "mqtt",
    "MQTT topic": "mqtt",
}


def parse_prefs(text: str) -> dict:
    parsed = parse_sections(text)
    prefs = []
    for section in parsed["sections"]:
        for entry in section["entries"]:
            prefs.append({
                "key": entry["key"],
                "value": entry["value"],
                "setter": PREF_SETTERS.get(entry["key"]),
            })
    parsed["prefs"] = prefs
    return parsed


# -------------------------------------------------------------------- hf/lf search
#: Search results label their fields with a colon rather than dot padding, e.g.
#: "Unique TAG ID      : 2000983C7D" and "  UID: 04 12 34 56".
_COLON_KV_RE = re.compile(r"^(?P<key>[A-Za-z][\w \-/().]{1,40}?)\s*:\s*(?P<value>\S.*)$")

_IDENTIFIER_KEY_RE = re.compile(
    r"\b(uid|tag id|card id|serial|atqa|sak|chipset|type|dez|hex|fc|cn|"
    r"card number|facility|raw|ats)\b", re.I)


def parse_search(text: str) -> dict:
    """Summarise ``hf search`` / ``lf search`` output.

    The client's search output is free-form per protocol, so this collects the
    success lines and any ``UID``-style identifiers verbatim instead of guessing
    at a schema.
    """
    findings: list[dict] = []
    identifiers: list[dict] = []
    for line in _lines(text):
        level, body = ansi.classify(line)
        body = body.strip()
        if not body:
            continue
        kv = match_kv(body) or _COLON_KV_RE.match(body)
        if kv and _IDENTIFIER_KEY_RE.search(kv.group("key")):
            key = kv.group("key").strip()
            value = kv.group("value").strip()
            if value and not any(item["key"] == key for item in identifiers):
                identifiers.append({"key": key, "value": value})
        if level == "success" and body:
            findings.append({"level": level, "text": body})
    found = bool(findings) and not re.search(r"\bno known.*found|valid.*not found", text, re.I)
    return {
        "found": found,
        "findings": findings,
        "identifiers": identifiers,
        "raw": text,
    }


# --------------------------------------------------------------- known failures
#: Failures the client reports as raw text that deserve a real explanation and a
#: remedy in the UI. Matched against the command output, most specific first.
KNOWN_FAILURES = [
    {
        "id": "capabilities-mismatch",
        "match": r"Capabilities structure version sent by Proxmark3 is not the same",
        "title": "Device firmware does not match the client",
        "explanation": (
            "The Proxmark3 answered, but it is running firmware built from a "
            "different source revision than this client. The two disagree on the "
            "command structure, so the client refuses to talk to it rather than "
            "risk misinterpreting replies."
        ),
        "remedy": (
            "Flash the device with firmware built from this same checkout: "
            "install an ARM toolchain (gcc-arm-none-eabi), run `make fullimage "
            "bootrom` in the repository root, then `./pm3-flash-all`. "
            "Alternatively, rebuild the client from the revision your firmware "
            "was built from."
        ),
        "docs": "doc/md/Use_of_Proxmark/0_Compilation-Instructions.md",
    },
    {
        "id": "port-busy",
        "match": r"(Permission denied|Could not open|error opening|failed to open).*(tty|serial|port)",
        "title": "Cannot open the serial port",
        "explanation": (
            "The port exists but could not be opened — usually another program "
            "holds it, or your user is not in the group that owns it."
        ),
        "remedy": (
            "Close any other client using the device. On Linux, add your user to "
            "the dialout (or uucp) group and log back in. Check that "
            "ModemManager is not grabbing the port."
        ),
        "docs": "doc/md/Installation_Instructions/ModemManager-Must-Be-Discarded.md",
    },
    {
        "id": "no-device",
        "match": r"(cannot communicate with the Proxmark3|No Proxmark3 device found|"
                 r"Cannot communicate)",
        "title": "No response from the device",
        "explanation": (
            "The client opened the port but the Proxmark3 did not answer."
        ),
        "remedy": (
            "Unplug and replug the device, then try again. If it stays silent it "
            "may be sitting in the bootloader — a reflash will recover it."
        ),
        "docs": "doc/md/Installation_Instructions/Troubleshooting.md",
    },
]


#: The client's answer when a command needs hardware this build/device lacks —
#: e.g. SPIFFS on a PM3GENERIC board, which has no external flash chip.
_UNSUPPORTED_RE = re.compile(r"not available in this mode", re.I)


#: "[+] Using UART port /dev/ttyACM0" — how the client reports the port it chose.
_UART_PORT_RE = re.compile(r"Using UART port\s+(?P<port>\S+)")


def uart_port(text: str) -> str | None:
    """Recover the serial port the client selected, from its own output."""
    match = _UART_PORT_RE.search(ansi.clean(text or ""))
    return match.group("port") if match else None


def is_unsupported(text: str) -> bool:
    """True when the client refused because the feature is absent on this device."""
    return bool(_UNSUPPORTED_RE.search(ansi.clean(text or "")))


def diagnose(text: str) -> dict | None:
    """Recognise a known client failure and return an explanation and remedy.

    Returns ``None`` when nothing matches, so the UI falls back to showing the
    client's own words rather than inventing a diagnosis.
    """
    cleaned = ansi.clean(text or "")
    for failure in KNOWN_FAILURES:
        if re.search(failure["match"], cleaned, re.I):
            return {k: v for k, v in failure.items() if k != "match"}
    return None


# ------------------------------------------------------------------- graph buffer
def parse_pm3_samples(text: str, limit: int | None = None) -> list[int]:
    """Read a ``.pm3`` graph-buffer file: one signed decimal sample per line."""
    values: list[int] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            values.append(int(float(line)))
        except ValueError:
            continue
        if limit and len(values) >= limit:
            break
    return values


def downsample(values: list[int], target: int) -> dict:
    """Min/max decimate for display, preserving signal extremes.

    Returns the envelope so a 40k-sample trace can be drawn in a few hundred
    points without the peaks vanishing.
    """
    if target <= 0 or len(values) <= target:
        return {"points": values, "envelope": None, "factor": 1}
    factor = len(values) / target
    mins, maxs, mids = [], [], []
    for i in range(target):
        chunk = values[int(i * factor):max(int((i + 1) * factor), int(i * factor) + 1)]
        if not chunk:
            continue
        mins.append(min(chunk))
        maxs.append(max(chunk))
        mids.append(sum(chunk) // len(chunk))
    return {"points": mids, "envelope": {"min": mins, "max": maxs}, "factor": factor}
