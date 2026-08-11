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
async def test_one_command_at_a_time(session):
    first = asyncio.create_task(session.execute("msleep -t 1500"))
    await asyncio.sleep(0.4)
    with pytest.raises(SessionBusy):
        await session.execute("hw version")
    await first


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
