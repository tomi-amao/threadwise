"""Gifts and write-offs of stock: one dated movement each, and a journal for valued stock.

Samples are never valued: they are counted, so their disposal is recorded as a movement, but at
no cost and with no journal, so nothing reaches the balance sheet or the expense accounts.
"""

import asyncio
from typing import Any, Dict, List
from uuid import uuid4

import pytest

from ai_agent.services.journal_service import JournalService

ENTITY = uuid4()


class Query:
    def __init__(self, db: "FakeDb", table: str):
        self.db, self.table = db, table
        self.row: Dict[str, Any] = {}

    def select(self, *_):
        return self

    def eq(self, *_):
        return self

    def limit(self, *_):
        return self

    def insert(self, values):
        self.row = {"id": str(uuid4()), **values}
        return self

    def execute(self):
        if self.row:
            self.db.inserted.append((self.table, self.row))
            return type("R", (), {"data": [self.row]})()
        return type("R", (), {"data": [self.db.item]})()


class FakeDb:
    def __init__(self, item: Dict[str, Any]):
        self.item = item
        self.inserted: List[tuple] = []

    def table(self, name):
        return Query(self, name)


class Journals(JournalService):
    def __init__(self, db: FakeDb):
        super().__init__()
        self._client = db
        self.journals: List[Dict[str, Any]] = []

    async def _get_account_id(self, entity_id, account_number, *args, **kwargs):
        return f"id-{account_number}"

    async def _create_journal(self, **journal):
        self.journals.append(journal)
        return journal


def dispose(item: Dict[str, Any], kind: str = "WRITE_OFF"):
    db = FakeDb({"id": str(uuid4()), "sku": "SKU-1", **item})
    service = Journals(db)
    result = asyncio.run(
        service.record_inventory_disposal(
            ENTITY, uuid4(), kind, 4, occurred_at="2026-10-01T00:00:00+00:00"
        )
    )
    [(table, movement)] = db.inserted
    assert table == "inventory_movements"
    return result, movement, service.journals


@pytest.mark.parametrize("kind", ["GIFT", "WRITE_OFF"])
def test_a_sample_is_counted_but_never_valued(kind):
    result, movement, journals = dispose(
        {"item_type": "sample", "unit_cost": 12.5}, kind
    )
    assert movement["quantity"] == -4
    assert movement["unit_cost"] == 0
    assert journals == [] and result["journal"] is None


def test_valued_stock_written_off_leaves_finished_goods():
    _, movement, [journal] = dispose({"item_type": "sellable", "unit_cost": 12.5})
    assert movement["unit_cost"] == 12.5
    lines = {
        line["account_id"]: (line["debit"], line["credit"])
        for line in journal["line_items"]
    }
    assert lines == {"id-5070": (50.0, 0), "id-1033": (0, 50.0)}


def test_no_item_type_is_valued_as_finished_goods():
    _, _, [journal] = dispose({"item_type": None, "unit_cost": 10})
    assert "id-1033" in {line["account_id"] for line in journal["line_items"]}
