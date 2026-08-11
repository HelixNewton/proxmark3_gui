"""Integration tests against the real proxmark3 client binary.

These run the actual client in offline mode over a PTY — no device required.
They are skipped with a clear reason when the client has not been built.

No pytest-asyncio dependency: ``@with_session`` wraps each async body in
``asyncio.run`` and guarantees the client process is torn down afterwards.
"""

import asyncio
import pytest

from gui.server.config import AppConfig, find_client_binary
from gui.server.events import EventBus
from gui.server.session import PM3Session, SessionBusy, SessionNotRunning, OFFLINE

pytestmark = pytest.mark.skipif(
    find_client_binary() is None,
    reason="proxmark3 client not built — run `make client` in the repository root",
)


def with_session(async_test):
    """Run an async test body against a freshly started offline client."""
    def wrapper(*args, **kwargs):
        async def main():
            config = AppConfig(autostart=False, incognito=True)
            session = PM3Session(config, EventBus())
            await session.start("")  # empty port == offline mode
            try:
                await async_test(session, *args, **kwargs)
            finally:
                await session.aclose()
        asyncio.run(main())

    # Copy the name/doc but deliberately not the signature: pytest would
    # otherwise see the `session` parameter and demand a fixture for it.
    wrapper.__name__ = async_test.__name__
    wrapper.__doc__ = async_test.__doc__
    return wrapper


@with_session
async def test_reaches_an_offline_prompt(session):
    assert session.running
    assert session.status == OFFLINE
    assert session.prompt.endswith("pm3 --> ")
    assert session.state()["connected"] is False


@with_session
async def test_captures_command_output(session):
    result = await session.execute("hw version")
    assert "Compiler" in result.output
    # The PTY echo of the command must not leak into the captured output...
    assert not result.output.startswith("hw version")
    # ...nor may the trailing prompt.
    assert "pm3 -->" not in result.output
    assert result.duration > 0
    assert result.ok is True


@with_session
async def test_offline_commands_report_their_own_failure(session):
    result = await session.execute("hw status")
    assert "not available" in result.output.lower()
    assert result.level in ("warning", "error", "critical")


@with_session
async def test_graph_buffer_roundtrip(session):
    """`data load` then `data save` — the path the Signal page depends on."""
    import tempfile
    from pathlib import Path

    traces = AppConfig().roots.get("traces")
    if traces is None:
        pytest.skip("repository traces directory not present")
    source = traces / "lf_EM4102-fob.pm3"
    if not source.exists():
        pytest.skip("sample trace not present")

    loaded = await session.execute(f"data load -f {source}", timeout=60)
    assert "loaded" in loaded.output.lower()

    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / "roundtrip"
        saved = await session.execute(f"data save -f {target}", timeout=60)
        assert "saved" in saved.output.lower()
        written = target.with_suffix(".pm3")
        assert written.exists()
        samples = written.read_text().splitlines()
        assert len(samples) > 1000
        assert all(line.lstrip("-").isdigit() for line in samples[:50])


@with_session
async def test_rejects_multi_line_commands(session):
    with pytest.raises(ValueError):
        await session.execute("hw version\nquit")


@with_session
async def test_commands_are_serialised(session):
    """The client is single-threaded, so a second command waits its turn."""
    first = asyncio.create_task(session.execute("msleep -t 1500"))
    await asyncio.sleep(0.4)
    second = await session.execute("hw version", timeout=30)
    await first
    # The second command waited rather than being rejected, and captured only
    # its own output.
    assert "Compiler" in second.output
    assert "msleep" not in second.output


@with_session
async def test_timeout_reports_itself_and_the_session_survives(session):
    # Generous margin between the sleep and the timeout so a loaded machine
    # cannot make this flap.
    result = await session.execute("msleep -t 4000", timeout=0.5)
    assert result.timed_out is True
    assert result.ok is False
    # The abort is Enter, which the client accepts without dying — ^C would
    # terminate it (see PM3Session.interrupt).
    assert session.running
    follow_up = await session.execute("hw version", timeout=30)
    assert "Compiler" in follow_up.output


@with_session
async def test_console_stream_carries_the_same_output(session):
    subscription = session.bus.subscribe("console")
    await session.execute("hw version")
    chunks = []
    while not subscription.queue.empty():
        chunks.append(subscription.queue.get_nowait())
    subscription.close()
    assert "Compiler" in "".join(chunks)


@with_session
async def test_stop_then_start_again(session):
    await session.stop()
    assert not session.running
    with pytest.raises(SessionNotRunning):
        await session.execute("hw version")
    await session.start("")
    assert session.running
    assert (await session.execute("hw version")).ok


@with_session
async def test_concurrent_commands_queue_instead_of_failing(session):
    """Two panels loading at once must not make one of them error."""
    results = await asyncio.gather(
        session.execute("hw version"),
        session.execute("prefs show"),
    )
    assert all(r.output for r in results)
    # They ran one after the other, and neither captured the other's output.
    assert "Compiler" in results[0].output
    assert "hints" in results[1].output.lower()
    assert "Compiler" not in results[1].output


@with_session
async def test_busy_is_still_reported_when_the_wait_is_hopeless(session):
    long_running = asyncio.create_task(session.execute("msleep -t 4000", timeout=30))
    await asyncio.sleep(0.4)
    with pytest.raises(SessionBusy):
        await session.execute("hw version", queue_timeout=0.5)
    await long_running


def test_port_disappearance_is_reported(tmp_path):
    """An unplugged device must not leave the status pill reading ONLINE."""
    import asyncio as aio
    from gui.server import session as session_module

    async def main():
        # A fake port node that we delete mid-session, standing in for a device
        # being pulled out. The client itself runs offline; only the watchdog
        # is under test.
        fake_port = tmp_path / "ttyFAKE"
        fake_port.write_text("")

        config = AppConfig(autostart=False, incognito=True)
        live = PM3Session(config, EventBus())
        await live.start("")
        watcher = None
        try:
            live.port = str(fake_port)
            live._ensure_watchdog()
            watcher = live._watchdog

            assert live.status != session_module.ERROR
            fake_port.unlink()
            await _until(lambda: live.status == session_module.ERROR, timeout=15)

            assert "no longer exists" in live.status_detail
            assert live.state()["connected"] is False
            assert live.last_error and "Device removed" in live.last_error

            # The watcher keeps running: the client reconnects on its own, so a
            # one-shot watcher would miss every unplug after the first.
            assert not watcher.done()
            fake_port.write_text("")
            await _until(lambda: live.last_error is None, timeout=15)
            assert not watcher.done()
        finally:
            if watcher:
                watcher.cancel()
            await live.aclose()

    aio.run(main())


async def _until(predicate, timeout=10.0, interval=0.2):
    """Poll until `predicate()` holds, so tests do not hard-code timings."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("condition not met within timeout")


@with_session
async def test_attach_port_rearms_a_finished_watchdog(session, tmp_path=None):
    """A second unplug must be detected as reliably as the first."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as directory:
        port = Path(directory) / "ttyFAKE"
        port.write_text("")

        session.attach_port(str(port))
        first = session._watchdog
        assert first is not None and not first.done()

        first.cancel()
        await _until(lambda: first.done(), timeout=5)

        # Re-attaching the *same* port must still start a new watcher — the old
        # guard returned early when the port was unchanged and left none running.
        session.attach_port(str(port))
        assert session._watchdog is not first
        assert not session._watchdog.done()
        session._watchdog.cancel()


@with_session
async def test_attach_port_clears_a_stale_disconnect_error(session):
    session.last_error = "Device removed — /dev/ttyACM0 no longer exists"
    session.attach_port("/dev/ttyACM0")
    try:
        assert session.last_error is None
    finally:
        if session._watchdog:
            session._watchdog.cancel()


@with_session
async def test_a_command_after_an_abort_still_captures_its_output(session):
    """Regression: the abort keystroke produces an extra prompt.

    That prompt arrives after the timed-out command has returned. Left
    unconsumed, it satisfies the *next* command's wait immediately and that
    command reports empty output despite having run.
    """
    timed_out = await session.execute("msleep -t 4000", timeout=0.5)
    assert timed_out.timed_out is True

    for _ in range(3):
        result = await session.execute("hw version", timeout=30)
        assert "Compiler" in result.output, "a stray prompt truncated the capture"
        assert result.duration > 0.01
