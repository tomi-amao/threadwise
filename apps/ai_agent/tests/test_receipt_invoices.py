"""Reading Revolut receipts into the invoice register (services/receipt_invoices.py).

The model, the extraction and Supabase are replaced by fakes, so these pin down the decisions:
which files are read, what each kind leads to, and that nothing is filed twice.
"""

import asyncio
from uuid import uuid4

import pytest

from ai_agent.services import receipt_invoices as module
from ai_agent.services.invoice_service import (
    ExtractedContact,
    ExtractedInvoice,
    ExtractedLineItem,
)
from ai_agent.services.receipt_invoices import (
    MAX_ATTEMPTS,
    ReceiptReading,
    complete_extraction,
    describe_transaction,
    is_readable,
    with_transactions,
)

ENTITY = uuid4()


def run(coro):
    return asyncio.run(coro)


class FakeTable:
    """Enough of a PostgREST table for the reader: filters, update, insert, limit."""

    def __init__(self, rows):
        self.rows = rows
        self._op, self._filters, self._values, self._limit = "select", [], None, None

    def select(self, *_):
        return self

    def update(self, values):
        self._op, self._values = "update", values
        return self

    def eq(self, column, value):
        self._filters.append(lambda r: str(r.get(column)) == str(value))
        return self

    def is_(self, column, _null):
        self._filters.append(lambda r: r.get(column) is None)
        return self

    def lt(self, column, value):
        self._filters.append(lambda r: (r.get(column) or 0) < value)
        return self

    def in_(self, column, values):
        self._filters.append(lambda r: str(r.get(column)) in set(map(str, values)))
        return self

    def order(self, *_):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        hit = [r for r in self.rows if all(f(r) for f in self._filters)]
        if self._limit is not None:
            hit = hit[: self._limit]
        if self._op == "update":
            for r in hit:
                r.update(self._values)
        return type("R", (), {"data": hit})()


class World:
    """The tables, the stored files and every call the reader made."""

    def __init__(self, monkeypatch, *, kind="invoice", direction="out", paid_by=None):
        self.txn = {
            "id": str(uuid4()),
            "entity_id": str(ENTITY),
            "source": "revolut",
            "external_transaction_id": "rev-txn-1",
            "direction": direction,
            "amount": 1030.68,
            "currency_code": "GBP",
            "occurred_at": "2026-08-28T19:06:56+00:00",
            "description": "To GALLIS LONDON LIMITED | Ref: 1081",
            "counterparty_name": None,
        }
        self.attachment = {
            "id": str(uuid4()),
            "entity_id": str(ENTITY),
            "source": "revolut",
            "external_transaction_id": "rev-txn-1",
            "external_id": "receipt-0001-aaaa",
            "file_path": "e/revolut/rev-txn-1/receipt.pdf",
            "file_name": "Receipt receipt-.pdf",
            "content_type": "application/pdf",
            "read_at": None,
            "read_attempts": 0,
            "created_at": "2026-10-29T01:25:00+00:00",
        }
        self.invoices = []
        self.payments = []
        if paid_by is not None:
            self.invoices.append(paid_by)
            self.payments.append(
                {"financial_transaction_id": self.txn["id"], "invoices": paid_by}
            )
        self.tables = {
            "transaction_attachments": [self.attachment],
            "financial_transactions": [self.txn],
            "invoices": self.invoices,
            "invoice_payments": self.payments,
        }
        self.kind = kind
        self.calls = []
        world = self

        class Storage:
            def from_(self, bucket):
                world.calls.append(("bucket", bucket))
                return self

            def download(self, path):
                world.calls.append(("download", path))
                return b"%PDF-1.7"

        class Client:
            storage = Storage()

            def table(self, name):
                return FakeTable(world.tables[name])

        service = module.invoice_service
        monkeypatch.setattr(service, "_client", Client())

        async def classify(content, content_type, entity_name, txn):
            world.calls.append(("classify", entity_name))
            if world.kind == "boom":
                raise RuntimeError("model unavailable")
            return ReceiptReading(kind=world.kind, reason="test")

        async def fetch_entity(_id):
            return {"name": "Trends Ltd"}

        async def extract(*_args, **kwargs):
            world.calls.append(("extract", kwargs["invoice_type_hint"]))
            return ExtractedInvoice(
                invoice_type="SALE",  # the reader overrides it
                invoice_number="1081",
                invoice_date="2026-08-20",
                currency="GBP",
                gross_amount=1030.68,
                counterparty=ExtractedContact(name="Gallis London Limited"),
                line_items=[ExtractedLineItem(description="Fabric")],
            )

        async def upsert_contact(_entity, contact, contact_type):
            world.calls.append(("contact", contact.name, contact_type))
            return {"id": str(uuid4())}

        async def create_invoice(_entity, extracted, _contact, **kwargs):
            row = {
                "id": str(uuid4()),
                "invoice_type": extracted.invoice_type,
                "invoice_number": extracted.invoice_number,
                **kwargs,
            }
            world.invoices.append(row)
            return row

        async def create_line_items(invoice_id, lines, **_):
            world.calls.append(("lines", len(lines)))
            return []

        async def link_payment(_entity, invoice_id, txn_id, matched_by):
            world.calls.append(("link", str(txn_id), matched_by))
            return {}

        async def chart(_entity):
            return []

        monkeypatch.setattr(module, "classify", classify)
        monkeypatch.setattr(service, "_fetch_entity", fetch_entity)
        monkeypatch.setattr(service, "extract_invoice_data", extract)
        monkeypatch.setattr(service, "upsert_contact", upsert_contact)
        monkeypatch.setattr(service, "create_invoice", create_invoice)
        monkeypatch.setattr(service, "create_line_items", create_line_items)
        monkeypatch.setattr(service, "link_payment", link_payment)
        monkeypatch.setattr(module.journal_service, "get_chart_of_accounts", chart)

    def read(self):
        return run(module.read_attachment(ENTITY, dict(self.attachment)))


class TestReading:
    def test_a_supplier_invoice_becomes_a_paid_purchase_linked_to_its_payment(
        self, monkeypatch
    ):
        world = World(monkeypatch)
        result = world.read()
        assert result["outcome"] == "invoice_created"
        (invoice,) = world.invoices
        assert invoice["invoice_type"] == "PURCHASE"
        assert invoice["status"] == "PAID"
        assert invoice["origin"] == "revolut_expense"
        assert invoice["external_id"] == "receipt-0001-aaaa"
        assert invoice["attachment_id"] == world.attachment["id"]
        assert ("extract", "PURCHASE") in world.calls
        assert ("contact", "Gallis London Limited", "supplier") in world.calls
        assert ("link", world.txn["id"], "sync") in world.calls
        assert world.attachment["document_kind"] == "invoice"
        assert world.attachment["read_at"]

    @pytest.mark.parametrize("kind", ["receipt", "other"])
    def test_a_receipt_or_anything_else_is_only_labelled(self, monkeypatch, kind):
        world = World(monkeypatch, kind=kind)
        assert world.read()["outcome"] == kind
        assert world.invoices == []
        assert not any(c[0] == "extract" for c in world.calls)
        assert world.attachment["document_kind"] == kind

    def test_an_invoice_on_money_coming_in_is_not_filed(self, monkeypatch):
        world = World(monkeypatch, direction="in")
        assert world.read()["outcome"] == "invoice_skipped"
        assert world.invoices == []
        assert world.attachment["document_kind"] == "invoice"

    def test_a_transaction_that_already_pays_an_invoice_gets_no_second_one(
        self, monkeypatch
    ):
        uploaded = {"id": "inv-up", "file_path": None, "attachment_id": None}
        world = World(monkeypatch, paid_by=uploaded)
        result = world.read()
        assert result == {"outcome": "invoice_attached", "invoice_id": "inv-up"}
        assert world.invoices == [uploaded]
        # It had no document, so the receipt becomes it.
        assert uploaded["attachment_id"] == world.attachment["id"]

    def test_an_invoice_with_its_own_document_keeps_it(self, monkeypatch):
        uploaded = {"id": "inv-up", "file_path": "e/1.pdf", "attachment_id": None}
        world = World(monkeypatch, paid_by=uploaded)
        world.read()
        assert uploaded["attachment_id"] is None

    def test_a_file_already_filed_is_not_filed_again(self, monkeypatch):
        world = World(monkeypatch)
        world.invoices.append(
            {
                "id": "inv-1",
                "entity_id": str(ENTITY),
                "origin": "revolut_expense",
                "external_id": "receipt-0001-aaaa",
            }
        )
        assert world.read()["outcome"] == "invoice_skipped"
        assert len(world.invoices) == 1

    def test_a_file_whose_transaction_is_not_in_yet_waits(self, monkeypatch):
        world = World(monkeypatch)
        world.tables["financial_transactions"].clear()
        assert world.read()["outcome"] == "waiting"
        assert world.attachment["read_at"] is None
        assert world.calls == []

    def test_a_file_that_is_not_a_pdf_or_image_is_other_without_a_model_call(
        self, monkeypatch
    ):
        world = World(monkeypatch)
        world.attachment["content_type"] = "application/zip"
        assert world.read()["outcome"] == "other"
        assert not any(c[0] == "classify" for c in world.calls)

    def test_a_failed_read_is_counted_and_kept_for_later(self, monkeypatch):
        world = World(monkeypatch, kind="boom")
        assert world.read()["outcome"] == "failed"
        assert world.attachment["read_attempts"] == 1
        assert world.attachment["read_error"] == "model unavailable"
        assert world.attachment["read_at"] is None


class TestUnread:
    def test_only_files_with_their_transaction_in_and_attempts_left(self, monkeypatch):
        world = World(monkeypatch)
        rows = world.tables["transaction_attachments"]
        rows.append(
            {
                **world.attachment,
                "id": "no-txn",
                "external_transaction_id": "rev-txn-missing",
            }
        )
        rows.append(
            {**world.attachment, "id": "gave-up", "read_attempts": MAX_ATTEMPTS}
        )
        rows.append({**world.attachment, "id": "done", "read_at": "2026-10-30"})
        ready = run(module.unread_attachments(str(ENTITY), 10))
        assert [r["id"] for r in ready] == [world.attachment["id"]]

    def test_waiting_files_do_not_take_the_places_of_ready_ones(self):
        rows = [
            {"id": "a", "external_transaction_id": "missing"},
            {"id": "b", "external_transaction_id": "t1"},
            {"id": "c", "external_transaction_id": "t2"},
        ]
        assert [r["id"] for r in with_transactions(rows, {"t1", "t2"}, 1)] == ["b"]


class TestCompleting:
    TXN = {
        "amount": 25.5,
        "currency_code": "EUR",
        "occurred_at": "2026-09-01T10:00:00+00:00",
    }

    def _extracted(self, **kwargs):
        return ExtractedInvoice(
            invoice_type="SALE",
            counterparty=ExtractedContact(name="Supplier"),
            **kwargs,
        )

    def test_missing_number_date_and_amounts_come_from_the_transaction(self):
        filled = complete_extraction(self._extracted(), self.TXN, "abcdef123456")
        assert filled.invoice_type == "PURCHASE"
        assert filled.invoice_number == "RCPT-abcdef12"
        assert filled.invoice_date == "2026-09-01"
        assert filled.gross_amount == 25.5 and filled.currency == "EUR"

    def test_what_the_document_says_is_kept(self):
        extracted = self._extracted(
            invoice_number="INV-9",
            invoice_date="2026-08-30",
            gross_amount=30.0,
            currency="GBP",
        )
        filled = complete_extraction(extracted, self.TXN, "abcdef123456")
        assert (filled.invoice_number, filled.invoice_date) == ("INV-9", "2026-08-30")
        assert (filled.gross_amount, filled.currency) == (30.0, "GBP")
        assert extracted.invoice_type == "SALE"  # the original is not changed


def test_readable_types():
    assert is_readable("application/pdf") and is_readable("image/jpeg")
    assert not is_readable("application/zip")


def test_the_model_is_told_about_the_transaction():
    text = describe_transaction(
        {
            "direction": "out",
            "amount": -12.5,
            "currency_code": "GBP",
            "occurred_at": "2026-08-28T19:06:56+00:00",
            "description": "Coffee",
        }
    )
    assert text == "Money out: 12.50 GBP, on 2026-08-28, to/from 'Coffee'"


def test_the_reader_is_registered_with_inngest():
    from ai_agent.integrations.inngest.revolut_sync_functions import (
        REVOLUT_SYNC_FUNCTIONS,
        revolut_read_receipts,
    )

    assert revolut_read_receipts in REVOLUT_SYNC_FUNCTIONS
