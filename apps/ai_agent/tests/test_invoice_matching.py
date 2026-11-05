"""Matching an uploaded invoice to its payment, and refusing duplicate uploads.

The scoring is pure, so most of this is plain data. Linking goes through the invoice
service's own ``link_payment`` (its rules are tested in test_invoice_service.py); here it is
replaced to see what the matcher asks for.
"""

import asyncio
from typing import Any, Dict, List
from uuid import UUID, uuid4

import pytest

from ai_agent.services import invoice_matching as matching
from ai_agent.services import invoice_service as service_module
from ai_agent.services.invoice_rules import InvoiceRuleError
from ai_agent.services.invoice_service import (
    DuplicateInvoiceError,
    InvoiceService,
    same_number,
)

ENTITY = uuid4()

INVOICE = {
    "id": str(uuid4()),
    "invoice_number": "PISSX2407006",
    "invoice_type": "PURCHASE",
    "status": "DRAFT",
    "origin": "upload",
    "currency": "USD",
    "gross_amount": 1176.0,
    "invoice_date": "2024-07-11",
    "names": ["WELLSUCCEED EMBROIDERY LIMITED"],
}


def txn(**over) -> Dict[str, Any]:
    row = {
        "id": str(uuid4()),
        "occurred_at": "2024-07-12T01:30:45+00:00",
        "amount": 1176.0,
        "currency_code": "USD",
        "direction": "out",
        "description": "Wellsuc7tb4",
        "counterparty_name": "Wellsuc7tb4",
        "metadata": {"cart_items": [{"invoice_number": "PISSX2407006"}]},
        "excluded_reason": None,
    }
    return {**row, **over}


class TestSignals:
    def test_the_number_is_found_whatever_its_punctuation(self):
        assert matching.number_on(
            "PI-Trendsldn-02", txn(description="pi trendsldn 02 (1)")
        )

    def test_a_number_too_short_to_tell_apart_never_counts(self):
        assert not matching.number_on("INV", txn(description="INV paid"))
        assert not matching.number_on("12", txn(description="order 12"))

    def test_a_cut_short_merchant_name_matches_the_supplier(self):
        assert matching.name_on(["WELLSUCCEED EMBROIDERY LIMITED"], txn())

    def test_company_words_alone_do_not_match(self):
        assert not matching.name_on(
            ["The Trading Company Limited"],
            txn(description="Limited trading co", counterparty_name=None, metadata={}),
        )


class TestScore:
    def test_number_and_exact_amount_is_confident(self):
        found = matching.score(INVOICE, txn())
        assert found and found.confident
        assert found.reasons[:2] == [
            "Invoice number on the transaction",
            "Exact amount",
        ]
        assert "Supplier name" in found.reasons
        assert found.days_after == 1

    @pytest.mark.parametrize(
        "change",
        [
            {"direction": "in"},
            {"currency_code": "GBP"},
            {"excluded_reason": "Covered by matching Revolut transaction"},
            {"occurred_at": "2024-06-20T00:00:00+00:00"},  # 21 days before
            {"occurred_at": "2024-11-30T00:00:00+00:00"},  # 142 days after
            {"amount": 900.0, "metadata": {}, "description": "x"},  # no number, far off
        ],
        ids=["direction", "currency", "excluded", "too-early", "too-late", "unrelated"],
    )
    def test_what_cannot_be_the_payment(self, change):
        assert matching.score(INVOICE, txn(**change)) is None

    def test_a_close_amount_without_the_number_is_only_a_suggestion(self):
        found = matching.score(
            INVOICE, txn(amount=1180.0, metadata={}, description="x")
        )
        assert found and not found.confident
        assert "Amount within 10%" in found.reasons

    def test_a_part_payment_carrying_the_number_is_suggested(self):
        # PI-Trendsldn-02: 2,121 paid as 1,272 and then 849.
        found = matching.score({**INVOICE, "gross_amount": 2121.0}, txn(amount=849.0))
        assert found and not found.confident
        assert "A part of the total" in found.reasons

    def test_a_sale_is_paid_by_money_coming_in(self):
        sale = {**INVOICE, "invoice_type": "SALE", "names": ["Kestrel"]}
        assert matching.score(sale, txn(direction="in"))
        assert matching.score(sale, txn()) is None


class TestChoosing:
    def test_the_best_comes_first(self):
        exact = txn()
        close = txn(amount=1180.0, metadata={}, description="x")
        ranked = matching.rank(INVOICE, [close, exact])
        assert [c.transaction_id for c in ranked] == [exact["id"], close["id"]]

    def test_only_a_single_confident_match_is_chosen(self):
        one = matching.rank(INVOICE, [txn(), txn(amount=1180.0, metadata={})])
        assert matching.automatic_choice(one) is not None
        # The same payment seen twice (PayPal and Revolut): left for the person.
        two = matching.rank(INVOICE, [txn(), txn()])
        assert matching.automatic_choice(two) is None


class TestAutoMatch:
    def _world(self, monkeypatch, invoice=None, linked=False, candidates=None):
        calls: List[tuple] = []

        async def get_invoice(entity_id, invoice_id):
            return invoice if invoice is not None else INVOICE

        async def window(entity_id, inv):
            return candidates if candidates is not None else [txn()]

        async def is_linked(invoice_id):
            return linked

        async def link_payment(entity_id, invoice_id, transaction_id, matched_by):
            calls.append((invoice_id, str(transaction_id), matched_by))
            return {}

        monkeypatch.setattr(matching, "_invoice", get_invoice)
        monkeypatch.setattr(matching, "_window", window)
        monkeypatch.setattr(matching, "_linked", is_linked)
        monkeypatch.setattr(
            service_module.invoice_service, "link_payment", link_payment
        )
        return calls

    def test_a_confident_match_is_linked_automatically(self, monkeypatch):
        payment = txn()
        calls = self._world(monkeypatch, candidates=[payment])
        found = asyncio.run(matching.auto_match(ENTITY, UUID(INVOICE["id"])))
        assert found and found["transaction_id"] == payment["id"]
        assert calls == [(UUID(INVOICE["id"]), payment["id"], "auto")]

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"invoice": {**INVOICE, "origin": "revolut_merchant"}},
            {"invoice": {**INVOICE, "status": "PAID"}},
            {"linked": True},
            {"invoice": {**INVOICE, "paid_outside_bank": "cash"}},
            {"candidates": [txn(amount=1180.0, metadata={})]},
        ],
        ids=[
            "synced",
            "paid-by-hand",
            "already-linked",
            "paid-outside-the-bank",
            "not-confident",
        ],
    )
    def test_nothing_is_linked_otherwise(self, monkeypatch, kwargs):
        calls = self._world(monkeypatch, **kwargs)
        assert asyncio.run(matching.auto_match(ENTITY, UUID(INVOICE["id"]))) is None
        assert calls == []

    def test_a_refused_link_is_not_an_error(self, monkeypatch):
        self._world(monkeypatch)

        async def refuse(*args):
            raise InvoiceRuleError("That transaction is already matched")

        monkeypatch.setattr(service_module.invoice_service, "link_payment", refuse)
        assert asyncio.run(matching.auto_match(ENTITY, UUID(INVOICE["id"]))) is None


class FakeTable:
    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows
        self.filters: List[tuple] = []
        self._negate = False

    @property
    def not_(self):
        self._negate = True
        return self

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, set(values)))
        return self

    def is_(self, column, _):
        self.filters.append(("set" if self._negate else "unset", column, None))
        return self

    def execute(self):
        def keep(row):
            for kind, column, value in self.filters:
                if kind == "eq" and row.get(column) != value:
                    return False
                if kind == "in" and row.get(column) not in value:
                    return False
                if kind == "set" and row.get(column) is None:
                    return False
            return True

        return type("R", (), {"data": [r for r in self.rows if keep(r)]})()


def test_stale_automatic_links_are_removed_and_a_persons_are_kept(monkeypatch):
    stale, kept, mine = txn(excluded_reason="Covered"), txn(), txn(excluded_reason="x")
    tables = {
        "invoice_payments": [
            {
                "entity_id": str(ENTITY),
                "matched_by": "auto",
                "invoice_id": "i1",
                "financial_transaction_id": stale["id"],
            },
            {
                "entity_id": str(ENTITY),
                "matched_by": "auto",
                "invoice_id": "i2",
                "financial_transaction_id": kept["id"],
            },
            {
                "entity_id": str(ENTITY),
                "matched_by": "user",
                "invoice_id": "i3",
                "financial_transaction_id": mine["id"],
            },
        ],
        "financial_transactions": [stale, kept, mine],
    }
    client = type("C", (), {"table": lambda self, name: FakeTable(tables[name])})()
    monkeypatch.setattr(matching, "_client", lambda: client)
    unlinked: List[str] = []

    async def unlink(entity_id, invoice_id, transaction_id):
        unlinked.append(str(transaction_id))

    monkeypatch.setattr(service_module.invoice_service, "unlink_payment", unlink)
    # Invoice ids in the fake are not UUIDs; the unlink only needs them passed through.
    monkeypatch.setattr(matching, "UUID", lambda value: value)
    assert asyncio.run(matching.remove_stale_auto_links(ENTITY)) == 1
    assert unlinked == [stale["id"]]


class TestDuplicates:
    def test_numbers_compare_as_people_write_them(self):
        assert same_number("PISSX-2407006", "pissx 2407006")
        assert not same_number("PISSX2407006", "PISSX2407007")
        assert not same_number("", "")

    def _service(self, monkeypatch, existing: List[Dict[str, Any]]):
        service = InvoiceService()
        service._client = type(
            "C", (), {"table": lambda self, name: FakeTable(existing)}
        )()
        extracted: List[bytes] = []

        async def extract(content, *args, **kwargs):
            extracted.append(content)
            raise AssertionError("the model should not be asked to read a duplicate")

        monkeypatch.setattr(service, "extract_invoice_data", extract)
        return service, extracted

    def test_the_same_file_is_refused_before_it_is_read(self, monkeypatch):
        import hashlib

        content = b"%PDF-1.4 the same bill"
        existing = [
            {
                "id": "inv-1",
                "invoice_number": "PISSX2407006",
                "entity_id": str(ENTITY),
                "file_sha256": hashlib.sha256(content).hexdigest(),
            }
        ]
        service, extracted = self._service(monkeypatch, existing)
        with pytest.raises(
            DuplicateInvoiceError, match="already in your invoices as PISSX2407006"
        ) as caught:
            asyncio.run(service.process_invoice(ENTITY, content, "application/pdf"))
        assert caught.value.invoice_id == "inv-1"
        assert extracted == []

    def test_the_same_number_from_the_same_counterparty_is_refused(self, monkeypatch):
        contact = str(uuid4())
        existing = [
            {
                "id": "inv-2",
                "invoice_number": "PISSX-2407006",
                "entity_id": str(ENTITY),
                "counterparty_id": contact,
            }
        ]
        service, _ = self._service(monkeypatch, existing)
        with pytest.raises(DuplicateInvoiceError, match="PISSX-2407006"):
            asyncio.run(
                service._refuse_duplicate_number(ENTITY, UUID(contact), "pissx2407006")
            )
        # Another counterparty's invoice with that number is not a duplicate.
        asyncio.run(service._refuse_duplicate_number(ENTITY, uuid4(), "PISSX2407006"))
