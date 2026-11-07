"""Foreign-currency PayPal items: loaded with their GBP amount pending, then given
PayPal's own rate from the T0200 conversion items, without touching the ledger."""

import asyncio
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

import pytest

from ai_agent.normalization.models import CanonicalFinancialTransaction
from ai_agent.normalization.paypal_normalizer import PayPalNormalizer
from ai_agent.normalization.persistence import PersistenceService
from ai_agent.services.journal_service import JournalService
from ai_agent.services.paypal_cleaning_service import PayPalCleaningService

ENTITY = UUID("00000000-0000-0000-0000-000000000001")


def _payload(currency: str, value: str, code: str = "T0006") -> Dict[str, Any]:
    return {
        "transaction_info": {
            "transaction_id": "TX1",
            "transaction_event_code": code,
            "transaction_initiation_date": "2026-01-02T10:00:00+0000",
            "transaction_amount": {"currency_code": currency, "value": value},
            "transaction_status": "S",
        },
        "payer_info": {},
        "cart_info": {},
    }


def _normalize(currency: str, value: str) -> CanonicalFinancialTransaction:
    result = PayPalNormalizer(entity_id=ENTITY).normalize(
        "financial_transaction", "TX1", _payload(currency, value), uuid4()
    )
    assert result.success, result.error_message
    canonical = result.canonical
    assert isinstance(canonical, CanonicalFinancialTransaction)
    return canonical


# ── Normaliser ──────────────────────────────────────────────────────────────


def test_gbp_item_has_its_own_amount_as_base():
    txn = _normalize("GBP", "-25.00")
    assert txn.base_amount == Decimal("25.00")
    assert txn.fx_rate is None
    assert "fx_pending" not in txn.metadata


def test_foreign_item_is_stored_with_its_gbp_amount_pending():
    """It used to fail validation (base_amount None), so the payment never loaded."""
    txn = _normalize("USD", "-151.20")
    assert txn.currency_code == "USD"
    assert txn.amount == Decimal("151.20")
    assert txn.base_amount == Decimal("151.20")  # provisional, NOT NULL column
    assert txn.fx_rate is None  # unconfirmed: the journal engine drafts it
    assert txn.metadata["fx_pending"] is True


# ── conversion_rates (pure) ─────────────────────────────────────────────────


def _row(
    id: str,
    code: str,
    currency: str,
    amount: str,
    direction: str,
    *,
    fx_rate: Optional[str] = None,
    excluded: bool = False,
    invoice_id: Optional[str] = None,
    created_at: str = "2026-01-02T10:00:00+00:00",
) -> Dict[str, Any]:
    meta: Dict[str, Any] = {"transaction_event_code": code}
    if invoice_id:
        meta["invoice_id"] = invoice_id
    if currency != "GBP" and code != "T0200" and fx_rate is None:
        meta["fx_pending"] = True
    return {
        "id": id,
        "amount": amount,
        "currency_code": currency,
        "base_currency_code": "GBP",
        "base_amount": amount,
        "fx_rate": fx_rate,
        "direction": direction,
        "created_at": created_at,
        "metadata": meta,
        "excluded_reason": "noise" if excluded else None,
    }


def _usd_purchase(**kw: Any) -> List[Dict[str, Any]]:
    return [
        _row("pay", "T0006", "USD", "151.20", "out", **kw),
        _row("c-usd", "T0200", "USD", "151.20", "in"),
        _row("c-gbp", "T0200", "GBP", "115.16", "out"),
    ]


def test_rate_comes_from_the_gbp_conversion_item():
    rates = PayPalCleaningService().conversion_rates(_usd_purchase())
    fx, base = rates["pay"]
    assert base == Decimal("115.16")
    assert fx == (Decimal("151.20") / Decimal("115.16")).quantize(Decimal("0.00000001"))
    assert set(rates) == {"pay"}  # the conversion items themselves get nothing


def test_a_sale_converted_into_gbp_uses_the_gbp_item_coming_in():
    rows = [
        _row("sale", "T0011", "EUR", "58.00", "in", invoice_id="INV-1"),
        _row("c-eur", "T0200", "EUR", "58.00", "out", invoice_id="INV-1"),
        _row("c-gbp", "T0200", "GBP", "48.14", "in", invoice_id="INV-1"),
    ]
    assert PayPalCleaningService().conversion_rates(rows)["sale"][1] == Decimal("48.14")


def test_conversion_items_already_excluded_still_count():
    rows = _usd_purchase()
    rows[1]["excluded_reason"] = rows[2]["excluded_reason"] = (
        "Currency conversion noise"
    )
    assert "pay" in PayPalCleaningService().conversion_rates(rows)


def test_a_partial_conversion_is_left_pending():
    """€72.58 paid, only €22.58 of it converted: the GBP item is not the payment's value."""
    rows = [
        _row("pay", "T0003", "EUR", "72.58", "out"),
        _row("c-eur", "T0200", "EUR", "22.58", "in"),
        _row("c-gbp", "T0200", "GBP", "19.72", "out"),
    ]
    assert PayPalCleaningService().conversion_rates(rows) == {}


def test_no_gbp_conversion_is_left_pending():
    """Converted EUR to USD: nothing says what it was in pounds."""
    rows = [
        _row("pay", "T1000", "USD", "73.50", "out"),
        _row("c-usd", "T0200", "USD", "73.50", "in"),
        _row("c-eur", "T0200", "EUR", "65.28", "out"),
    ]
    assert PayPalCleaningService().conversion_rates(rows) == {}


def test_a_group_with_two_foreign_items_is_left_pending():
    rows = _usd_purchase() + [_row("other", "T0011", "USD", "151.20", "out")]
    assert PayPalCleaningService().conversion_rates(rows) == {}


def test_a_row_with_a_rate_is_left_alone_unless_asked():
    svc = PayPalCleaningService()
    rows = _usd_purchase(fx_rate="1.3")
    assert svc.conversion_rates(rows) == {}
    assert "pay" in svc.conversion_rates(rows, only_missing=False)


def test_groups_by_timestamp_do_not_mix():
    rows = _usd_purchase() + [
        _row(
            "later",
            "T0006",
            "USD",
            "10.00",
            "out",
            created_at="2026-01-03T09:00:00+00:00",
        )
    ]
    assert set(PayPalCleaningService().conversion_rates(rows)) == {"pay"}


# ── apply_conversion_rates ──────────────────────────────────────────────────


class _Service(PayPalCleaningService):
    def __init__(self, rows: List[Dict[str, Any]], journaled: set) -> None:
        super().__init__()
        self.rows = rows
        self.journaled = journaled
        self.updates: List[tuple] = []

    async def _fetch_all_paypal_rows(self, entity_id: UUID) -> List[Dict[str, Any]]:
        return self.rows

    async def _journaled_ids(self, transaction_ids: List[str]) -> set:
        return {i for i in transaction_ids if i in self.journaled}

    async def _update_fx(self, transaction_id, fx_rate, base_amount, metadata=None):
        self.updates.append((transaction_id, base_amount, metadata))


def test_apply_sets_the_rate_on_a_pending_row():
    svc = _Service(_usd_purchase(), journaled=set())
    result = asyncio.run(svc.apply_conversion_rates(ENTITY))
    assert result["applied"] == 1 and result["still_pending"] == 0
    ((txn_id, base, meta),) = svc.updates
    assert (txn_id, base) == ("pay", Decimal("115.16"))
    assert meta["fx_pending"] is True  # _update_fx strips it


def test_apply_never_changes_a_journaled_row():
    svc = _Service(_usd_purchase(), journaled={"pay"})
    result = asyncio.run(svc.apply_conversion_rates(ENTITY))
    assert svc.updates == []
    assert result["applied"] == 0 and result["skipped_journaled"] == 1


def test_apply_counts_what_it_could_not_convert():
    rows = [
        _row("pay", "T1000", "USD", "73.50", "out"),
        _row("c-usd", "T0200", "USD", "73.50", "in"),
        _row("c-eur", "T0200", "EUR", "65.28", "out"),
    ]
    svc = _Service(rows, journaled=set())
    assert asyncio.run(svc.apply_conversion_rates(ENTITY))["still_pending"] == 1


def test_update_fx_clears_the_pending_flag():
    captured: Dict[str, Any] = {}

    class _Table:
        def update(self, data):
            captured.update(data)
            return self

        def eq(self, *a):
            return self

        def execute(self):
            return None

    class _Client:
        def table(self, name):
            return _Table()

    svc = PayPalCleaningService()
    svc._client = _Client()
    asyncio.run(
        svc._update_fx(
            "pay", Decimal("1.3"), Decimal("115.16"), {"fx_pending": True, "a": 1}
        )
    )
    assert captured["metadata"] == {"a": 1}
    assert captured["base_amount"] == "115.16"


# ── Persistence: a reload keeps a confirmed rate ────────────────────────────


class _UpsertTable:
    def __init__(self, store: Dict[str, Any], existing: Optional[Dict[str, Any]]):
        self.store = store
        self.existing = existing
        self._op = ""

    def select(self, *_a):
        self._op = "select"
        return self

    def upsert(self, data, on_conflict=None):
        self._op = "upsert"
        self.store["upserted"] = data
        return self

    def eq(self, *_a):
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        class R:
            pass

        r = R()
        if self._op == "select":
            r.data = [self.existing] if self.existing else []
        else:
            r.data = [{"id": str(uuid4())}]
        return r


def _persist(
    existing: Optional[Dict[str, Any]], currency: str = "USD"
) -> Dict[str, Any]:
    store: Dict[str, Any] = {}

    class _Client:
        def table(self, name):
            return _UpsertTable(store, existing)

    persistence = PersistenceService()
    persistence._client = _Client()
    asyncio.run(
        persistence.persist_financial_transaction(_normalize(currency, "-151.20"))
    )
    upserted: Dict[str, Any] = store["upserted"]
    return upserted


@pytest.mark.parametrize("currency", ["GBP", "USD"])
def test_a_reload_keeps_an_exclusion_cleaning_set(currency):
    """A hard reload used to put excluded conversion and pass-through items back as
    money that moved, ready to be journaled."""
    data = _persist(
        {
            "fx_rate": None,
            "base_amount": 151.2,
            "excluded_reason": "Currency conversion noise",
            "status": "excluded",
            "description": "[Excluded] T0200 currency conversion — x",
        },
        currency,
    )
    assert data["excluded_reason"] == "Currency conversion noise"
    assert data["status"] == "excluded"
    assert data["description"].startswith("[Excluded]")


def test_a_reload_of_a_counted_row_stays_counted():
    data = _persist({"fx_rate": None, "base_amount": 151.2, "excluded_reason": None})
    assert data["excluded_reason"] is None
    assert data["status"] == "pending"


def test_a_reload_keeps_the_confirmed_rate():
    data = _persist({"fx_rate": 1.31296, "base_amount": 115.16})
    assert data["fx_rate"] == 1.31296
    assert data["base_amount"] == 115.16
    assert "fx_pending" not in data["metadata"]


def test_a_new_row_is_stored_pending():
    data = _persist(None)
    assert data["fx_rate"] is None
    assert data["base_amount"] == 151.2
    assert data["metadata"]["fx_pending"] is True


def test_a_row_still_pending_stays_pending():
    data = _persist({"fx_rate": None, "base_amount": 151.2})
    assert data["fx_rate"] is None
    assert data["metadata"]["fx_pending"] is True


# ── Journals: a pending row is never posted ─────────────────────────────────


class _Journals(JournalService):
    def __init__(self, txn: Dict[str, Any]):
        super().__init__()
        self.txn = txn
        self.created: List[Dict[str, Any]] = []

    async def _fetch_financial_transaction(self, txn_id):
        return self.txn

    async def _find_journal(self, *args, **kwargs):
        return None

    async def _find_order_for_refund_transaction(self, *args, **kwargs):
        return None

    async def _get_account_id(self, entity_id, account_number, *args, **kwargs):
        return f"id-{account_number}"

    async def _create_journal(self, **journal):
        self.created.append(journal)
        return journal


def _stored(currency: str, direction: str, txn_type: str = "payment") -> Dict[str, Any]:
    txn = _normalize(currency, "-151.20" if direction == "out" else "151.20")
    return {
        "id": str(uuid4()),
        "source": "paypal",
        "transaction_type": txn_type,
        "direction": direction,
        "amount": float(txn.amount),
        "currency_code": txn.currency_code,
        "base_currency_code": txn.base_currency_code,
        "base_amount": float(txn.base_amount),
        "fx_rate": None,
        "description": "Supplier",
        "counterparty_name": "Supplier",
        # A categorised expense: otherwise it falls back to the catch-all, a draft anyway.
        "metadata": {**txn.metadata, "account_code": "6200"},
        "occurred_at": txn.occurred_at.isoformat(),
    }


def _journal(method: str, txn: Dict[str, Any]) -> Dict[str, Any]:
    service = _Journals(txn)
    asyncio.run(getattr(service, method)(uuid4(), uuid4()))
    [journal] = service.created
    return journal


@pytest.mark.parametrize(
    "method, direction, txn_type",
    [
        ("create_expense_journal", "out", "payment"),
        ("create_sales_receipt_journal", "in", "payment"),
        ("create_refund_journal", "in", "refund"),
        ("create_funding_journal", "in", "payment"),
    ],
)
def test_a_pending_row_gives_a_draft_journal(method, direction, txn_type):
    journal = _journal(method, _stored("USD", direction, txn_type))
    assert journal["status"] == "draft"


@pytest.mark.parametrize(
    "method, direction, txn_type",
    [
        ("create_expense_journal", "out", "payment"),
        ("create_sales_receipt_journal", "in", "payment"),
        ("create_refund_journal", "in", "refund"),
    ],
)
def test_a_confirmed_row_posts_in_gbp(method, direction, txn_type):
    txn = _stored("USD", direction, txn_type)
    txn["fx_rate"], txn["base_amount"] = 1.31296, 115.16
    txn["metadata"].pop("fx_pending")
    journal = _journal(method, txn)
    assert journal["status"] == "posted"
    assert {line["currency"] for line in journal["line_items"]} == {"GBP"}
    assert sum(line["debit"] for line in journal["line_items"]) == pytest.approx(115.16)


def test_a_gbp_row_is_unaffected():
    journal = _journal("create_expense_journal", _stored("GBP", "out"))
    assert journal["status"] == "posted"
