"""Tests for the invoice service's lifecycle, deletion, editing and stock decisions.

The service talks to Supabase and the journal service; both are replaced here with fakes
so the tests pin down the *decisions* the service makes: what it writes, refuses and
validates. Invoices are documents, so no test here expects a journal to be posted.
"""

import asyncio
from uuid import UUID, uuid4

import pytest

from ai_agent.services import invoice_service as module
from ai_agent.services.invoice_rules import InvoiceRuleError
from ai_agent.services.invoice_service import InvoiceService

ENTITY = uuid4()
INVOICE = uuid4()


def run(coro):
    return asyncio.run(coro)


class FakeJournals:
    """Stands in for journal_service and records anything the invoice service calls."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        async def call(*args, **kwargs):
            self.calls.append(name)
            return {}

        return call


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
    file_path=None,
):
    """An InvoiceService whose storage calls are replaced by in-memory fakes."""
    service = InvoiceService()
    invoice = {
        "id": str(INVOICE),
        "entity_id": str(entity),
        "status": status,
        "invoice_type": invoice_type,
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

    async def list_payments(_id):
        return []

    monkeypatch.setattr(service, "get_invoice", get_invoice)
    monkeypatch.setattr(service, "update_invoice_status", update_invoice_status)
    monkeypatch.setattr(service, "list_payments", list_payments)
    return service, state


class TestSetStatus:
    @pytest.mark.parametrize(
        "current,target,invoice_type",
        [
            ("DRAFT", "OPEN", "PURCHASE"),
            ("DRAFT", "OPEN", "SALE"),
            ("OPEN", "PAID", "PURCHASE"),
            ("PAID", "OPEN", "SALE"),
            ("PAID", "VOID", "PURCHASE"),
        ],
    )
    def test_a_move_writes_the_status_and_posts_nothing(
        self, monkeypatch, journals, current, target, invoice_type
    ):
        service, state = make_service(
            monkeypatch, status=current, invoice_type=invoice_type
        )
        result = run(service.set_invoice_status(ENTITY, INVOICE, target))
        assert state["status_writes"] == [target]
        assert journals.calls == []
        assert result["previous_status"] == current
        assert result["invoice"]["status"] == target

    def test_an_invalid_move_is_refused_and_writes_nothing(self, monkeypatch, journals):
        service, state = make_service(monkeypatch, status="OPEN")
        with pytest.raises(InvoiceRuleError):
            run(service.set_invoice_status(ENTITY, INVOICE, "DRAFT"))
        assert state["status_writes"] == []

    def test_repeating_the_current_status_is_a_noop(self, monkeypatch, journals):
        service, state = make_service(monkeypatch, status="OPEN")
        run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert state["status_writes"] == []

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

    def test_a_voided_invoice_can_be_deleted(self, monkeypatch, journals):
        service, state = self._deleting(monkeypatch, status="VOID")
        run(service.delete_invoice(ENTITY, INVOICE))
        assert state["deleted"] and journals.calls == []


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

    @pytest.mark.parametrize("status", ["DRAFT", "OPEN", "PAID"])
    def test_recoding_a_line_posts_nothing(self, monkeypatch, journals, status):
        service, _ = self._updating(monkeypatch, status=status)
        run(
            service.update_invoice(
                ENTITY, INVOICE, {}, line_item_gl_updates={"l1": "gl"}
            )
        )
        assert journals.calls == []

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


class FakeTable:
    """Just enough of a PostgREST table: select / insert / delete, eq filters, order."""

    def __init__(self, rows):
        self.rows = rows
        self._op, self._filters, self._values = "select", [], None

    def select(self, *_):
        self._op = "select"
        return self

    def insert(self, values):
        self._op, self._values = "insert", values
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, column, value):
        self._filters.append((column, str(value)))
        return self

    def order(self, *_):
        return self

    def execute(self):
        hit = [
            r for r in self.rows if all(str(r.get(c)) == v for c, v in self._filters)
        ]
        if self._op == "insert":
            row = {"id": str(uuid4()), **self._values}
            self.rows.append(row)
            hit = [row]
        elif self._op == "delete":
            for r in hit:
                self.rows.remove(r)
        return type("R", (), {"data": hit})()


class TestPaymentLinks:
    def _linking(
        self,
        monkeypatch,
        *,
        status="OPEN",
        invoice_type="PURCHASE",
        gross=180,
        txn=None,
        links=(),
    ):
        service, state = make_service(
            monkeypatch, status=status, invoice_type=invoice_type
        )
        state["invoice"].update({"gross_amount": gross, "currency": "GBP"})
        txn_id = str(uuid4())
        tables = {
            "financial_transactions": [
                {
                    "id": txn_id,
                    "entity_id": str(ENTITY),
                    "direction": "out",
                    "excluded_reason": None,
                    "amount": 180,
                    "currency_code": "GBP",
                    **(txn or {}),
                }
            ],
            "invoice_payments": [dict(link) for link in links],
        }

        class Client:
            def table(self, name):
                return FakeTable(tables[name])

        service._client = Client()
        # Read the links from the fake tables rather than the stub make_service installs.
        monkeypatch.delattr(service, "list_payments")
        state["txn_id"] = UUID(txn_id)
        state["tables"] = tables
        return service, state

    def test_a_payment_covering_the_invoice_marks_it_paid(self, monkeypatch, journals):
        service, state = self._linking(monkeypatch)
        result = run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        (link,) = state["tables"]["invoice_payments"]
        assert link["invoice_id"] == str(INVOICE) and link["amount"] == 180
        assert link["matched_by"] == "user"
        assert result["status"] == "PAID" and state["status_writes"] == ["PAID"]
        assert journals.calls == []  # a match posts nothing

    def test_a_smaller_payment_marks_it_part_paid(self, monkeypatch, journals):
        service, state = self._linking(monkeypatch, txn={"amount": -90})
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        assert state["tables"]["invoice_payments"][0]["amount"] == 90
        assert state["status_writes"] == ["PARTIALLY_PAID"]

    def test_a_draft_is_linked_but_stays_to_review(self, monkeypatch, journals):
        service, state = self._linking(monkeypatch, status="DRAFT")
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        assert len(state["tables"]["invoice_payments"]) == 1
        assert state["status_writes"] == []

    def test_linking_the_same_pair_again_changes_nothing(self, monkeypatch, journals):
        service, state = self._linking(monkeypatch)
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        assert len(state["tables"]["invoice_payments"]) == 1

    @pytest.mark.parametrize(
        "kwargs,message",
        [
            ({"txn": {"direction": "in"}}, "money going out"),
            ({"txn": {"excluded_reason": "duplicate"}}, "left out of your books"),
            ({"status": "VOID"}, "not owed"),
        ],
    )
    def test_refused_links_write_nothing(self, monkeypatch, journals, kwargs, message):
        service, state = self._linking(monkeypatch, **kwargs)
        with pytest.raises(InvoiceRuleError, match=message):
            run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        assert state["tables"]["invoice_payments"] == []
        assert state["status_writes"] == []

    def test_a_transaction_already_paying_another_invoice_is_refused(
        self, monkeypatch, journals
    ):
        service, state = self._linking(monkeypatch)
        state["tables"]["invoice_payments"].append(
            {
                "invoice_id": str(uuid4()),
                "financial_transaction_id": str(state["txn_id"]),
            }
        )
        with pytest.raises(InvoiceRuleError, match="another invoice"):
            run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))

    def test_another_businesss_transaction_is_not_found(self, monkeypatch, journals):
        service, state = self._linking(monkeypatch, txn={"entity_id": str(uuid4())})
        with pytest.raises(ValueError, match="not found"):
            run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))

    def test_unlinking_the_last_payment_reopens_the_invoice(
        self, monkeypatch, journals
    ):
        service, state = self._linking(monkeypatch, status="PAID")
        state["tables"]["invoice_payments"].append(
            {
                "id": "p1",
                "invoice_id": str(INVOICE),
                "financial_transaction_id": str(state["txn_id"]),
                "amount": 180,
                "currency_code": "GBP",
            }
        )
        run(service.unlink_payment(ENTITY, INVOICE, state["txn_id"]))
        assert state["tables"]["invoice_payments"] == []
        assert state["status_writes"] == ["OPEN"]

    def test_unlinking_a_transaction_that_is_not_linked_is_refused(
        self, monkeypatch, journals
    ):
        service, state = self._linking(monkeypatch, status="PAID")
        with pytest.raises(InvoiceRuleError, match="not matched"):
            run(service.unlink_payment(ENTITY, INVOICE, state["txn_id"]))
        assert state["status_writes"] == []

    def test_finalising_a_draft_whose_payment_is_linked_goes_straight_to_paid(
        self, monkeypatch, journals
    ):
        service, state = self._linking(monkeypatch, status="DRAFT")
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"]))
        run(service.set_invoice_status(ENTITY, INVOICE, "OPEN"))
        assert state["status_writes"] == ["PAID"]


class TestSyncedInvoices:
    def test_a_synced_invoices_status_is_not_set_by_hand(self, monkeypatch, journals):
        service, state = make_service(monkeypatch, status="OPEN")
        state["invoice"]["origin"] = "revolut_merchant"
        with pytest.raises(InvoiceRuleError, match="synced from Revolut"):
            run(service.set_invoice_status(ENTITY, INVOICE, "PAID"))
        assert state["status_writes"] == []

    def test_a_synced_invoice_cannot_be_deleted_or_change_direction(
        self, monkeypatch, journals
    ):
        service, state = TestDelete()._deleting(monkeypatch, status="VOID")
        state["invoice"]["origin"] = "revolut_expense"
        with pytest.raises(InvoiceRuleError, match="next sync"):
            run(service.delete_invoice(ENTITY, INVOICE))
        assert not state["deleted"]

        editor, editing = TestUpdate()._updating(monkeypatch, status="DRAFT")
        editing["invoice"]["origin"] = "revolut_merchant"
        with pytest.raises(InvoiceRuleError, match="comes from Revolut"):
            run(editor.update_invoice(ENTITY, INVOICE, {"invoice_type": "SALE"}))
        # Notes stay the business's own.
        run(editor.update_invoice(ENTITY, INVOICE, {"notes": "from Revolut"}))


class TestSyncedPayments:
    def test_linking_a_synced_invoice_keeps_revoluts_status(
        self, monkeypatch, journals
    ):
        service, state = TestPaymentLinks()._linking(
            monkeypatch, status="PAID", invoice_type="SALE", txn={"direction": "in"}
        )
        state["invoice"]["origin"] = "revolut_merchant"
        run(service.link_payment(ENTITY, INVOICE, state["txn_id"], "sync"))
        assert state["tables"]["invoice_payments"][0]["matched_by"] == "sync"
        # Unlinking does not reopen it either: Revolut says it is paid.
        run(service.unlink_payment(ENTITY, INVOICE, state["txn_id"]))
        assert state["status_writes"] == []
