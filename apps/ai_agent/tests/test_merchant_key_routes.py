"""The Revolut Merchant key: stored as its own source row, shown on the Revolut integration.

The route functions are called directly with the sync service replaced by an in-memory fake,
so these pin down which rows are created, folded into the summary and removed.
"""

import asyncio

import pytest
from fastapi import HTTPException

from ai_agent.api.routes import integrations as routes
from ai_agent.core.auth import AuthenticatedUser

ENTITY = "e-1"


def run(coro):
    return asyncio.run(coro)


class FakeSync:
    """The parts of sync_service the routes use, over a dict of source rows."""

    def __init__(self, sources):
        self.sources = {s["id"]: dict(s) for s in sources}
        self.keys = {}
        self.deleted = []
        self.client = self  # summary counts go through client.table(); they fail softly

    def table(self, _name):
        raise RuntimeError("no database in this test")

    async def get_external_source(self, source_id):
        return self.sources.get(source_id)

    async def list_external_sources(self, entity_id=None, provider=None):
        return list(self.sources.values())

    async def create_external_source(
        self, entity_id, provider, external_account_id, credentials, display_name=None
    ):
        row = {
            "id": f"src-{len(self.sources) + 1}",
            "entity_id": entity_id,
            "provider": provider,
            "external_account_id": external_account_id,
            "display_name": display_name,
            "api_key_status": "pending",
        }
        self.sources[row["id"]] = row
        self.keys[row["id"]] = credentials["api_key"]
        return row

    async def update_api_key(self, source_id, api_key):
        self.keys[source_id] = api_key

    async def update_api_key_status(self, source_id, status, error=None):
        self.sources[source_id].update(api_key_status=status, api_key_error=error)

    async def delete_external_source(self, source_id):
        self.deleted.append(source_id)
        return self.sources.pop(source_id, None)

    async def get_sync_stats(self, source_id):
        return None

    async def get_all_sync_watermarks(self, source_id):
        return None


@pytest.fixture
def world(monkeypatch):
    fake = FakeSync(
        [
            {
                "id": "rev",
                "entity_id": ENTITY,
                "provider": "revolut",
                "external_account_id": "biz-1",
            },
            {
                "id": "shop",
                "entity_id": ENTITY,
                "provider": "shopify",
                "external_account_id": "x.myshopify.com",
            },
        ]
    )
    accepted = {"ok": True}

    async def validate(api_key):
        return (True, None) if accepted["ok"] else (False, "Invalid key")

    async def merchant_for(parent_id):
        return next(
            (
                s
                for s in fake.sources.values()
                if s["provider"] == "revolut_merchant"
                and s["external_account_id"] == parent_id
            ),
            None,
        )

    monkeypatch.setattr(routes, "sync_service", fake)
    monkeypatch.setattr(routes, "_validate_revolut_merchant_api_key", validate)
    monkeypatch.setattr(routes, "merchant_source_for", merchant_for)
    return fake, accepted


def save(source_id, key="sk_live"):
    return run(
        routes.save_merchant_key(source_id, routes.UpdateApiKeyRequest(api_key=key))
    )


class TestSaveMerchantKey:
    def test_the_key_gets_its_own_row_under_the_revolut_integration(self, world):
        fake, _ = world
        result = save("rev")
        child = fake.sources[result.source_id]
        assert child["provider"] == "revolut_merchant"
        assert (
            child["external_account_id"] == "rev"
        )  # the parent's id, unique by design
        assert child["entity_id"] == ENTITY
        assert fake.keys[child["id"]] == "sk_live"
        assert result.status == "valid" and child["api_key_status"] == "valid"

    def test_saving_again_replaces_the_key_rather_than_adding_a_row(self, world):
        fake, _ = world
        first = save("rev", "sk_old")
        second = save("rev", "sk_new")
        assert first.source_id == second.source_id
        assert fake.keys[second.source_id] == "sk_new"
        assert (
            sum(s["provider"] == "revolut_merchant" for s in fake.sources.values()) == 1
        )

    def test_a_rejected_key_is_kept_and_marked_invalid(self, world):
        fake, accepted = world
        accepted["ok"] = False
        result = save("rev")
        assert result.status == "invalid" and result.message == "Invalid key"
        assert fake.sources[result.source_id]["api_key_error"] == "Invalid key"

    def test_only_a_revolut_integration_takes_one(self, world):
        with pytest.raises(HTTPException) as refused:
            save("shop")
        assert refused.value.status_code == 400


class TestSummaryAndRemoval:
    def test_the_merchant_row_shows_on_the_revolut_card_not_as_its_own(self, world):
        fake, _ = world
        child_id = save("rev").source_id
        user = AuthenticatedUser(
            user_id="u", email=None, entity_id=ENTITY, access_token="t"
        )
        cards = run(routes.get_integrations_summary(user, entity_id=ENTITY))
        assert {c.provider for c in cards} == {"revolut", "shopify"}
        revolut = next(c for c in cards if c.provider == "revolut")
        assert revolut.merchant is not None
        assert revolut.merchant.source_id == child_id
        assert revolut.merchant.api_key_status == "valid"
        assert next(c for c in cards if c.provider == "shopify").merchant is None

    def test_removing_the_key_removes_only_its_row(self, world):
        fake, _ = world
        child_id = save("rev").source_id
        run(routes.remove_merchant_key("rev"))
        assert fake.deleted == [child_id] and "rev" in fake.sources

    def test_removing_a_key_that_is_not_there_is_a_404(self, world):
        with pytest.raises(HTTPException) as missing:
            run(routes.remove_merchant_key("rev"))
        assert missing.value.status_code == 404

    def test_removing_the_revolut_integration_takes_its_merchant_row_too(self, world):
        fake, _ = world
        child_id = save("rev").source_id
        run(routes.delete_external_source("rev"))
        assert fake.deleted == [child_id, "rev"]
