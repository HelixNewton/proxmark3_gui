"""In-process publish/subscribe bus feeding the WebSocket endpoints.

Two independent streams exist:

``console``
    Raw client output chunks, exactly as the PTY produced them.

``events``
    Structured application events: status transitions, notifications, host and
    device metrics samples, command lifecycle records.

Slow consumers are dropped rather than allowed to stall the producer — a browser
tab that stops reading must never block the PTY pump.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any, Deque

MAX_QUEUE = 512


class Subscription:
    def __init__(self, bus: "EventBus", channel: str) -> None:
        self._bus = bus
        self._channel = channel
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
        self.dropped = 0

    async def __aenter__(self) -> "Subscription":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._bus.unsubscribe(self._channel, self)

    async def get(self) -> Any:
        return await self.queue.get()


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Subscription]] = {}
        #: Recent structured events, replayed to new subscribers for context.
        self.history: Deque[dict] = deque(maxlen=250)
        #: Notification centre backlog (a subset of history, user-facing).
        self.notifications: Deque[dict] = deque(maxlen=100)
        self._seq = 0

    # ---- subscription ----------------------------------------------------
    def subscribe(self, channel: str) -> Subscription:
        sub = Subscription(self, channel)
        self._subs.setdefault(channel, []).append(sub)
        return sub

    def unsubscribe(self, channel: str, sub: Subscription) -> None:
        subs = self._subs.get(channel)
        if subs and sub in subs:
            subs.remove(sub)

    def subscriber_count(self, channel: str) -> int:
        return len(self._subs.get(channel, []))

    # ---- publishing ------------------------------------------------------
    def publish(self, channel: str, payload: Any) -> None:
        for sub in list(self._subs.get(channel, ())):
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                sub.dropped += 1

    def emit(self, event_type: str, **data: Any) -> dict:
        """Publish a structured event on the ``events`` channel."""
        self._seq += 1
        event = {"seq": self._seq, "type": event_type, "ts": time.time(), **data}
        self.history.append(event)
        self.publish("events", event)
        return event

    def notify(self, level: str, title: str, message: str = "", **data: Any) -> dict:
        """Emit a user-facing notification that also lands in the notification centre."""
        event = self.emit(
            "notification", level=level, title=title, message=message, **data
        )
        self.notifications.append(event)
        return event

    def clear_notifications(self) -> None:
        self.notifications.clear()
