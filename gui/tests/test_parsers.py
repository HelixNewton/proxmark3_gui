"""Parser tests using real client output captured from the binary in this repo."""

import pytest

from gui.server import ansi, parsers

HW_VERSION = """
 [ Proxmark3 ]

 [ Client ]
  Iceman/master/da509461b-suspect 2026-08-11 12:49:21 567cf9c5f
  Compiler.................. GCC 15.3.0
  Platform.................. Linux / x86_64
  Readline/Linenoise support.absent
  QT GUI support............ present
  Native BT support......... absent
  Python script support..... present ( 3.13.14 )
  Lua script support........ present ( 5.4.7 )
"""

PREFS_SHOW = """[=] Using /home/x/.proxmark3/preferences.json
[=] Current settings
[=]     emoji................... alttext
[=]     hints................... on
[=]     color................... off
[=]     default save path....... /home/x
[=]     client debug............ off
[=]     communication timeout... 0 ms
"""

# Shape taken from client/src/cmdhw.c CmdTune().
HW_TUNE = """
[=] -------- LF Antenna ----------
[+] 125.00 kHz ........... 22.44 V
[+] 134.83 kHz ........... 18.20 V
[+] 125.00 kHz optimal.... 23.10 V
[+]
[+] Approx. Q factor measurement
[+] Frequency bandwidth... 8.4
[+] Peak voltage.......... 6.1
[+] LF antenna............ ok
[=] -------- HF Antenna ----------
[+] 13.56 MHz............. 45.02 V
[+] HF antenna............ ok
"""


class TestAnsi:
    def test_strips_sgr_and_osc_hyperlinks(self):
        raw = "\x1b[32m[+]\x1b[0m \x1b]8;;https://example\x1b\\Proxmark3\x1b]8;;\x1b\\ ok"
        assert ansi.clean(raw) == "[+] Proxmark3 ok"

    def test_pty_crlf_is_not_treated_as_an_inplace_rewrite(self):
        # A PTY turns every \n into \r\n; naive \r handling erases every line.
        assert ansi.clean("first\r\nsecond\r\n") == "first\nsecond\n"

    def test_bare_carriage_return_keeps_the_final_redraw(self):
        assert ansi.clean("  3\r  2\r  1") == "  1"

    @pytest.mark.parametrize("line,level", [
        ("[!!] fatal", "critical"),
        ("[-] failed", "error"),
        ("[!] careful", "warning"),
        ("[+] found", "success"),
        ("[=] note", "info"),
        ("[#] device chatter", "debug"),
        ("[?] hint", "hint"),
        ("plain table row", "normal"),
    ])
    def test_severity_prefixes(self, line, level):
        assert ansi.classify(line)[0] == level


class TestKeyValue:
    def test_dotted_leader(self):
        match = parsers.match_kv("Compiler.................. GCC 15.3.0")
        assert match.group("key").strip() == "Compiler"
        assert match.group("value") == "GCC 15.3.0"

    def test_single_dot_when_the_label_fills_the_padding(self):
        match = parsers.match_kv("Readline/Linenoise support.absent")
        assert match.group("key") == "Readline/Linenoise support"
        assert match.group("value") == "absent"

    def test_decimal_values_are_not_split_at_the_dot(self):
        assert parsers.match_kv("Frequency 125.00 kHz") is None


class TestVersion:
    def test_extracts_client_facts(self):
        parsed = parsers.parse_version(HW_VERSION)
        client = parsed["client"]
        assert client["compiler"] == "GCC 15.3.0"
        assert client["platform"] == "Linux / x86_64"
        assert client["readline"] == "absent"
        assert client["python"] == "present ( 3.13.14 )"
        assert "Iceman/master" in client["version"]

    def test_keeps_raw_output(self):
        assert parsers.parse_version(HW_VERSION)["raw"] == HW_VERSION


class TestPrefs:
    def test_reads_every_setting(self):
        prefs = {p["key"]: p["value"] for p in parsers.parse_prefs(PREFS_SHOW)["prefs"]}
        assert prefs["emoji"] == "alttext"
        assert prefs["hints"] == "on"
        assert prefs["color"] == "off"
        assert prefs["communication timeout"] == "0 ms"

    def test_maps_editable_settings_to_their_setter(self):
        by_key = {p["key"]: p for p in parsers.parse_prefs(PREFS_SHOW)["prefs"]}
        assert by_key["client debug"]["setter"] == "client.debug"
        assert by_key["default save path"]["setter"] == "savepaths"


class TestTune:
    def test_reads_both_bands(self):
        tune = parsers.parse_tune(HW_TUNE)
        lf = [m for m in tune["measurements"] if m["band"] == "LF"]
        assert len(lf) == 3
        assert tune["lfPeak"]["volts"] == 23.10
        assert tune["hf"]["volts"] == 45.02
        assert tune["hf"]["freqKHz"] == 13560.0

    def test_reads_the_clients_own_verdicts(self):
        tune = parsers.parse_tune(HW_TUNE)
        assert tune["verdicts"] == {"LF": "ok", "HF": "ok"}

    def test_reads_quality_figures(self):
        tune = parsers.parse_tune(HW_TUNE)
        assert tune["quality"]["LF"]["Frequency bandwidth"] == 8.4

    def test_empty_output_does_not_raise(self):
        tune = parsers.parse_tune("")
        assert tune["measurements"] == []
        assert tune["lfPeak"] is None


class TestSearch:
    def test_collects_findings_and_identifiers(self):
        output = (
            "[=] Checking for known tags...\n"
            "[+] EM 410x ID 0400193CBE\n"
            "[+] Unique TAG ID      : 2000983C7D\n"
            "[+] Valid EM410x ID found!\n"
        )
        parsed = parsers.parse_search(output)
        assert parsed["found"] is True
        assert any("Unique TAG ID" in item["key"] for item in parsed["identifiers"])

    def test_no_tag_found_is_reported_honestly(self):
        parsed = parsers.parse_search("[-] No known 125/134 kHz tags found!\n")
        assert parsed["found"] is False


class TestSamples:
    def test_reads_signed_decimals(self):
        assert parsers.parse_pm3_samples("-3\n0\n127\n\nbogus\n-128\n") == [-3, 0, 127, -128]

    def test_downsample_preserves_extremes_in_the_envelope(self):
        values = [(-100 if i % 2 else 100) for i in range(1000)]
        reduced = parsers.downsample(values, 50)
        assert len(reduced["points"]) == 50
        assert max(reduced["envelope"]["max"]) == 100
        assert min(reduced["envelope"]["min"]) == -100

    def test_short_series_is_returned_untouched(self):
        reduced = parsers.downsample([1, 2, 3], 100)
        assert reduced["points"] == [1, 2, 3]
        assert reduced["envelope"] is None


class TestSpiffs:
    def test_tree_rows(self):
        tree = parsers.parse_spiffs_tree(
            "[=] .....\n"
            "[=] hf_mf_dict.dic   4096\n"
            "[=] lf_t55xx.dic   512\n"
        )
        assert tree["files"] == [
            {"name": "hf_mf_dict.dic", "size": 4096},
            {"name": "lf_t55xx.dic", "size": 512},
        ]


class TestDiagnose:
    """Known client failures must get a real explanation, unknown ones none."""

    def test_recognises_the_firmware_mismatch(self):
        output = (
            "[+] Using UART port /dev/ttyACM0\n"
            "[!!] Capabilities structure version sent by Proxmark3 is not the same "
            "as the one used by the client!\n"
            "[!!] Please flash the Proxmark3 with the same version as the client.\n"
            "[!!] ERROR: cannot communicate with the Proxmark3\n"
        )
        diagnosis = parsers.diagnose(output)
        assert diagnosis["id"] == "capabilities-mismatch"
        assert "firmware" in diagnosis["title"].lower()
        assert "pm3-flash-all" in diagnosis["remedy"]
        assert "match" not in diagnosis  # the regex is internal

    def test_recognises_a_permission_problem(self):
        assert parsers.diagnose(
            "[!!] Permission denied opening serial port /dev/ttyACM0"
        )["id"] == "port-busy"

    def test_a_bare_no_response_falls_to_the_generic_device_case(self):
        assert parsers.diagnose(
            "[!!] ERROR: cannot communicate with the Proxmark3"
        )["id"] == "no-device"

    def test_unknown_output_gets_no_invented_diagnosis(self):
        assert parsers.diagnose("[+] Using UART port /dev/ttyACM0") is None
        assert parsers.diagnose("") is None


# Captured from a real PM3 Easy running firmware built from this checkout.
# Everything below only became observable once a device was attached.
HW_VERSION_DEVICE = """
 [ Proxmark3 ]

 [ Client ]
  Iceman/master/da509461b-dirty-suspect 2026-08-11 15:23:25 567cf9c5f
  Compiler.................. GCC 15.3.0
  Platform.................. Linux / x86_64

 [ Model ]
  Firmware.................. PM3 GENERIC

 [ ARM ]
  Bootrom.... Iceman/master/da509461b-dirty-suspect 2026-08-11 15:22:59 567cf9c5f
  OS......... Iceman/master/da509461b-dirty-suspect 2026-08-11 15:23:05 567cf9c5f
  Compiler... GCC 15.3.1 20260627

 [ FPGA ]
 fpga_pm3_hf.ncd image 2s30vq100 11-08-2026 12:43:03
 fpga_pm3_lf.ncd image 2s30vq100 11-08-2026 12:43:03
"""

HW_STATUS_DEVICE = """[#] Memory
[#]   BigBuf_size............. 38392
[#]   Available memory........ 38132
[#] ---------------------------+-----+-----+-----+-----+-----+-----+------
[#]  [a] Anticol override..... std    ( follow standard )
[#]  [b] BCC override......... std    ( follow standard )
"""


class TestDeviceSideVersion:
    def test_reads_firmware_facts(self):
        firmware = parsers.parse_version(HW_VERSION_DEVICE)["firmware"]
        assert firmware["model"] == "PM3 GENERIC"
        assert firmware["os"].startswith("Iceman/master/da509461b")
        assert firmware["bootrom"].startswith("Iceman/master/da509461b")
        assert firmware["compiler"] == "GCC 15.3.1 20260627"
        assert firmware["present"] is True

    def test_fpga_bitstreams_are_kept_even_though_they_are_not_key_values(self):
        firmware = parsers.parse_version(HW_VERSION_DEVICE)["firmware"]
        assert len(firmware["fpgaImages"]) == 2
        assert all("2s30vq100" in line for line in firmware["fpgaImages"])

    def test_offline_output_reports_no_firmware(self):
        assert parsers.parse_version(HW_VERSION)["firmware"]["present"] is False


class TestSectionHeaderGuard:
    def test_a_table_rule_is_not_a_section_heading(self):
        # `hw status` draws this; the dash pattern used to capture its middle.
        assert parsers.match_section(
            "---------------------------+-----+-----+-----+-----+-----+------") is None
        assert parsers.match_section("-------- LF Antenna ----------") == "LF Antenna"
        assert parsers.match_section("[ Client ]") == "Client"

    def test_status_sections_are_not_polluted_by_rules(self):
        names = [s["name"] for s in parsers.parse_sections(HW_STATUS_DEVICE)["sections"]]
        assert not any(set(n) <= set("+- ") for n in names if n), names


# Verbatim `hw tune` output from a real PM3 Easy. Note the two verdict shapes
# and that both bands print "Peak voltage".
HW_TUNE_DEVICE = """[=] -------- Reminder ----------------------------
[=] `hw tune` doesn't actively tune your antennas.
[=] Measuring antenna characteristics...

[=] -------- LF Antenna ----------
[+] 125.00 kHz ...........  8.76 V
[+] 134.83 kHz ........... 10.54 V
[+] 153.85 kHz optimal.... 14.37 V
[+]
[+] Approx. Q factor measurement
[+] Frequency bandwidth... 3.5
[+] Peak voltage.......... 4.2
[+] LF antenna............ ok

[=] -------- HF Antenna ----------
[+] 13.56 MHz............. 32.28 V
[+]
[+] Approx. Q factor measurement
[+] Peak voltage.......... 9.4
[+] HF antenna ( ok )

[=] -------- LF tuning graph ------------
[+] Orange line - divisor 95 / 125.00 kHz
"""


class TestTuneFromRealDevice:
    def test_reads_the_lf_sweep_and_hf_carrier(self):
        tune = parsers.parse_tune(HW_TUNE_DEVICE)
        assert [m["volts"] for m in tune["measurements"]] == [8.76, 10.54, 14.37, 32.28]
        assert tune["lfPeak"]["freqKHz"] == 153.85
        assert tune["lfPeak"]["optimal"] is True
        assert tune["hf"]["volts"] == 32.28

    def test_both_verdict_shapes_are_understood(self):
        # LF uses dot padding, HF uses parentheses.
        assert parsers.parse_tune(HW_TUNE_DEVICE)["verdicts"] == {"LF": "ok", "HF": "ok"}

    def test_q_factor_is_kept_per_band(self):
        quality = parsers.parse_tune(HW_TUNE_DEVICE)["quality"]
        assert quality["LF"] == {"Frequency bandwidth": 3.5, "Peak voltage": 4.2}
        assert quality["HF"] == {"Peak voltage": 9.4}

    def test_the_tuning_graph_footer_is_not_read_as_a_measurement(self):
        tune = parsers.parse_tune(HW_TUNE_DEVICE)
        assert all(m["label"][0].isdigit() for m in tune["measurements"])
