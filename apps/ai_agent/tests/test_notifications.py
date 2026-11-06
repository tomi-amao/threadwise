"""Notifications: one open per business and key; refreshed, not repeated; resolved when gone."""

import asyncio
import itertools
from typing import Any, Dict, List

import pytest

from ai_agent.services.notifications import NotificationService, check_link

ENTITY = "e-1"


class Table:
    """Just enough of the PostgREST builder, over a list of rows."""

    ids = itertools.count(1)

    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows
        self.op: str = "select"
        self.payload: Any = None
        self.filters: List = []

    def select(self, _cols):
        self.op = "select"
        return self

    def insert(self, row):
        self.op, self.payload = "insert", row
        return self

    def update(self, values):
        self.op, self.payload = "update", values
        return self

    def eq(self, col, value):
        self.filters.append(lambda r: r.get(col) == value)
        return self

    def is_(self, col, _null):
        self.filters.append(lambda r: r.get(col) is None)
        return self

    def limit(self, _n):
        return self

    def execute(self):
        if self.op == "insert":
            row = {"read_at": None, "resolved_at": None, **self.payload}
            clash = any(
                r["entity_id"] == row["entity_id"]
                and r["dedupe_key"] == row["dedupe_key"]
                and r["resolved_at"] is None
                for r in self.rows
            )
            if clash:
                raise RuntimeError(
                    "23505 duplicate key value violates unique constraint"
                )
            row["id"] = f"n-{next(self.ids)}"
            self.rows.append(row)
            return type("R", (), {"data": [row]})()
        matched = [r for r in self.rows if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in matched:
                r.update(self.payload)
        return type("R", (), {"data": matched})()


class Client:
    def __init__(self):
        self.rows: List[Dict[str, Any]] = []

    def table(self, name):
        assert name == "notifications"
        return Table(self.rows)


@pytest.fixture
def svc():
    return NotificationService(client=Client())


def notify(
    svc, title="Shopify access stopped working", key="integration_access:s1", **kw
):
    return asyncio.run(
        svc.notify(ENTITY, "integration_access", key, title, link="/integrations", **kw)
    )


def test_the_first_call_opens_one(svc):
    n = notify(svc)
    assert n.created is True
    (row,) = svc.client.rows
    assert row["title"] == "Shopify access stopped working"
    assert row["link"] == "/integrations"


def test_a_repeat_refreshes_the_open_one_and_keeps_it_read(svc):
    first = notify(svc, title="12 payments need journals", key="journals")
    svc.client.rows[0]["read_at"] = "2026-11-07T09:00:00+00:00"

    again = notify(svc, title="15 payments need journals", key="journals")

    assert again == type(first)(id=first.id, created=False)
    (row,) = svc.client.rows
    assert row["title"] == "15 payments need journals"
    assert row["read_at"] == "2026-11-07T09:00:00+00:00"


def test_resolving_closes_it_and_the_next_problem_opens_a_new_one(svc):
    notify(svc)
    assert asyncio.run(svc.resolve(ENTITY, "integration_access:s1")) is True
    assert asyncio.run(svc.resolve(ENTITY, "integration_access:s1")) is False

    again = notify(svc)
    assert again.created is True
    assert len(svc.client.rows) == 2
    assert [r["resolved_at"] is None for r in svc.client.rows] == [False, True]


def test_keys_are_per_business(svc):
    notify(svc)
    other = asyncio.run(
        svc.notify("e-2", "integration_access", "integration_access:s1", "x", link="/")
    )
    assert other.created is True
    assert len(svc.client.rows) == 2


def test_a_race_to_open_the_same_key_uses_the_one_that_won(svc, monkeypatch):
    winner = notify(svc)
    # Our read saw nothing, but another run inserted first: the insert clashes.
    calls = {"n": 0}
    real_open = svc._open

    async def stale_then_real(entity, key):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real_open(entity, key)

    monkeypatch.setattr(svc, "_open", stale_then_real)
    again = notify(svc)
    assert again.id == winner.id
    assert again.created is False


@pytest.mark.parametrize(
    "link", ["https://evil.example", "//evil.example", "integrations"]
)
def test_a_link_must_stay_inside_the_app(link):
    with pytest.raises(ValueError):
        check_link(link)
    check_link("/integrations?app=src-1")
