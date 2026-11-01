"""What an invoice bought: each line's kind (product, sample or other) and, for a product, the
business's product it matches.

This is shown on the invoice only. The rule these tests guard is that nothing an invoice does
writes to products or stock: the database fake records every write, and the stock tables must
never appear among them.
"""

import asyncio
from typing import Any, Dict, List, Optional
from uuid import uuid4

import pytest

from ai_agent.services.invoice_rules import InvoiceRuleError
from ai_agent.services.invoice_service import (
    ExtractedLineItem,
    InvoiceService,
    build_catalogue,
    match_product,
)

ENTITY = uuid4()
OTHER_ENTITY = uuid4()
INVOICE = uuid4()
STOCK_TABLES = {"products", "inventory_items", "inventory_movements"}

CAP, BEANIE, RIVAL = str(uuid4()), str(uuid4()), str(uuid4())
PRODUCTS = [
    {"id": CAP, "entity_id": str(ENTITY), "name": "Globe Cap"},
    {"id": BEANIE, "entity_id": str(ENTITY), "name": "Ribbed Beanie"},
    {"id": RIVAL, "entity_id": str(OTHER_ENTITY), "name": "Rival Cap"},
]
ITEMS = [
    {"entity_id": str(ENTITY), "sku": "CAP-BLU", "product_id": CAP},
    {"entity_id": str(ENTITY), "sku": "BEA-01", "product_id": BEANIE},
]


class Query:
    def __init__(self, db: "FakeDb", table: str):
        self.db, self.table = db, table
        self.filters: List[tuple] = []
        self.write: Optional[tuple] = None
        self._negate = False

    @property
    def not_(self):
        self._negate = True
        return self

    def select(self, *_):
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, list(values)))
        return self

    def is_(self, column, value):
        self.filters.append(("not_null" if self._negate else "null", column, value))
        self._negate = False
        return self

    def insert(self, values):
        self.write = ("insert", values)
        return self

    def update(self, values):
        self.write = ("update", values)
        return self

    def _matches(self, row):
        for kind, column, value in self.filters:
            if kind == "eq" and str(row.get(column)) != str(value):
                return False
            if kind == "in" and str(row.get(column)) not in {str(v) for v in value}:
                return False
            if kind == "not_null" and row.get(column) is None:
                return False
        return True

    def execute(self):
        if self.write:
            self.db.writes.append((self.table, *self.write, self.filters))
            data = self.write[1] if self.write[0] == "insert" else []
            return type("R", (), {"data": data})()
        self.db.reads.append(self.table)
        rows = [r for r in self.db.rows.get(self.table, []) if self._matches(r)]
        return type("R", (), {"data": rows})()


class FakeDb:
    def __init__(self):
        self.rows = {"products": PRODUCTS, "inventory_items": ITEMS}
        self.reads: List[str] = []
        self.writes: List[tuple] = []

    def table(self, name):
        return Query(self, name)


def service_with(db: FakeDb, monkeypatch, lines=None) -> InvoiceService:
    service = InvoiceService()
    service._client = db
    invoice = {
        "id": str(INVOICE),
        "entity_id": str(ENTITY),
        "status": "PAID",
        "invoice_type": "PURCHASE",
        "invoice_line_items": lines or [{"id": "l1"}, {"id": "l2"}, {"id": "l3"}],
    }

    async def get_invoice(_id):
        return invoice

    monkeypatch.setattr(service, "get_invoice", get_invoice)
    return service


def stock_writes(db: FakeDb) -> List[tuple]:
    return [w for w in db.writes if w[0] in STOCK_TABLES]


def line_patches(db: FakeDb) -> Dict[str, Any]:
    """Each line update written, keyed by the line it was filtered to."""
    patches = {}
    for table, _, values, filters in db.writes:
        if table == "invoice_line_items":
            line_id = next(v for _, column, v in filters if column == "id")
            patches[line_id] = values
    return patches


class TestMatchProduct:
    catalogue = build_catalogue(PRODUCTS[:2], ITEMS)

    def test_by_sku_first(self):
        # The SKU wins over a description that names another product.
        assert match_product(self.catalogue, "cap-blu ", "Ribbed Beanie") == CAP

    def test_then_by_exact_name_ignoring_case_and_spaces(self):
        assert match_product(self.catalogue, None, "  ribbed beanie ") == BEANIE

    def test_a_partial_name_does_not_match(self):
        assert match_product(self.catalogue, None, "Globe Cap, navy, 60 units") is None

    def test_an_ambiguous_name_or_sku_stays_unlinked(self):
        twin = {"id": str(uuid4()), "name": "Globe Cap"}
        shared = {"sku": "CAP-BLU", "product_id": BEANIE}
        catalogue = build_catalogue(PRODUCTS[:2] + [twin], ITEMS + [shared])
        assert match_product(catalogue, "CAP-BLU", "Globe Cap") is None

    def test_items_without_a_product_are_not_in_the_catalogue(self):
        catalogue = build_catalogue([], [{"sku": "SAMPLE-1", "product_id": None}])
        assert catalogue.by_sku == {}


class TestCreateLines:
    def _create(self, db, monkeypatch, lines):
        service = service_with(db, monkeypatch)
        asyncio.run(
            service.create_line_items(
                INVOICE, lines, invoice_type="PURCHASE", entity_id=ENTITY
            )
        )
        [write] = [w for w in db.writes if w[0] == "invoice_line_items"]
        return write[2]

    def test_each_line_keeps_its_kind_and_a_product_line_its_product(self, monkeypatch):
        db = FakeDb()
        rows = self._create(
            db,
            monkeypatch,
            [
                ExtractedLineItem(description="Globe Cap", line_kind="product"),
                ExtractedLineItem(
                    description="Mystery", sku="BEA-01", line_kind="product"
                ),
                ExtractedLineItem(description="Unknown hat", line_kind="product"),
                # A sample is never a product, even when its name is one.
                ExtractedLineItem(description="Globe Cap", line_kind="sample"),
                ExtractedLineItem(description="Freight", line_kind="other"),
                ExtractedLineItem(description="No kind given"),
            ],
        )
        assert [(r["line_kind"], r["product_id"]) for r in rows] == [
            ("product", CAP),
            ("product", BEANIE),
            ("product", None),
            ("sample", None),
            ("other", None),
            ("other", None),
        ]
        assert stock_writes(db) == []

    def test_another_businesss_products_are_not_matched(self, monkeypatch):
        db = FakeDb()
        rows = self._create(
            db,
            monkeypatch,
            [ExtractedLineItem(description="Rival Cap", line_kind="product")],
        )
        assert rows[0]["product_id"] is None

    def test_no_product_lines_means_no_catalogue_read(self, monkeypatch):
        db = FakeDb()
        self._create(
            db,
            monkeypatch,
            [ExtractedLineItem(description="Sample cap", line_kind="sample")],
        )
        assert db.reads == []


class TestUpdateLines:
    def _update(self, db, monkeypatch, updates, **kwargs):
        service = service_with(db, monkeypatch)
        asyncio.run(
            service.update_invoice(
                ENTITY, INVOICE, {}, line_item_updates=updates, **kwargs
            )
        )
        return line_patches(db)

    def test_linking_a_product_makes_it_a_product_line(self, monkeypatch):
        db = FakeDb()
        patches = self._update(db, monkeypatch, {"l1": {"product_id": CAP}})
        assert patches == {"l1": {"line_kind": "product", "product_id": CAP}}

    def test_a_sample_or_other_line_has_no_product(self, monkeypatch):
        db = FakeDb()
        patches = self._update(
            db,
            monkeypatch,
            {"l1": {"line_kind": "sample"}, "l2": {"line_kind": "other"}},
        )
        assert patches == {
            "l1": {"line_kind": "sample", "product_id": None},
            "l2": {"line_kind": "other", "product_id": None},
        }

    def test_a_product_line_can_be_unlinked(self, monkeypatch):
        db = FakeDb()
        patches = self._update(
            db, monkeypatch, {"l1": {"line_kind": "product", "product_id": None}}
        )
        assert patches == {"l1": {"line_kind": "product", "product_id": None}}

    def test_kind_and_account_changes_to_a_line_are_one_write(self, monkeypatch):
        db = FakeDb()
        patches = self._update(
            db,
            monkeypatch,
            {"l1": {"line_kind": "sample"}},
            line_item_gl_updates={"l1": "gl-1"},
        )
        assert patches == {
            "l1": {"line_kind": "sample", "product_id": None, "gl_account_id": "gl-1"}
        }

    @pytest.mark.parametrize(
        "updates, message",
        [
            ({"l1": {"product_id": RIVAL}}, "not one of this business's"),
            ({"l1": {"product_id": str(uuid4())}}, "not one of this business's"),
            (
                {"l1": {"line_kind": "sample", "product_id": CAP}},
                "Only a product line",
            ),
            ({"l1": {"line_kind": "material"}}, "Unknown line kind"),
            ({"elsewhere": {"line_kind": "sample"}}, "do not belong"),
        ],
        ids=[
            "rival-product",
            "unknown-product",
            "sample-with-product",
            "bad-kind",
            "foreign-line",
        ],
    )
    def test_refused_changes_write_nothing(self, monkeypatch, updates, message):
        db = FakeDb()
        with pytest.raises(InvoiceRuleError, match=message):
            self._update(db, monkeypatch, updates)
        assert db.writes == []


def test_nothing_an_invoice_does_with_its_lines_writes_to_products_or_stock(
    monkeypatch,
):
    db = FakeDb()
    service = service_with(db, monkeypatch)
    asyncio.run(
        service.create_line_items(
            INVOICE,
            [
                ExtractedLineItem(description="Globe Cap", line_kind="product"),
                ExtractedLineItem(description="Sample", line_kind="sample"),
            ],
            entity_id=ENTITY,
        )
    )
    asyncio.run(
        service.update_invoice(
            ENTITY,
            INVOICE,
            {"notes": "checked"},
            line_item_updates={
                "l1": {"product_id": BEANIE},
                "l2": {"line_kind": "sample"},
            },
        )
    )
    assert db.writes, "the fake should have seen the line writes"
    assert stock_writes(db) == []
    # The stock path is gone from the service, not just unused.
    for name in (
        "apply_stock_decisions",
        "create_products_from_line_items",
        "create_inventory_movements_only",
        "link_line_items_to_existing_products",
    ):
        assert not hasattr(service, name)
