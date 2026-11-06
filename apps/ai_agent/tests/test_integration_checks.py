"""The daily integration check: what it notifies about, what it clears, and what it leaves."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest

from ai_agent.integrations.inngest import notification_functions
from ai_agent.integrations.inngest.functions import FUNCTIONS
from ai_agent.services import source_access
from ai_agent.services.integration_checks import (
    JOURNALS,
    IntegrationChecks,
    access_key,
    is_stale,
    journals_title,
    stale_key,
)

ENTITY = "11111111-1111-1111-1111-111111111111"
NOW = datetime(2026, 11, 6, 6, 0, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


class FakeSync:
    def __init__(self, sources: List[Dict[str, Any]]):
        self.sources = sources
        self.statuses: Dict[str, Tuple[str, Optional[str]]] = {}

    async def list_external_sources(self, entity_id=None, provider=None):
        return [s for s in self.sources if entity_id in (None, s["entity_id"])]

    async def get_api_key(self, source_id):
        return f"key-{source_id}"

    async def update_api_key_status(self, source_id, status, error=None):
        self.statuses[source_id] = (status, error)


class FakeJournals:
    def __init__(self, count: int = 0):
        self.count = count

    async def count_awaiting_journals(self, entity_id):
        return self.count


class FakeNotifications:
    """Open notifications by key, like the table's one-open-per-key rule."""

    def __init__(self):
        self.open: Dict[str, Dict[str, Any]] = {}
        self.resolved: List[str] = []

    async def notify(self, entity_id, kind, key, title, body=None, link=None):
        self.open[key] = {"kind": kind, "title": title, "body": body, "link": link}

    async def resolve(self, entity_id, key):
        if key in self.open:
            del self.open[key]
            self.resolved.append(key)
            return True
        return False


def source(id: str, provider: str, synced_days_ago: Optional[float] = 1, **extra):
    return {
        "id": id,
        "entity_id": ENTITY,
        "provider": provider,
        "external_account_id": extra.pop("external_account_id", f"acct-{id}"),
        "last_synced_at": None if synced_days_ago is None else ago(synced_days_ago),
        **extra,
    }


def world(sources, answers: Dict[str, Tuple[Optional[bool], Optional[str]]], count=0):
    """Checks wired to fakes. `answers` is what each source's provider says."""
    sync, journals, notes = FakeSync(sources), FakeJournals(count), FakeNotifications()

    async def check(src, api_key):
        assert api_key == f"key-{src['id']}"
        return answers.get(src["id"], (True, None))

    return IntegrationChecks(sync, journals, notes, check), sync, journals, notes


class TestAccess:
    def test_a_refused_key_opens_a_notification_linking_to_its_app(self):
        checks, sync, _, notes = world(
            [source("shop", "shopify")], {"shop": (False, "Invalid client_id")}
        )
        run(checks.check_entity(ENTITY, NOW))
        note = notes.open[access_key("shop")]
        assert note["title"] == "Shopify access stopped working"
        assert "Invalid client_id" in note["body"]
        assert note["link"] == "/integrations?app=shop"
        assert sync.statuses["shop"] == ("invalid", "Invalid client_id")

    def test_a_working_key_resolves_it(self):
        checks, sync, _, notes = world(
            [source("shop", "shopify")], {"shop": (False, "no")}
        )
        run(checks.check_entity(ENTITY, NOW))
        checks.check = lambda src, key: _answer(True, None)
        run(checks.check_entity(ENTITY, NOW))
        assert access_key("shop") not in notes.open
        assert access_key("shop") in notes.resolved
        assert sync.statuses["shop"] == ("valid", None)

    def test_no_answer_changes_nothing(self):
        # A timeout or a provider outage is not a broken connection, and not a fixed one.
        checks, sync, _, notes = world(
            [source("shop", "shopify")], {"shop": (False, "no")}
        )
        run(checks.check_entity(ENTITY, NOW))
        checks.check = lambda src, key: _answer(None, "Request timed out")
        run(checks.check_entity(ENTITY, NOW))
        assert access_key("shop") in notes.open
        assert sync.statuses["shop"] == ("invalid", "no")

    def test_zoho_says_reconnect_and_the_merchant_key_links_to_its_revolut_app(self):
        checks, _, _, notes = world(
            [
                source("cal", "zoho_calendar"),
                source("merch", "revolut_merchant", external_account_id="rev"),
            ],
            {"cal": (False, "invalid_code"), "merch": (False, "Invalid key")},
        )
        run(checks.check_entity(ENTITY, NOW))
        assert "Reconnect" in notes.open[access_key("cal")]["body"]
        merchant = notes.open[access_key("merch")]
        assert merchant["title"] == "Revolut Merchant access stopped working"
        assert merchant["link"] == "/integrations?app=rev"

    def test_hidden_integrations_are_checked_too(self):
        checks, _, _, notes = world(
            [source("pp", "paypal", hidden_at=ago(3))], {"pp": (False, "refused")}
        )
        run(checks.check_entity(ENTITY, NOW))
        assert access_key("pp") in notes.open

    def test_one_source_failing_to_check_does_not_stop_the_rest(self):
        checks, _, _, notes = world(
            [source("a", "shopify"), source("b", "paypal")], {"b": (False, "refused")}
        )

        async def check(src, key):
            if src["id"] == "a":
                raise RuntimeError("vault unavailable")
            return False, "refused"

        checks.check = check
        outcome = run(checks.check_entity(ENTITY, NOW))
        assert [s.source_id for s in outcome.sources] == ["b"]
        assert access_key("b") in notes.open


async def _answer(ok, message):
    return ok, message


class TestStale:
    def test_fourteen_days_is_the_line(self):
        assert not is_stale(ago(14), NOW)
        assert is_stale(ago(14.01), NOW)
        assert not is_stale(None, NOW)  # never synced is not stale

    def test_an_old_sync_opens_one_and_a_new_sync_resolves_it(self):
        sources = [source("sq", "squarespace", synced_days_ago=17)]
        checks, sync, _, notes = world(sources, {})
        run(checks.check_entity(ENTITY, NOW))
        note = notes.open[stale_key("sq")]
        assert note["title"] == "Squarespace hasn't synced in 2 weeks"
        assert "20 October 2026" in note["body"]
        assert note["link"] == "/integrations?app=sq"

        sources[0]["last_synced_at"] = ago(0)
        run(checks.check_entity(ENTITY, NOW))
        assert stale_key("sq") not in notes.open

    def test_a_refused_key_does_not_also_say_stale(self):
        checks, _, _, notes = world(
            [source("sq", "squarespace", synced_days_ago=30)], {"sq": (False, "no")}
        )
        run(checks.check_entity(ENTITY, NOW))
        assert access_key("sq") in notes.open
        assert stale_key("sq") not in notes.open

    def test_the_merchant_key_is_not_judged_on_its_own_sync(self):
        checks, _, _, notes = world(
            [
                source(
                    "merch",
                    "revolut_merchant",
                    synced_days_ago=None,
                    external_account_id="rev",
                )
            ],
            {},
        )
        run(checks.check_entity(ENTITY, NOW))
        assert notes.open == {}


class TestJournals:
    def test_a_count_opens_it_and_links_to_generate_journals(self):
        checks, _, _, notes = world([source("shop", "shopify")], {}, count=12)
        outcome = run(checks.check_entity(ENTITY, NOW))
        assert outcome.awaiting_journals == 12
        assert notes.open[JOURNALS]["title"] == "12 payments need journals"
        assert notes.open[JOURNALS]["link"] == "/integrations?journals=1"

    def test_none_left_resolves_it(self):
        checks, _, journals, notes = world([source("shop", "shopify")], {}, count=3)
        run(checks.check_journals(ENTITY))
        journals.count = 0
        assert run(checks.check_journals(ENTITY)) == 0
        assert JOURNALS not in notes.open

    def test_the_title_counts_one(self):
        assert journals_title(1) == "1 payment needs a journal"


class TestEntities:
    def test_every_business_with_a_source_once(self):
        other = "22222222-2222-2222-2222-222222222222"
        sources = [source("a", "shopify"), source("b", "paypal")]
        sources.append({**source("c", "revolut"), "entity_id": other})
        sources.append({**source("d", "revolut"), "entity_id": None})
        checks, *_ = world(sources, {})
        assert run(checks.entities_with_sources()) == sorted([ENTITY, other])


def mock_http(monkeypatch, status: int = 200, raises: Optional[Exception] = None):
    """Make every httpx client in source_access answer `status` (or raise)."""
    real = httpx.AsyncClient

    def handler(request):
        if raises:
            raise raises
        return httpx.Response(status, json={})

    def client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real(transport=httpx.MockTransport(handler), timeout=1)

    monkeypatch.setattr(source_access.httpx, "AsyncClient", client)


SHOPIFY_KEY = '{"client_id": "id", "client_secret": "secret"}'


class TestProviderAnswers:
    @pytest.mark.parametrize(
        "status, ok", [(200, True), (400, False), (401, False), (404, False)]
    )
    def test_shopify_refusals(self, monkeypatch, status, ok):
        mock_http(monkeypatch, status)
        assert run(source_access.check_shopify(SHOPIFY_KEY, "x.myshopify.com"))[0] is ok

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_a_busy_or_failing_provider_is_no_answer(self, monkeypatch, status):
        mock_http(monkeypatch, status)
        assert run(source_access.check_revolut("k"))[0] is None
        assert (
            run(source_access.check_shopify(SHOPIFY_KEY, "x.myshopify.com"))[0] is None
        )

    def test_a_timeout_is_no_answer(self, monkeypatch):
        mock_http(monkeypatch, raises=httpx.ReadTimeout("slow"))
        ok, message = run(source_access.check_paypal('{"client_id":"a","secret":"b"}'))
        assert ok is None and "timed out" in message

    def test_a_malformed_key_is_refused_without_asking(self, monkeypatch):
        mock_http(monkeypatch, raises=AssertionError("should not be called"))
        assert run(source_access.check_paypal("not json"))[0] is False
        assert (
            run(source_access.check_source({"provider": "shopify"}, None))[0] is False
        )

    def test_zoho_tells_a_revoked_token_from_an_unreadable_answer(self, monkeypatch):
        from ai_agent.integrations.zoho_calendar import oauth

        async def revoked(token):
            raise oauth.ZohoOAuthError("failed", code="invalid_code")

        async def garbled(token):
            raise oauth.ZohoOAuthError("non-JSON response (HTTP 502)")

        key = '{"refresh_token": "r"}'
        monkeypatch.setattr(oauth, "refresh_access_token", revoked)
        assert run(source_access.check_zoho_calendar(key))[0] is False
        monkeypatch.setattr(oauth, "refresh_access_token", garbled)
        assert run(source_access.check_zoho_calendar(key))[0] is None


class TestRegistration:
    def test_the_functions_are_served(self):
        ids = {f.id for f in FUNCTIONS}
        for fn in notification_functions.NOTIFICATION_FUNCTIONS:
            assert fn.id in ids

    def test_the_journals_event_names_the_business(self):
        event = notification_functions.journals_check_event(ENTITY)
        assert event.name == notification_functions.CHECK_JOURNALS
        assert event.data == {"entity_id": ENTITY}
