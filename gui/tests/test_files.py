"""Containment tests for the file browser.

These are the tests that matter most in this package: the endpoints they cover
read arbitrary paths on behalf of a browser, so escaping a root must be
impossible by any route — traversal, absolute paths or a planted symlink.
"""

import os
import pytest

from gui.server import files, scripts


@pytest.fixture()
def roots(tmp_path):
    allowed = tmp_path / "allowed"
    (allowed / "nested").mkdir(parents=True)
    (allowed / "trace.pm3").write_text("-1\n0\n1\n")
    (allowed / "nested" / "deep.txt").write_text("deep")

    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "keys.txt").write_text("do-not-read")

    return {"allowed": allowed, "_secret": secret}


class TestResolve:
    def test_plain_relative_path(self, roots):
        resolved = files.resolve_in_root(roots, "allowed", "trace.pm3")
        assert resolved.relative == "trace.pm3"

    @pytest.mark.parametrize("attempt", [
        "../secret/keys.txt",
        "../../etc/passwd",
        "nested/../../secret/keys.txt",
        "nested/../../../etc/passwd",
    ])
    def test_traversal_is_refused(self, roots, attempt):
        with pytest.raises(files.PathDenied):
            files.resolve_in_root(roots, "allowed", attempt)

    def test_traversal_that_lands_back_inside_the_root_is_harmless(self, roots):
        # Leading slashes are stripped, so this can only ever name something
        # under the root — it resolves inside and is simply not found.
        resolved = files.resolve_in_root(roots, "allowed", "/etc/passwd/../../trace.pm3")
        assert resolved.path == (roots["allowed"] / "trace.pm3").resolve()

    def test_absolute_paths_are_reanchored_inside_the_root(self, roots):
        # A leading slash is stripped, so this can only ever name a file that
        # really is inside the root.
        resolved = files.resolve_in_root(roots, "allowed", "/trace.pm3")
        assert resolved.path == (roots["allowed"] / "trace.pm3").resolve()

    def test_symlink_out_of_the_root_is_refused(self, roots, tmp_path):
        link = roots["allowed"] / "escape"
        os.symlink(roots["_secret"], link)
        with pytest.raises(files.PathDenied):
            files.resolve_in_root(roots, "allowed", "escape/keys.txt")

    def test_unknown_root(self, roots):
        with pytest.raises(files.PathDenied):
            files.resolve_in_root(roots, "nope", "")

    def test_null_byte(self, roots):
        with pytest.raises(files.PathDenied):
            files.resolve_in_root(roots, "allowed", "trace\x00.pm3")


class TestListing:
    def test_lists_and_classifies(self, roots):
        listing = files.list_directory(roots, "allowed", "")
        names = {entry["name"]: entry for entry in listing["entries"]}
        assert names["nested"]["isDir"] is True
        assert names["trace.pm3"]["kind"] == "trace"

    def test_filters_by_query(self, roots):
        listing = files.list_directory(roots, "allowed", "", query="trace")
        assert [entry["name"] for entry in listing["entries"]] == ["trace.pm3"]

    def test_missing_directory_reports_not_found(self, roots):
        with pytest.raises(FileNotFoundError):
            files.list_directory(roots, "allowed", "does-not-exist")


class TestRead:
    def test_text_file(self, roots):
        payload = files.read_file(roots, "allowed", "trace.pm3")
        assert payload["isText"] is True
        assert payload["text"].startswith("-1")

    def test_binary_file_falls_back_to_hex(self, roots):
        blob = roots["allowed"] / "dump.bin"
        blob.write_bytes(bytes(range(256)))
        payload = files.read_file(roots, "allowed", "dump.bin")
        assert payload["isText"] is False
        assert payload["hex"].startswith("000102")

    def test_truncation_is_reported(self, roots):
        big = roots["allowed"] / "big.txt"
        big.write_text("x" * 5000)
        payload = files.read_file(roots, "allowed", "big.txt", max_bytes=1000)
        assert payload["truncated"] is True
        assert len(payload["text"]) == 1000

    def test_directory_is_not_readable_as_a_file(self, roots):
        with pytest.raises(FileNotFoundError):
            files.read_file(roots, "allowed", "nested")


class TestDelete:
    def test_deletes_inside_the_root(self, roots):
        target = roots["allowed"] / "gone.txt"
        target.write_text("bye")
        files.delete_file(roots, "allowed", "gone.txt")
        assert not target.exists()

    def test_will_not_delete_a_directory(self, roots):
        with pytest.raises(FileNotFoundError):
            files.delete_file(roots, "allowed", "nested")


class TestScriptValidation:
    @pytest.mark.parametrize("name", ["hf_read", "pm3_eml2mfd", "a-b.c"])
    def test_accepts_real_script_names(self, name):
        assert scripts.validate_script_name(name) == name

    @pytest.mark.parametrize("name", [
        "../../etc/passwd", "hf read", "a;hw reset", "-rf", "", "a/b",
    ])
    def test_rejects_anything_else(self, name):
        with pytest.raises(ValueError):
            scripts.validate_script_name(name)

    @pytest.mark.parametrize("args", ["", "-k FFFFFFFFFFFF", "--file a/b.dic", "-n 4,5"])
    def test_accepts_ordinary_arguments(self, args):
        assert scripts.validate_script_args(args) == args.strip()

    @pytest.mark.parametrize("args", ["$(id)", "a; rm -rf /", "`whoami`", "a && b", "a|b"])
    def test_rejects_shell_metacharacters(self, args):
        with pytest.raises(ValueError):
            scripts.validate_script_args(args)


class TestWritableRoots:
    """Deletion must be confined to the user's own ~/.proxmark3 tree."""

    def test_repo_directories_are_never_writable(self, tmp_path, monkeypatch):
        from gui.server import config as config_module

        home = tmp_path / "home"
        (home / ".proxmark3" / "dumps").mkdir(parents=True)
        monkeypatch.setattr(config_module, "user_dir", lambda: home / ".proxmark3")
        monkeypatch.setattr(config_module.os.path, "expanduser", lambda _p: str(home))

        cfg = config_module.AppConfig(autostart=False)
        writable = cfg.writable_roots()
        for name, path in cfg.roots.items():
            inside_user = str(path).startswith(str((home / ".proxmark3").resolve()))
            assert (name in writable) is inside_user, f"{name} -> {path}"

    def test_traces_falls_back_to_the_readonly_repo_copy(self, tmp_path, monkeypatch):
        from gui.server import config as config_module

        home = tmp_path / "home"
        (home / ".proxmark3").mkdir(parents=True)  # no traces/ inside
        monkeypatch.setattr(config_module, "user_dir", lambda: home / ".proxmark3")
        monkeypatch.setattr(config_module.os.path, "expanduser", lambda _p: str(home))

        cfg = config_module.AppConfig(autostart=False)
        if "traces" not in cfg.roots:
            pytest.skip("repository has no traces directory")
        assert cfg.roots["traces"] == (config_module.REPO_ROOT / "traces").resolve()
        assert "traces" not in cfg.writable_roots()

    def test_duplicate_roots_are_collapsed(self, tmp_path, monkeypatch):
        from gui.server import config as config_module

        home = tmp_path / "home"
        (home / ".proxmark3").mkdir(parents=True)
        monkeypatch.setattr(config_module, "user_dir", lambda: home / ".proxmark3")
        monkeypatch.setattr(config_module.os.path, "expanduser", lambda _p: str(home))

        roots = config_module.AppConfig(autostart=False).roots
        assert len(set(roots.values())) == len(roots)
