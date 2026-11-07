"""Every journal type the engine writes: its lines, accounts, status and guards.

The journal service runs for real down to its database client, which is a stand-in that keeps
what is written in memory, so `_create_journal` (and its balance check) runs for every journal.
Each test states what the books should say for one kind of source record. Expected figures are
worked out by hand in the test, never read back from the code under test.

Behaviour that looks wrong is not pinned here as correct; it is listed in docs/accounting.md
("Known questions") instead.
"""

import asyncio
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID, uuid4

import pytest

from ai_agent.services import account_mapping as accts
from ai_agent.services.journal_service import (
    JournalError,
    JournalService,
    assert_valid_lines,
)

ENTITY = UUID("00000000-0000-0000-0000-0000000000e1")
OTHER_ENTITY = UUID("00000000-0000-0000-0000-0000000000e2")


# ── A stand-in database ─────────────────────────────────────────────────────────


class _Result:
    def __init__(self, data: Any):
        self.data = data


class _Query:
    def __init__(self, store: "FakeDb", table: str):
        self.store, self.table = store, table
        self.filters: List[Tuple[str, str, Any]] = []
        self.op = "select"
        self.payload: Any = None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, value):
        self.filters.append(("eq", col, value))
        return self

    def is_(self, col, value):
        self.filters.append(("is", col, value))
        return self

    def in_(self, col, values):
        self.filters.append(("in", col, values))
        return self

    def limit(self, *_a):
        return self

    def order(self, *_a, **_k):
        return self

    def insert(self, data):
        self.op, self.payload = "insert", data
        return self

    def update(self, data):
        self.op, self.payload = "update", data
        return self

    def _match(self, row: Dict[str, Any]) -> bool:
        for kind, col, value in self.filters:
            if kind == "eq" and str(row.get(col)) != str(value):
                return False
            if kind == "is" and value == "null" and row.get(col) is not None:
                return False
            if kind == "in" and str(row.get(col)) not in {str(v) for v in value}:
                return False
        return True

    def execute(self):
        rows = self.store.tables.setdefault(self.table, [])
        if self.op == "insert":
            items = self.payload if isinstance(self.payload, list) else [self.payload]
            rows.extend(dict(i) for i in items)
            return _Result(items)
        matched = [r for r in rows if self._match(r)]
        if self.op == "update":
            for r in matched:
                r.update(self.payload)
        return _Result(matched)


class _Rpc:
    def __init__(self, store: "FakeDb", name: str, params: Dict[str, Any]):
        self.store, self.name, self.params = store, name, params

    def execute(self):
        assert self.name == "upsert_journal_with_lines", self.name
        p = self.params
        key = (
            p["p_entity_id"],
            p["p_source_type"],
            p["p_source_id"],
            p["p_journal_type"],
        )
        journal = self.store.journal_by_key.get(key)
        if journal is None:
            journal = {"id": str(uuid4())}
            self.store.journal_by_key[key] = journal
            self.store.tables.setdefault("journals", []).append(journal)
        journal.update(
            {
                "entity_id": p["p_entity_id"],
                "journal_date": p["p_journal_date"],
                "journal_type": p["p_journal_type"],
                "description": p["p_description"],
                "source_type": p["p_source_type"],
                "source_id": p["p_source_id"],
                "status": p["p_status"],
                "metadata": p["p_metadata"],
                "line_items": [dict(li) for li in p["p_line_items"]],
            }
        )
        return _Result(journal["id"])


class FakeDb:
    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {}
        self.journal_by_key: Dict[tuple, Dict[str, Any]] = {}

    def table(self, name: str) -> _Query:
        return _Query(self, name)

    def rpc(self, name: str, params: Dict[str, Any]) -> _Rpc:
        return _Rpc(self, name, params)


class Ledger(JournalService):
    """The journal service over FakeDb, with its source records given directly."""

    def __init__(self) -> None:
        super().__init__()
        self.db = FakeDb()
        self._client = self.db
        self.payments: Dict[str, Dict[str, Any]] = {}
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.txns: Dict[str, Dict[str, Any]] = {}
        self.refund_order: Optional[UUID] = None

    @property
    def client(self):
        return self.db

    async def _get_account_id(self, entity_id, account_number, *a, **k):
        return f"acct-{account_number}"

    async def _fetch_payment_with_fees(self, payment_id):
        return self.payments.get(str(payment_id))

    async def _fetch_order(self, order_id):
        return self.orders.get(str(order_id))

    async def _fetch_financial_transaction(self, txn_id):
        return self.txns.get(str(txn_id))

    async def _find_order_for_refund_transaction(self, entity_id, txn):
        return self.refund_order

    async def _find_journal(self, entity_id, source_type, source_id, journal_type):
        return self.db.journal_by_key.get(
            (str(entity_id), source_type, str(source_id), journal_type)
        )

    async def _fetch_journal(self, journal_id):
        for j in self.db.tables.get("journals", []):
            if j["id"] == str(journal_id):
                return j
        return None

    async def _fetch_journal_line_items(self, journal_id):
        journal = await self._fetch_journal(journal_id)
        return list(journal["line_items"]) if journal else []

    # ── helpers for tests ──

    def payment(self, **fields: Any) -> UUID:
        pid = uuid4()
        self.payments[str(pid)] = {
            "id": str(pid),
            "currency": "GBP",
            "_fee_amount": 0,
            "paid_on": "2026-10-01T10:00:00+00:00",
            **fields,
        }
        return pid

    def order(self, **fields: Any) -> str:
        oid = str(uuid4())
        self.orders[oid] = {
            "id": oid,
            "currency": "GBP",
            "order_number": "#T2001",
            "subtotal_amount": 0,
            "discount_total_amount": 0,
            "shipping_total_amount": 0,
            "tax_total_amount": 0,
            **fields,
        }
        return oid

    def txn(self, **fields: Any) -> UUID:
        tid = uuid4()
        self.txns[str(tid)] = {
            "id": str(tid),
            "source": "revolut",
            "currency_code": "GBP",
            "base_currency_code": "GBP",
            "fx_rate": None,
            "occurred_at": "2026-10-02T10:00:00+00:00",
            "description": "",
            "counterparty_name": "",
            "metadata": {},
            **fields,
        }
        self.txns[str(tid)].setdefault("base_amount", self.txns[str(tid)].get("amount"))
        return tid


def run(coro):
    return asyncio.run(coro)


def lines(journal: Dict[str, Any]) -> Dict[str, Tuple[float, float]]:
    """{account number: (debit, credit)}, summed per account."""
    out: Dict[str, List[float]] = {}
    for li in journal["line_items"]:
        acct = str(li["account_id"]).replace("acct-", "")
        d, c = out.setdefault(acct, [0.0, 0.0])
        out[acct] = [
            round(d + float(li["debit"]), 2),
            round(c + float(li["credit"]), 2),
        ]
    return {k: (v[0], v[1]) for k, v in out.items()}


def assert_balanced(journal: Dict[str, Any]) -> None:
    debit = sum(Decimal(str(li["debit"])) for li in journal["line_items"])
    credit = sum(Decimal(str(li["credit"])) for li in journal["line_items"])
    assert abs(debit - credit) <= Decimal("0.01"), (debit, credit)


@pytest.fixture
def ledger() -> Ledger:
    return Ledger()


# ── The central guard ───────────────────────────────────────────────────────────


class TestLineRules:
    def test_balanced_lines_pass(self):
        assert_valid_lines(
            [
                {"account_id": "a", "debit": 10, "credit": 0},
                {"account_id": "b", "debit": 0, "credit": 10},
            ],
            "test",
        )

    def test_one_penny_of_rounding_passes(self):
        assert_valid_lines(
            [
                {"account_id": "a", "debit": 70.94, "credit": 0},
                {"account_id": "b", "debit": 0, "credit": 70.95},
            ],
            "test",
        )

    @pytest.mark.parametrize(
        "bad, message",
        [
            (
                [
                    {"account_id": "a", "debit": 10, "credit": 0},
                    {"account_id": "b", "debit": 0, "credit": 9},
                ],
                "does not balance",
            ),
            (
                [
                    {"account_id": "", "debit": 10, "credit": 0},
                    {"account_id": "b", "debit": 0, "credit": 10},
                ],
                "no account",
            ),
            (
                [
                    {"account_id": "a", "debit": -10, "credit": 0},
                    {"account_id": "b", "debit": 0, "credit": -10},
                ],
                "negative",
            ),
            (
                [
                    {"account_id": "a", "debit": 10, "credit": 10},
                    {"account_id": "b", "debit": 0, "credit": 0},
                ],
                "debit or a credit",
            ),
        ],
        ids=["unbalanced", "no-account", "negative", "both-sides"],
    )
    def test_bad_lines_are_refused(self, bad, message):
        with pytest.raises(JournalError, match=message):
            assert_valid_lines(bad, "test")

    def test_an_unbalanced_journal_never_reaches_the_database(self, ledger):
        with pytest.raises(JournalError, match="does not balance"):
            run(
                ledger._create_journal(
                    entity_id=ENTITY,
                    journal_type="adjustment",
                    journal_date="2026-10-01",
                    description="x",
                    source_type="manual",
                    source_id=None,
                    status="posted",
                    line_items=[
                        {"account_id": "a", "debit": 10, "credit": 0},
                        {"account_id": "b", "debit": 0, "credit": 5},
                    ],
                )
            )
        assert ledger.db.tables.get("journals") is None


# ── Accrual: a captured payment ─────────────────────────────────────────────────


class TestAccrual:
    def test_an_order_payment_splits_into_revenue_shipping_tax_and_fee(self, ledger):
        order = ledger.order(
            subtotal_amount=100,
            discount_total_amount=10,
            shipping_total_amount=5,
            tax_total_amount=3,
        )
        pid = ledger.payment(amount=98, _fee_amount=2.5, order_id=order)
        journal = run(ledger.create_accrual_journal(ENTITY, pid))
        assert lines(journal) == {
            accts.MERCHANT_CLEARING: (95.5, 0),  # what the gateway will pay out
            accts.BANK_CHARGES: (2.5, 0),  # its fee, recognised now
            accts.REVENUE_ECOMMERCE: (0, 90),  # subtotal less discounts
            accts.SHIPPING_REVENUE: (0, 5),
            accts.VAT_PAYABLE: (0, 3),
        }
        assert journal["status"] == "posted"
        assert journal["journal_type"] == "accrual"
        assert journal["journal_date"] == "2026-10-01T10:00:00+00:00"  # paid on

    def test_the_fee_can_come_from_the_net_amount(self, ledger):
        order = ledger.order(subtotal_amount=50)
        pid = ledger.payment(amount=50, net_amount=48.2, order_id=order)
        journal = run(ledger.create_accrual_journal(ENTITY, pid))
        assert lines(journal)[accts.BANK_CHARGES] == (1.8, 0)
        assert lines(journal)[accts.MERCHANT_CLEARING] == (48.2, 0)

    def test_without_an_order_the_whole_payment_is_revenue(self, ledger):
        pid = ledger.payment(amount=40)
        journal = run(ledger.create_accrual_journal(ENTITY, pid))
        assert lines(journal) == {
            accts.MERCHANT_CLEARING: (40, 0),
            accts.REVENUE_ECOMMERCE: (0, 40),
        }

    def test_a_payment_that_does_not_cover_its_order_is_refused(self, ledger):
        """A part payment would credit the whole order's revenue against part of the cash."""
        order = ledger.order(subtotal_amount=100)
        pid = ledger.payment(amount=60, order_id=order)
        with pytest.raises(JournalError, match="does not balance"):
            run(ledger.create_accrual_journal(ENTITY, pid))

    def test_a_fee_larger_than_the_payment_is_refused(self, ledger):
        pid = ledger.payment(amount=5, _fee_amount=6)
        with pytest.raises(JournalError, match="fee exceeds"):
            run(ledger.create_accrual_journal(ENTITY, pid))

    def test_a_foreign_payment_on_a_gbp_order_uses_its_gbp_amount(self, ledger):
        order = ledger.order(subtotal_amount=80)
        pid = ledger.payment(
            amount=100,
            currency="USD",
            _fee_amount=4,
            base_amount=80,
            base_currency="GBP",
            order_id=order,
        )
        journal = run(ledger.create_accrual_journal(ENTITY, pid))
        # The fee is scaled by the same rate: 4 USD of 100 -> 3.20 GBP of 80.
        assert lines(journal) == {
            accts.MERCHANT_CLEARING: (76.8, 0),
            accts.BANK_CHARGES: (3.2, 0),
            accts.REVENUE_ECOMMERCE: (0, 80),
        }
        assert {li["currency"] for li in journal["line_items"]} == {"GBP"}

    def test_a_foreign_payment_with_no_gbp_amount_is_refused(self, ledger):
        order = ledger.order(subtotal_amount=80)
        pid = ledger.payment(amount=100, currency="USD", order_id=order)
        with pytest.raises(JournalError, match="Currency mismatch"):
            run(ledger.create_accrual_journal(ENTITY, pid))

    def test_journaling_twice_gives_the_same_journal(self, ledger):
        pid = ledger.payment(amount=40)
        first = run(ledger.create_accrual_journal(ENTITY, pid))
        second = run(ledger.create_accrual_journal(ENTITY, pid))
        assert first["id"] == second["id"]
        assert len(ledger.db.tables["journals"]) == 1

    def test_an_unknown_payment_is_refused(self, ledger):
        with pytest.raises(JournalError, match="Payment not found"):
            run(ledger.create_accrual_journal(ENTITY, uuid4()))


# ── Settlement: a gateway payout reaching the bank ──────────────────────────────


class TestSettlement:
    def test_a_payout_moves_clearing_to_cash(self, ledger):
        tid = ledger.txn(
            direction="in",
            transaction_type="transfer",
            amount=300,
            description="Stripe payout",
        )
        journal = run(ledger.create_settlement_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.REVOLUT_GBP: (300, 0),
            accts.MERCHANT_CLEARING: (0, 300),
        }
        assert journal["status"] == "posted"

    def test_a_usd_payout_lands_in_the_usd_account(self, ledger):
        tid = ledger.txn(
            direction="in", transaction_type="transfer", amount=50, currency_code="USD"
        )
        journal = run(ledger.create_settlement_journal(ENTITY, tid))
        assert accts.REVOLUT_USD in lines(journal)

    @pytest.mark.parametrize(
        "direction, txn_type", [("out", "transfer"), ("in", "payment")]
    )
    def test_anything_but_an_inbound_transfer_is_refused(
        self, ledger, direction, txn_type
    ):
        tid = ledger.txn(direction=direction, transaction_type=txn_type, amount=10)
        with pytest.raises(JournalError, match="Expected inbound transfer"):
            run(ledger.create_settlement_journal(ENTITY, tid))


# ── Funding: money in that is not a sale through a gateway ──────────────────────


class TestFunding:
    def _neutral(self, monkeypatch, *, personal=False, wholesale=False, collab=False):
        monkeypatch.setattr(Ledger, "_is_personal_funding", lambda *a: personal)
        monkeypatch.setattr(Ledger, "_is_wholesale_payment", lambda *a: wholesale)
        monkeypatch.setattr(Ledger, "_is_brand_collaboration", lambda *a: collab)

    @pytest.mark.parametrize(
        "kind, credit",
        [
            ("personal", accts.DIRECTORS_LOAN),
            ("wholesale", accts.REVENUE_WHOLESALE),
            ("collab", accts.BRAND_COLLAB_INCOME),
            ("other", accts.REVENUE_ECOMMERCE),
        ],
    )
    def test_the_credit_depends_on_what_the_money_is(
        self, ledger, monkeypatch, kind, credit
    ):
        self._neutral(
            monkeypatch,
            personal=kind == "personal",
            wholesale=kind == "wholesale",
            collab=kind == "collab",
        )
        tid = ledger.txn(direction="in", transaction_type="transfer", amount=250)
        journal = run(ledger.create_funding_journal(ENTITY, tid))
        assert lines(journal) == {accts.REVOLUT_GBP: (250, 0), credit: (0, 250)}
        assert journal["status"] == "posted"

    def test_a_foreign_amount_with_no_rate_is_a_draft(self, ledger, monkeypatch):
        self._neutral(monkeypatch)
        tid = ledger.txn(
            direction="in",
            transaction_type="transfer",
            amount=100,
            currency_code="EUR",
            base_amount=100,
        )
        journal = run(ledger.create_funding_journal(ENTITY, tid))
        assert journal["status"] == "draft"
        assert_balanced(journal)

    def test_a_foreign_amount_with_a_rate_posts_in_gbp(self, ledger, monkeypatch):
        self._neutral(monkeypatch)
        tid = ledger.txn(
            direction="in",
            transaction_type="transfer",
            amount=100,
            currency_code="EUR",
            base_amount=86,
            fx_rate=1.1628,
        )
        journal = run(ledger.create_funding_journal(ENTITY, tid))
        assert journal["status"] == "posted"
        assert lines(journal) == {
            accts.REVOLUT_GBP: (86, 0),
            accts.REVENUE_ECOMMERCE: (0, 86),
        }


# ── Expense: money out ──────────────────────────────────────────────────────────


class TestExpense:
    def test_a_categorised_expense_posts_to_its_account(self, ledger):
        tid = ledger.txn(
            direction="out",
            transaction_type="payment",
            amount=20.69,
            description="Shopify",
            counterparty_name="Shopify",
        )
        journal = run(ledger.create_expense_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.TECHNOLOGY_SAAS: (20.69, 0),
            accts.REVOLUT_GBP: (0, 20.69),
        }
        assert journal["status"] == "posted"

    def test_an_uncategorised_expense_is_a_draft_on_8090(self, ledger):
        tid = ledger.txn(
            direction="out",
            transaction_type="payment",
            amount=12,
            description="zqxv",
            counterparty_name="zqxv",
        )
        journal = run(ledger.create_expense_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.MISCELLANEOUS_EXPENSE: (12, 0),
            accts.REVOLUT_GBP: (0, 12),
        }
        assert journal["status"] == "draft"

    def test_a_paypal_expense_is_paid_from_the_paypal_account(self, ledger):
        tid = ledger.txn(
            source="paypal",
            direction="out",
            transaction_type="payment",
            amount=8.4,
            description="Slack",
        )
        journal = run(ledger.create_expense_journal(ENTITY, tid))
        assert lines(journal)[accts.PAYPAL_ACCOUNT] == (0, 8.4)

    def test_a_foreign_charge_from_the_gbp_account_posts_its_gbp_amount(self, ledger):
        tid = ledger.txn(
            direction="out",
            transaction_type="payment",
            amount=25,
            currency_code="USD",
            base_amount=19.6,
            fx_rate=1.2755,
            description="OpenAI",
        )
        journal = run(ledger.create_expense_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.TECHNOLOGY_SAAS: (19.6, 0),
            accts.REVOLUT_GBP: (0, 19.6),
        }

    def test_a_refund_of_a_known_order_clears_merchant_clearing(self, ledger):
        """Its revenue side was already reversed by the order's refund reversal."""
        ledger.refund_order = uuid4()
        tid = ledger.txn(
            direction="out", transaction_type="refund", amount=30, description="Refund"
        )
        journal = run(ledger.create_expense_journal(ENTITY, tid))
        assert journal["journal_type"] == "refund_settlement"
        assert lines(journal) == {
            accts.MERCHANT_CLEARING: (30, 0),
            accts.REVOLUT_GBP: (0, 30),
        }

    @pytest.mark.parametrize(
        "txn_type, direction",
        [
            ("payout", "out"),
            ("payment", "in"),
            ("fx_conversion", "out"),
            ("reserve_hold", "out"),
            ("reserve_release", "in"),
        ],
    )
    def test_what_is_not_an_expense_is_refused(self, ledger, txn_type, direction):
        tid = ledger.txn(direction=direction, transaction_type=txn_type, amount=10)
        with pytest.raises(JournalError):
            run(ledger.create_expense_journal(ENTITY, tid))

    def test_force_rewrites_the_same_journal_after_a_reclassification(self, ledger):
        tid = ledger.txn(
            direction="out", transaction_type="payment", amount=12, description="zqxv"
        )
        first = run(ledger.create_expense_journal(ENTITY, tid))
        ledger.txns[str(tid)]["metadata"] = {"expense_category": "software"}
        again = run(ledger.create_expense_journal(ENTITY, tid))
        assert lines(again) == lines(first)  # not forced: unchanged
        forced = run(ledger.create_expense_journal(ENTITY, tid, force=True))
        assert forced["id"] == first["id"]
        assert lines(forced)[accts.TECHNOLOGY_SAAS] == (12, 0)
        assert forced["status"] == "posted"


# ── Sales receipt and refund received ───────────────────────────────────────────


class TestSalesReceiptAndRefund:
    def test_a_paypal_sale_with_no_fee(self, ledger, monkeypatch):
        monkeypatch.setattr(Ledger, "_is_brand_collaboration", lambda *a: False)
        tid = ledger.txn(
            source="paypal",
            direction="in",
            transaction_type="payment",
            amount=60,
            description="Customer",
        )
        journal = run(ledger.create_sales_receipt_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.PAYPAL_ACCOUNT: (60, 0),
            accts.REVENUE_ECOMMERCE: (0, 60),
        }
        assert journal["status"] == "posted"

    def test_a_paypal_sale_with_a_fee_balances(self, ledger, monkeypatch):
        monkeypatch.setattr(Ledger, "_is_brand_collaboration", lambda *a: False)
        tid = ledger.txn(
            source="paypal",
            direction="in",
            transaction_type="payment",
            amount=60,
            metadata={"fee_amount": {"value": "-2.34", "currency_code": "GBP"}},
        )
        journal = run(ledger.create_sales_receipt_journal(ENTITY, tid))
        assert_balanced(journal)
        assert lines(journal)[accts.BANK_CHARGES] == (2.34, 0)

    def test_a_refund_received_credits_what_it_refunds(self, ledger):
        tid = ledger.txn(
            direction="in", transaction_type="refund", amount=26.11, description="UPS"
        )
        journal = run(ledger.create_refund_journal(ENTITY, tid))
        assert lines(journal) == {
            accts.REVOLUT_GBP: (26.11, 0),
            accts.COGS_DUTIES: (0, 26.11),  # UPS is import duties
        }
        assert journal["status"] == "posted"


# ── FX conversion ───────────────────────────────────────────────────────────────


class TestFxConversion:
    def test_a_conversion_balances_and_books_its_fee_as_fx_loss(self, ledger):
        tid = ledger.txn(
            transaction_type="fx_conversion",
            direction="in",
            amount=100,
            currency_code="EUR",
            description="Exchanged from GBP",
            metadata={"fee": 1.5},
        )
        journal = run(ledger.create_fx_conversion_journal(ENTITY, tid))
        assert_balanced(journal)
        assert lines(journal)[accts.REVOLUT_EUR] == (100, 0)
        assert lines(journal)[accts.FX_LOSS] == (1.5, 0)
        assert lines(journal)[accts.REVOLUT_GBP] == (0, 101.5)
        assert {li["currency"] for li in journal["line_items"]} == {"GBP"}


# ── Cost of goods sold and refunds of orders ────────────────────────────────────


def _sold(ledger: Ledger, order_id: str, items: List[Tuple[float, float]], on: str):
    for qty, cost in items:
        line_id = str(uuid4())
        ledger.db.tables.setdefault("order_line_items", []).append(
            {"id": line_id, "order_id": order_id}
        )
        ledger.db.tables.setdefault("inventory_movements", []).append(
            {
                "id": str(uuid4()),
                "inventory_item_id": str(uuid4()),
                "transaction_type": "SALE",
                "reference_table": "order_line_items",
                "reference_id": line_id,
                "quantity": -qty,
                "unit_cost": cost,
                "movement_date": on,
                "superseded_at": None,
            }
        )


class TestCogs:
    def test_cost_is_the_sale_time_cost_of_what_left(self, ledger):
        order = str(uuid4())
        ledger.db.tables["orders"] = [{"id": order, "order_number": "#T2002"}]
        _sold(ledger, order, [(2, 12.5), (1, 7)], on="2026-10-03T00:00:00+00:00")
        journal = run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order)))
        assert lines(journal) == {
            accts.COGS_FINISHED_GOODS: (32, 0),
            accts.INVENTORY_FINISHED_GOODS: (0, 32),
        }
        assert journal["status"] == "posted"

    def test_uncosted_stock_posts_nothing(self, ledger):
        order = str(uuid4())
        _sold(ledger, order, [(1, 0)], on="2026-10-03T00:00:00+00:00")
        assert run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order))) is None

    def test_a_sale_before_the_restated_period_ended_posts_nothing(self, ledger):
        order = str(uuid4())
        _sold(ledger, order, [(1, 10)], on="2026-07-10T00:00:00+00:00")
        assert run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order))) is None

    def test_superseded_movements_do_not_count_twice(self, ledger):
        order = str(uuid4())
        _sold(ledger, order, [(1, 10)], on="2026-10-03T00:00:00+00:00")
        duplicate = dict(ledger.db.tables["inventory_movements"][0])
        duplicate["superseded_at"] = "2026-10-04T00:00:00+00:00"
        ledger.db.tables["inventory_movements"].append(duplicate)
        journal = run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order)))
        assert lines(journal)[accts.COGS_FINISHED_GOODS] == (10, 0)


class TestRefundReversal:
    def _order(self, ledger: Ledger, total: float, refunded: float) -> str:
        order = str(uuid4())
        ledger.db.tables.setdefault("orders", []).append(
            {
                "id": order,
                "order_number": "#T2003",
                "created_at": "2026-10-05T00:00:00+00:00",
                "grand_total_amount": total,
                "refunded_total_amount": refunded,
            }
        )
        return order

    def test_a_full_refund_reverses_revenue_cost_and_stock(self, ledger):
        order = self._order(ledger, total=50, refunded=50)
        _sold(ledger, order, [(1, 20)], on="2026-10-05T00:00:00+00:00")
        cogs = run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order)))
        result = run(ledger.create_refund_reversal_journal(ENTITY, UUID(order)))
        assert lines(result["revenue_reversal"]) == {
            accts.SALES_RETURNS: (50, 0),
            accts.MERCHANT_CLEARING: (0, 50),
        }
        assert cogs["status"] == "reversed"  # voided, not countered
        returns = [
            m
            for m in ledger.db.tables["inventory_movements"]
            if m["transaction_type"] == "RETURN"
        ]
        assert result["returned_movements"] == 1 and returns[0]["quantity"] == 1

    def test_a_partial_refund_drafts_an_estimate_and_leaves_stock(self, ledger):
        order = self._order(ledger, total=100, refunded=25)
        _sold(ledger, order, [(2, 20)], on="2026-10-05T00:00:00+00:00")
        cogs = run(ledger.create_inventory_cogs_journal(ENTITY, UUID(order)))
        result = run(ledger.create_refund_reversal_journal(ENTITY, UUID(order)))
        estimate = result["cogs_reversal"]["draft_estimate"]
        assert estimate["status"] == "draft"
        assert lines(estimate) == {
            accts.INVENTORY_FINISHED_GOODS: (10, 0),  # 25% of the 40 cost
            accts.COGS_FINISHED_GOODS: (0, 10),
        }
        assert cogs["status"] == "posted"
        assert result["returned_movements"] == 0

    def test_a_second_run_does_nothing_more(self, ledger):
        order = self._order(ledger, total=50, refunded=50)
        run(ledger.create_refund_reversal_journal(ENTITY, UUID(order)))
        again = run(ledger.create_refund_reversal_journal(ENTITY, UUID(order)))
        assert again["already_processed"] is True


# ── Reversal ────────────────────────────────────────────────────────────────────


class TestReverse:
    def _posted(self, ledger: Ledger) -> Dict[str, Any]:
        pid = ledger.payment(amount=40)
        journal: Dict[str, Any] = run(ledger.create_accrual_journal(ENTITY, pid))
        return journal

    def test_reversing_voids_the_journal_without_a_counter_entry(self, ledger):
        journal = self._posted(ledger)
        result = run(ledger.reverse_journal(ENTITY, UUID(journal["id"])))
        assert result["status"] == "reversed" and result["amount_removed"] == 40
        assert journal["status"] == "reversed"
        assert len(ledger.db.tables["journals"]) == 1

    def test_only_a_posted_journal_can_be_reversed(self, ledger):
        journal = self._posted(ledger)
        run(ledger.reverse_journal(ENTITY, UUID(journal["id"])))
        with pytest.raises(JournalError, match="status 'reversed'"):
            run(ledger.reverse_journal(ENTITY, UUID(journal["id"])))

    def test_another_business_cannot_reverse_it(self, ledger):
        journal = self._posted(ledger)
        with pytest.raises(JournalError, match="does not belong"):
            run(ledger.reverse_journal(OTHER_ENTITY, UUID(journal["id"])))
        assert journal["status"] == "posted"


# ── Every type balances ─────────────────────────────────────────────────────────


def test_every_journal_written_in_this_file_balances(ledger, monkeypatch):
    """A sweep over one of each, through the same guard the database applies."""
    monkeypatch.setattr(Ledger, "_is_personal_funding", lambda *a: False)
    monkeypatch.setattr(Ledger, "_is_wholesale_payment", lambda *a: False)
    monkeypatch.setattr(Ledger, "_is_brand_collaboration", lambda *a: False)
    order = ledger.order(subtotal_amount=33.33, shipping_total_amount=4.99)
    run(
        ledger.create_accrual_journal(
            ENTITY, ledger.payment(amount=38.32, _fee_amount=1.11, order_id=order)
        )
    )
    run(
        ledger.create_settlement_journal(
            ENTITY,
            ledger.txn(direction="in", transaction_type="transfer", amount=37.21),
        )
    )
    run(
        ledger.create_funding_journal(
            ENTITY,
            ledger.txn(direction="in", transaction_type="transfer", amount=12.34),
        )
    )
    run(
        ledger.create_expense_journal(
            ENTITY,
            ledger.txn(
                direction="out",
                transaction_type="payment",
                amount=9.99,
                description="Slack",
            ),
        )
    )
    run(
        ledger.create_refund_journal(
            ENTITY,
            ledger.txn(
                direction="in",
                transaction_type="refund",
                amount=3.21,
                description="Slack",
            ),
        )
    )
    run(
        ledger.create_fx_conversion_journal(
            ENTITY,
            ledger.txn(
                transaction_type="fx_conversion",
                direction="in",
                amount=10,
                currency_code="EUR",
                metadata={"fee": 0.07},
            ),
        )
    )
    journals = ledger.db.tables["journals"]
    assert len(journals) == 6
    for journal in journals:
        assert_balanced(journal)
