"""Command catalogue and log reader tests."""

import json
import pytest

from gui.server import logs
from gui.server.catalog import CommandCatalog
from gui.server.config import AppConfig


@pytest.fixture(scope="module")
def catalog():
    return CommandCatalog.load(AppConfig().commands_json)


class TestCatalog:
    def test_loads_the_generated_catalogue(self, catalog):
        assert catalog.error is None
        assert len(catalog.commands) > 800, "doc/commands.json should hold the full command set"

    def test_groups_match_the_client_top_level_commands(self, catalog):
        groups = catalog.groups
        for expected in ("hf", "lf", "hw", "data", "mem", "prefs", "script", "trace"):
            assert expected in groups

    def test_prefix_matches_rank_above_description_matches(self, catalog):
        results = catalog.search("hw tune")
        assert results[0]["name"] == "hw tune"
        assert results[0]["offline"] is False

    def test_offline_filter(self, catalog):
        results = catalog.search("data", limit=200, offline_only=True)
        assert results and all(command["offline"] for command in results)

    def test_completion_returns_prefixed_commands(self, catalog):
        suggestions = catalog.complete("hw t")
        assert "hw tune" in suggestions
        assert all(name.startswith("hw t") for name in suggestions)

    def test_option_flags_are_split_from_their_help(self, catalog):
        options = catalog.option_flags("data load")
        flags = {option["flags"] for option in options}
        assert "-h, --help" in flags
        assert any("--file" in flag for flag in flags)

    def test_unknown_command(self, catalog):
        assert catalog.get("definitely not a command") is None

    def test_missing_file_reports_an_error_rather_than_raising(self, tmp_path):
        broken = CommandCatalog.load(tmp_path / "absent.json")
        assert broken.error is not None
        assert broken.commands == {}


class TestLogs:
    def test_parses_severity_and_timestamp(self):
        entry = logs.parse_line("12:04:55 [+] Saved to json file /home/x/.proxmark3/x.json", 1)
        assert entry["time"] == "12:04:55"
        assert entry["level"] == "success"
        assert entry["message"].startswith("Saved to json file")

    def test_lines_without_a_prefix_are_normal(self):
        assert logs.parse_line("  Compiler.... GCC", 0)["level"] == "normal"

    def test_reads_and_filters_a_log_file(self, tmp_path):
        path = tmp_path / "log_20260811090000.txt"
        path.write_text(
            "[=] info one\n[!] warning here\n[-] error there\n[+] fine\n")
        everything = logs.read_log(path)
        assert everything["total"] == 4
        assert everything["counts"]["warning"] == 1

        problems = logs.read_log(path, level="problems")
        assert [entry["level"] for entry in problems["entries"]] == ["warning", "error"]

        searched = logs.read_log(path, query="there")
        assert len(searched["entries"]) == 1

    def test_lists_newest_log_first(self, tmp_path):
        (tmp_path / "log_1.txt").write_text("a")
        (tmp_path / "log_2.txt").write_text("b")
        import os, time
        os.utime(tmp_path / "log_2.txt", (time.time() + 10, time.time() + 10))
        assert logs.newest_log(tmp_path).name == "log_2.txt"

    def test_missing_log_directory(self, tmp_path):
        assert logs.list_log_files(tmp_path / "nope") == []
        assert logs.newest_log(tmp_path / "nope") is None
