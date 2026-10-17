"""Tests for the invoice service's lifecycle, deletion, editing and stock decisions.

The service talks to Supabase and the journal service; both are replaced here with fakes
so the tests pin down the *decisions* the service makes: what it posts, voids, refuses and
validates.
"""

import asyncio
from uuid import uuid4

import pytest

from ai_agent.services import invoice_service as module
from ai_agent.services.invoice_rules import InvoiceRuleError
from ai_agent.services.invoice_service import InvoiceService
from ai_agent.services.journal_service import JournalError

ENTITY = uuid4()
INVOICE = uuid4()
J_PURCHASE = str(uuid4())
J_PAYMENT = str(uuid4())


def run(coro):
    return asyncio.run(coro)


class FakeJournals:
    """Stands in for journal_service, recording what the invoice service asks of it."""

    def __init__(self):
        self.calls = []
        self.payment_error = None

    async def create_purchase_journal(self, entity_id, invoice_id, force=False, **_):
        self.calls.append(("purchase", force))
        return {"id": "j-purchase"}

    async def create_sale_journal(self, entity_id, invoice_id, **_):
        self.calls.append(("sale",))
        return {"id": "j-sale"}

    async def create_invoice_payment_journal(self, entity_id, invoice_id):
        self.calls.append(("payment",))
        if self.payment_error:
            raise JournalError(self.payment_error)
        return {"id": "j-payment"}

    async def reverse_journal(self, entity_id, journal_id):
        self.calls.append(("reverse", str(journal_id)))
        return {"id": str(journal_id), "status": "reversed"}


@pytest.fixture
def journals(monkeypatch):
    fake = FakeJournals()
    monkeypatch.setattr(module, "journal_service", fake)
    return fake


def make_service(
    monkeypatch,
    *,
    status="DRAFT",
    invoice_type="PURCHASE",
    lines=None,
    entity=ENTITY,
    posted=(),
    invoice_date="2026-03-01",
    file_path=None,
):
    """An InvoiceService whose storage calls are replaced by in-memory fakes."""
    service = InvoiceService()
    invoice = {
        "id": str(INVOICE),
        "entity_id": str(entity),
        "status": status,
        "invoice_type": invoice_type,
        "invoice_date": invoice_date,
        "file_path": file_path,
        "invoice_line_items": (
            lines
            if lines is not None
            else [
                {"id": "l1", "description": "Wool"},
                {"id": "l2", "description": "Shipping"},
            ]
        ),
    }
    state = {
        "invoice": invoice,
        "status_writes": [],
        "deleted": False,
        "line_updates": [],
        "invoice_updates": [],
    }

    async def get_invoice(_id):
        return state["invoice"]

    async def update_invoice_status(_id, target):
        state["status_writes"].append(target)
        state["invoice"] = {**state["invoice"], "status": target}
        return state["invoice"]

    async def invoice_journals(entity_id, invoice_id, *, posted_only=True):
        return list(posted)

    monkeypatch.setattr(service, "get_invoice", get_invoice)
    monkeypatch.setattr(service, "update_invoice_status", update_invoice_status)
    monkeypatch.setattr(service, "_invoice_journals", invoice_journals)
    return service, state


class TestSetStatus:
    def test_finalising_a_draft_purchase_posts_the_purchase_journal_first(
        self, monkeypatch, journals
    ):
        service, state = make_service(monkeypatch)
        result = run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert journals.calls == [("purchase", False)]
        assert state["status_writes"] == ["OPEN"]
        assert result["purchase_journal"] == {"id": "j-purchase"}

    def test_a_sale_posts_the_sale_journal(self, monkeypatch, journals):
        service, _ = make_service(monkeypatch, invoice_type="SALE")
        run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert journals.calls == [("sale",)]

    def test_if_posting_fails_the_status_does_not_move(self, monkeypatch, journals):
        service, state = make_service(monkeypatch)

        async def boom(*a, **k):
            raise JournalError("no AP account")

        journals.create_purchase_journal = boom
        with pytest.raises(JournalError):
            run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert state["status_writes"] == []

    def test_marking_paid_posts_payment_and_warns_when_cash_side_is_unknown(
        self, monkeypatch, journals
    ):
        journals.payment_error = "no matching bank transaction"
        service, state = make_service(monkeypatch, status="OPEN")
        result = run(service.set_invoice_status(ENTITY, INVOICE, "PAID"))
        assert ("payment",) in journals.calls
        assert state["status_writes"] == ["PAID"]
        assert "no matching bank transaction" in result["warnings"][0]

    def test_an_invalid_move_is_refused_and_writes_nothing(self, monkeypatch, journals):
        service, state = make_service(monkeypatch, status="OPEN")
        with pytest.raises(InvoiceRuleError):
            run(service.set_invoice_status(ENTITY, INVOICE, "DRAFT"))
        assert journals.calls == [] and state["status_writes"] == []

    def test_repeating_the_current_status_is_a_noop(self, monkeypatch, journals):
        service, state = make_service(monkeypatch, status="OPEN")
        run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert journals.calls == [] and state["status_writes"] == []

    def test_voiding_reverses_every_posted_journal(self, monkeypatch, journals):
        posted = [
            {"id": J_PURCHASE, "journal_type": "purchase", "status": "posted"},
            {"id": J_PAYMENT, "journal_type": "payment", "status": "posted"},
        ]
        service, state = make_service(monkeypatch, status="PAID", posted=posted)
        result = run(service.set_invoice_status(ENTITY, INVOICE, "VOID"))
        assert [c for c in journals.calls if c[0] == "reverse"] == [
            ("reverse", J_PURCHASE),
            ("reverse", J_PAYMENT),
        ]
        assert len(result["voided_journals"]) == 2
        assert state["status_writes"] == ["VOID"]

    def test_unpaying_voids_only_the_payment_journal(self, monkeypatch, journals):
        posted = [
            {"id": J_PURCHASE, "journal_type": "purchase", "status": "posted"},
            {"id": J_PAYMENT, "journal_type": "payment", "status": "posted"},
        ]
        service, _ = make_service(monkeypatch, status="PAID", posted=posted)
        run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert [c for c in journals.calls if c[0] == "reverse"] == [
            ("reverse", J_PAYMENT)
        ]

    def test_a_prior_period_invoice_cannot_be_finalised_but_can_be_voided(
        self, monkeypatch, journals
    ):
        service, state = make_service(monkeypatch, invoice_date="2024-06-01")
        with pytest.raises(JournalError, match="accounting cutoff"):
            run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        run(service.set_invoice_status(ENTITY, INVOICE, "VOID"))
        assert state["status_writes"] == ["VOID"]

    def test_another_entitys_invoice_is_not_found(self, monkeypatch, journals):
        service, _ = make_service(monkeypatch, entity=uuid4())
        with pytest.raises(ValueError, match="not found"):
            run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))


class TestDelete:
    def _deleting(self, monkeypatch, **kwargs):
        service, state = make_service(monkeypatch, **kwargs)

        class Result:
            data = [{"id": str(INVOICE)}]

        class Table:
            def delete(self):
                state["deleted"] = True
                return self

            def eq(self, *_):
                return self

            def execute(self):
                return Result()

        class Storage:
            def from_(self, bucket):
                state["bucket"] = bucket
                return self

            def remove(self, paths):
                state["removed"] = paths

        class Client:
            storage = Storage()

            def table(self, name):
                return Table()

        service._client = Client()
        return service, state

    def test_a_draft_goes_with_its_document(self, monkeypatch, journals):
        service, state = self._deleting(monkeypatch, file_path="e/1.pdf")
        result = run(service.delete_invoice(ENTITY, INVOICE))
        assert state["deleted"] and state["removed"] == ["e/1.pdf"]
        assert result == {"deleted": True, "file_removed": True}

    @pytest.mark.parametrize("status", ["OPEN", "PAID"])
    def test_a_live_invoice_cannot_be_deleted(self, monkeypatch, journals, status):
        service, state = self._deleting(monkeypatch, status=status)
        with pytest.raises(InvoiceRuleError):
            run(service.delete_invoice(ENTITY, INVOICE))
        assert not state["deleted"]

    def test_posted_journals_block_deleting_even_a_voided_draft(
        self, monkeypatch, journals
    ):
        service, state = self._deleting(
            monkeypatch, status="VOID", posted=[{"id": "j", "journal_type": "purchase"}]
        )
        with pytest.raises(InvoiceRuleError, match="posted journals"):
            run(service.delete_invoice(ENTITY, INVOICE))
        assert not state["deleted"]


class TestUpdate:
    def _updating(self, monkeypatch, **kwargs):
        service, state = make_service(monkeypatch, **kwargs)

        class Table:
            def __init__(self, name):
                self.name = name

            def update(self, values):
                self.values = values
                return self

            def eq(self, column, value):
                self.filters = getattr(self, "filters", []) + [(column, value)]
                return self

            def execute(self):
                key = (
                    "line_updates"
                    if self.name == "invoice_line_items"
                    else "invoice_updates"
                )
                state[key].append((self.values, getattr(self, "filters", [])))
                return type("R", (), {"data": []})()

        class Client:
            def table(self, name):
                return Table(name)

        service._client = Client()
        return service, state

    def test_recoding_a_line_is_scoped_to_this_invoice(self, monkeypatch, journals):
        service, state = self._updating(monkeypatch)
        run(
            service.update_invoice(
                ENTITY, INVOICE, {}, line_item_gl_updates={"l1": "gl-1"}
            )
        )
        values, filters = state["line_updates"][0]
        assert values == {"gl_account_id": "gl-1"}
        assert ("invoice_id", str(INVOICE)) in filters

    def test_a_line_from_another_invoice_is_rejected_before_anything_is_written(
        self, monkeypatch, journals
    ):
        service, state = self._updating(monkeypatch)
        with pytest.raises(InvoiceRuleError, match="do not belong"):
            run(
                service.update_invoice(
                    ENTITY,
                    INVOICE,
                    {},
                    line_item_gl_updates={"l1": "x", "elsewhere": "y"},
                )
            )
        assert state["line_updates"] == []

    def test_a_draft_does_not_get_a_journal_just_for_being_recoded(
        self, monkeypatch, journals
    ):
        service, _ = self._updating(monkeypatch, status="DRAFT")
        run(
            service.update_invoice(
                ENTITY, INVOICE, {}, line_item_gl_updates={"l1": "gl"}
            )
        )
        assert journals.calls == []

    def test_a_finalised_purchase_regenerates_its_journal(self, monkeypatch, journals):
        service, _ = self._updating(monkeypatch, status="OPEN")
        run(
            service.update_invoice(
                ENTITY, INVOICE, {}, line_item_gl_updates={"l1": "gl"}
            )
        )
        assert journals.calls == [("purchase", True)]

    def test_direction_can_only_change_on_a_draft(self, monkeypatch, journals):
        service, _ = self._updating(monkeypatch, status="OPEN", invoice_type="PURCHASE")
        with pytest.raises(InvoiceRuleError, match="draft"):
            run(service.update_invoice(ENTITY, INVOICE, {"invoice_type": "SALE"}))
        draft, state = self._updating(
            monkeypatch, status="DRAFT", invoice_type="PURCHASE"
        )
        run(
            draft.update_invoice(ENTITY, INVOICE, {"invoice_type": "SALE", "amount": 1})
        )
        assert state["invoice_updates"][0][0] == {
            "invoice_type": "SALE"
        }  # amount is ignored

    def test_notes_are_editable_on_a_finalised_invoice(self, monkeypatch, journals):
        service, state = self._updating(monkeypatch, status="PAID")
        run(service.update_invoice(ENTITY, INVOICE, {"notes": "chased"}))
        assert state["invoice_updates"][0][0] == {"notes": "chased"}


class TestStockDecisions:
    def _stocking(self, monkeypatch, recorded=("l1",), **kwargs):
        service, state = make_service(monkeypatch, **kwargs)
        state["calls"] = []

        async def create(entity_id, invoice_id, ids, overrides=None):
            state["calls"].append(("new", ids, overrides))
            return []

        async def link(entity_id, invoice_id, links):
            state["calls"].append(("link", links))
            return {}

        async def track(entity_id, invoice_id, ids, overrides=None):
            state["calls"].append(("track", ids, overrides))
            return {}

        async def stock_state(invoice_id, ids):
            return set(recorded) & set(ids)

        monkeypatch.setattr(service, "create_products_from_line_items", create)
        monkeypatch.setattr(service, "link_line_items_to_existing_products", link)
        monkeypatch.setattr(service, "create_inventory_movements_only", track)
        monkeypatch.setattr(service, "stock_state", stock_state)
        return service, state

    def test_each_action_goes_to_the_right_step(self, monkeypatch, journals):
        service, state = self._stocking(monkeypatch, recorded=("l1", "l2"))
        result = run(
            service.apply_stock_decisions(
                ENTITY,
                INVOICE,
                [
                    {
                        "line_item_id": "l1",
                        "action": "new",
                        "name": " Wool Cap ",
                        "sku": "CAP",
                        "asset_account_id": "a1",
                    },
                    {"line_item_id": "l2", "action": "link", "product_id": "p1"},
                ],
            )
        )
        kinds = [c[0] for c in state["calls"]]
        assert kinds == ["new", "link"]
        assert state["calls"][0][2] == {
            "l1": {"name": "Wool Cap", "sku": "CAP", "asset_account_id": "a1"}
        }
        assert state["calls"][1][1] == [{"line_item_id": "l2", "product_id": "p1"}]
        assert result["recorded"] == 2 and result["not_recorded"] == []

    def test_expense_lines_do_nothing_and_are_not_reported_missing(
        self, monkeypatch, journals
    ):
        service, state = self._stocking(monkeypatch, recorded=())
        result = run(
            service.apply_stock_decisions(
                ENTITY, INVOICE, [{"line_item_id": "l2", "action": "expense"}]
            )
        )
        assert state["calls"] == []
        assert result["not_recorded"] == []

    def test_a_line_that_could_not_be_recorded_is_reported(self, monkeypatch, journals):
        service, _ = self._stocking(monkeypatch, recorded=())
        result = run(
            service.apply_stock_decisions(
                ENTITY, INVOICE, [{"line_item_id": "l1", "action": "track"}]
            )
        )
        assert result["not_recorded"] == ["l1"]

    @pytest.mark.parametrize(
        "decisions,message",
        [
            ([{"line_item_id": "nope", "action": "track"}], "does not belong"),
            ([{"line_item_id": "l1", "action": "link"}], "Choose a product"),
            ([{"line_item_id": "l1", "action": "burn"}], "Unknown stock action"),
            (
                [
                    {"line_item_id": "l1", "action": "track"},
                    {"line_item_id": "l1", "action": "expense"},
                ],
                "more than once",
            ),
        ],
    )
    def test_invalid_decisions_fail_before_anything_is_written(
        self, monkeypatch, journals, decisions, message
    ):
        service, state = self._stocking(monkeypatch)
        with pytest.raises(InvoiceRuleError, match=message):
            run(service.apply_stock_decisions(ENTITY, INVOICE, decisions))
        assert state["calls"] == []

    def test_sales_invoices_carry_no_stock(self, monkeypatch, journals):
        service, _ = self._stocking(monkeypatch, invoice_type="SALE")
        with pytest.raises(InvoiceRuleError, match="Only purchase"):
            run(
                service.apply_stock_decisions(
                    ENTITY, INVOICE, [{"line_item_id": "l1", "action": "track"}]
                )
            )
