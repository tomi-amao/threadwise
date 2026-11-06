"""Hiding an integration: only the page changes; the source stays connected and syncing."""

import asyncio

import pytest
from fastapi import HTTPException

from ai_agent.api.routes import integrations as routes
from ai_agent.core.auth import AuthenticatedUser

ENTITY = "e-1"


class FakeSync:
    def __init__(self, sources):
        self.sources = {s["id"]: dict(s) for s in sources}
        self.client = self

    def table(self, _name):
        raise RuntimeError("no database in this test")

    async def get_external_source(self, source_id):
        return self.sources.get(source_id)

    async def list_external_sources(self, entity_id=None, provider=None):
        return list(self.sources.values())

    async def set_hidden(self, source_id, hidden):
        self.sources[source_id]["hidden_at"] = (
            "2026-11-06T10:00:00+00:00" if hidden else None
        )
        return self.sources[source_id]["hidden_at"]

    async def get_sync_stats(self, source_id):
        return None

    async def get_all_sync_watermarks(self, source_id):
        return None


@pytest.fixture
def fake(monkeypatch):
    sync = FakeSync(
        [
            {
                "id": "src-1",
                "entity_id": ENTITY,
                "provider": "squarespace",
                "external_account_id": "site",
                "sync_status": "completed",
            }
        ]
    )
    monkeypatch.setattr(routes, "sync_service", sync)
    return sync


def hide(hidden: bool, source_id: str = "src-1"):
    request = routes.SetHiddenRequest(hidden=hidden)
    return asyncio.run(routes.set_hidden(source_id, request))


def summary():
    user = AuthenticatedUser(
        user_id="u", email=None, entity_id=ENTITY, access_token="t"
    )
    return asyncio.run(routes.get_integrations_summary(user, entity_id=ENTITY))


def test_hiding_sets_when_and_the_summary_says_so(fake):
    assert hide(True).hidden_at == "2026-11-06T10:00:00+00:00"
    (card,) = summary()
    assert card.hidden_at == "2026-11-06T10:00:00+00:00"
    # Nothing else about the source changes: it is still connected and its sync state stays.
    assert card.sync_status == "completed"


def test_showing_it_again_clears_it(fake):
    hide(True)
    assert hide(False).hidden_at is None
    (card,) = summary()
    assert card.hidden_at is None


def test_an_unknown_source_is_not_found(fake):
    with pytest.raises(HTTPException) as missing:
        hide(True, "src-nope")
    assert missing.value.status_code == 404
