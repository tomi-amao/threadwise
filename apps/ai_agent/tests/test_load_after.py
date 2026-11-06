"""A single-endpoint sync a person started loads what it fetched; a full sync's endpoints do not."""

import asyncio
from typing import Any, Dict, List

import pytest

from ai_agent.integrations.inngest import load_after


class FakeStep:
    def __init__(self):
        self.ran: List[str] = []

    async def run(self, name, fn):
        self.ran.append(name)
        result = fn()
        return await result if asyncio.iscoroutine(result) else result


class FakeCtx:
    def __init__(self, data: Dict[str, Any]):
        self.event = type("Event", (), {"data": data})()
        self.step = FakeStep()


class FakeClient:
    def __init__(self):
        self.sent: List[Any] = []

    async def send(self, event):
        self.sent.append(event)
        return ["id"]


@pytest.fixture
def client(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(load_after, "get_client", lambda: fake)
    return fake


def run(data: Dict[str, Any]):
    ctx = FakeCtx(data)
    sent = asyncio.run(
        load_after.load_after_endpoint_sync(ctx, "shopify", "src-1", "orders", 12)
    )
    return sent, ctx


def test_a_sync_a_person_started_loads_when_it_finishes(client):
    sent, ctx = run({"source_id": "src-1", "endpoint": "orders", "load_after": True})

    assert sent is True
    assert ctx.step.ran == ["load-after-endpoint-sync"]
    (event,) = client.sent
    assert event.name == "shopify/sync.completed"
    assert event.data == {
        "source_id": "src-1",
        "total_items": 12,
        "endpoints": ["orders"],
    }


def test_an_endpoint_run_by_a_full_sync_leaves_loading_to_the_full_sync(client):
    # The full sync invokes each endpoint without the mark, and loads once at its end.
    sent, ctx = run({"source_id": "src-1", "endpoint": "orders", "force_full": False})

    assert sent is False
    assert ctx.step.ran == []
    assert client.sent == []
