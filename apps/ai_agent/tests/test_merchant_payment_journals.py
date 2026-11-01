"""Revolut merchant payments: the fee is journaled on the payment, and the moves that take the
money on to the main account are internal and never journaled.

The three transactions are Revolut's own, as stored for one payment of 1407.89 (fee 14.28):
the payment into the merchant account, its settlement to a second account, and the payout to
the main account.
"""

import asyncio
from decimal import Decimal
from typing import Any, Dict, List
from uuid import uuid4

import pytest

from ai_agent.normalization.revolut_normalizer import (
    INTERNAL_MOVE_REASON,
    RevolutNormalizer,
    internal_move_legs,
)
from ai_agent.services.journal_service import JournalService, merchant_fee

MERCHANT, RESERVE, MAIN = "acc-merchant", "acc-reserve", "acc-main"


def revolut(kind: str, legs: List[Dict[str, Any]], txn_id: str = "txn") -> dict:
    return {
        "id": txn_id,
        "type": kind,
        "state": "completed",
        "created_at": "2026-10-28T22:06:21Z",
        "completed_at": "2026-10-28T22:06:24Z",
        "legs": legs,
    }


PAYMENT = revolut(
    "merchant_payment",
    [
        {
            "account_id": MERCHANT,
            "amount": 1407.89,
            "fee": 14.28,
            "balance": 1393.61,
            "currency": "GBP",
            "description": "Merchant payment",
        }
    ],
)
SETTLEMENT = revolut(
    "merchant_reserve",
    [
        {
            "account_id": MERCHANT,
            "amount": -1393.61,
            "currency": "GBP",
            "description": "Payment settlement",
        },
        {"account_id": RESERVE, "amount": 1393.61, "currency": "GBP"},
    ],
)
PAYOUT = revolut(
    "transfer",
    [
        {
            "account_id": RESERVE,
            "amount": -1393.61,
            "currency": "GBP",
            "description": "Merchant payout to an internal account",
        },
        {"account_id": MAIN, "amount": 1393.61, "currency": "GBP"},
    ],
)


def normalize(payload: dict):
    result = RevolutNormalizer(uuid4()).normalize(
        "financial_transaction", payload["id"], payload, uuid4()
    )
    assert result.success, result
    return result.canonical


class TestInternalMoves:
    @pytest.mark.parametrize(
        "payload", [SETTLEMENT, PAYOUT], ids=["settlement", "payout"]
    )
    def test_a_move_between_own_accounts_is_stored_excluded(self, payload):
        txn = normalize(payload)
        assert txn.excluded_reason == INTERNAL_MOVE_REASON
        assert txn.status.value == "excluded"
        assert txn.metadata["internal_move"] is True
        # Stored from the side the money left, with both sides kept.
        assert txn.direction.value == "out"
        assert txn.amount == Decimal("1393.61")
        assert [leg["amount"] for leg in txn.metadata["legs"]] == [-1393.61, 1393.61]

    def test_the_outgoing_leg_is_used_whatever_order_revolut_lists_them_in(self):
        flipped = revolut("transfer", list(reversed(PAYOUT["legs"])))
        txn = normalize(flipped)
        assert txn.direction.value == "out"
        assert txn.metadata["revolut_account_id"] == RESERVE

    def test_a_payment_to_someone_else_is_not_internal(self):
        legs = [
            {
                "account_id": MAIN,
                "amount": -50,
                "currency": "GBP",
                "counterparty": {"name": "Royal Mail", "account_type": "external"},
            }
        ]
        assert not internal_move_legs(legs)
        txn = normalize(revolut("transfer", legs))
        assert txn.excluded_reason is None
        assert "internal_move" not in txn.metadata

    @pytest.mark.parametrize(
        "legs",
        [
            # Two currencies: an exchange, journaled per leg elsewhere.
            [
                {"account_id": MAIN, "amount": -100, "currency": "GBP"},
                {"account_id": "acc-usd", "amount": 127, "currency": "USD"},
            ],
            # Does not add up to nothing.
            [
                {"account_id": MAIN, "amount": -100, "currency": "GBP"},
                {"account_id": RESERVE, "amount": 90, "currency": "GBP"},
            ],
            # A leg with a counterparty is money leaving the business.
            [
                {"account_id": MAIN, "amount": -100, "currency": "GBP"},
                {
                    "account_id": RESERVE,
                    "amount": 100,
                    "currency": "GBP",
                    "counterparty": {"name": "Someone"},
                },
            ],
            # A leg on no account.
            [
                {"account_id": MAIN, "amount": -100, "currency": "GBP"},
                {"amount": 100, "currency": "GBP"},
            ],
        ],
        ids=["two-currencies", "unbalanced", "counterparty", "no-account"],
    )
    def test_only_a_balanced_move_between_accounts_counts(self, legs):
        assert not internal_move_legs(legs)


class TestMerchantFee:
    def test_the_payment_keeps_its_fee_and_is_not_internal(self):
        txn = normalize(PAYMENT)
        assert txn.metadata["fee"] == 14.28
        assert txn.metadata["fee_currency"] == "GBP"
        assert txn.excluded_reason is None
        assert txn.direction.value == "in"
        assert txn.amount == Decimal("1407.89")

    def test_a_card_payment_abroad_keeps_its_fee_in_the_accounts_currency(self):
        # Stored in the billed currency (USD); Revolut charges the fee on the GBP leg.
        txn = normalize(
            revolut(
                "card_payment",
                [
                    {
                        "account_id": MAIN,
                        "amount": -80.0,
                        "fee": 1.2,
                        "currency": "GBP",
                        "bill_amount": 100.0,
                        "bill_currency": "USD",
                    }
                ],
            )
        )
        assert txn.currency_code == "USD"
        assert txn.metadata["fee"] == 1.2
        assert txn.metadata["fee_currency"] == "GBP"

    def test_a_fee_already_in_the_journals_currency_is_not_converted(self):
        usd = {"amount": 100, "metadata": {"fee": 1.2, "fee_currency": "GBP"}}
        assert merchant_fee(usd, Decimal("80"), "GBP") == Decimal("1.20")

    def test_fee_in_the_journals_currency(self):
        gbp = {"amount": 1407.89, "metadata": {"fee": 14.28}}
        assert merchant_fee(gbp, Decimal("1407.89")) == Decimal("14.28")
        # A ZAR payment journaled at its GBP base amount: the fee scales with it.
        zar = {"amount": 35400, "metadata": {"fee": 995.62, "fee_currency": "ZAR"}}
        assert merchant_fee(zar, Decimal("1599.54")) == Decimal("44.99")

    @pytest.mark.parametrize(
        "txn",
        [
            {"amount": 100, "metadata": {}},
            {"amount": 100, "metadata": {"fee": 0}},
            {"amount": 100, "metadata": {"fee": 100}},
            {"amount": 0, "metadata": {"fee": 5}},
        ],
        ids=["none", "zero", "all-of-it", "no-amount"],
    )
    def test_no_believable_fee_gives_none(self, txn):
        assert merchant_fee(txn, Decimal("100")) == 0


class FakeJournals(JournalService):
    """The funding journal's reads and write, against one stored transaction."""

    def __init__(self, txn: Dict[str, Any]):
        super().__init__()
        self.txn = txn
        self.created: List[Dict[str, Any]] = []

    async def _fetch_financial_transaction(self, txn_id):
        return self.txn

    async def _find_journal(self, *args, **kwargs):
        return None

    async def _get_account_id(self, entity_id, account_number, *args, **kwargs):
        return f"id-{account_number}"

    async def _create_journal(self, **journal):
        self.created.append(journal)
        return journal


def funding_journal(txn: Dict[str, Any]) -> Dict[str, Any]:
    service = FakeJournals(txn)
    asyncio.run(service.create_funding_journal(uuid4(), uuid4()))
    [journal] = service.created
    return journal


def stored(payload: dict) -> Dict[str, Any]:
    """The normalised payment as the journal reads it from financial_transactions."""
    txn = normalize(payload)
    return {
        "id": str(uuid4()),
        "source": "revolut",
        "transaction_type": txn.transaction_type.value,
        "direction": txn.direction.value,
        "amount": float(txn.amount),
        "currency_code": txn.currency_code,
        "base_currency_code": txn.base_currency_code,
        "base_amount": float(txn.base_amount) if txn.base_amount else None,
        "fx_rate": None,
        "description": txn.description,
        "counterparty_name": txn.counterparty_name,
        "metadata": txn.metadata,
        "occurred_at": txn.occurred_at.isoformat(),
    }


def lines(journal: Dict[str, Any]) -> Dict[str, tuple]:
    return {
        line["account_id"]: (line["debit"], line["credit"])
        for line in journal["line_items"]
    }


class TestMerchantPaymentJournal:
    def test_the_fee_comes_off_cash_and_revenue_is_what_the_customer_paid(self):
        journal = funding_journal(stored(PAYMENT))
        assert lines(journal) == {
            "id-1014": (1393.61, 0),  # what reached the account
            "id-8020": (14.28, 0),  # Revolut's fee
            "id-4030": (0, 1407.89),  # the sale
        }
        assert journal["status"] == "posted"

    def test_without_a_fee_it_is_the_two_lines_it_always_was(self):
        txn = stored(PAYMENT)
        txn["metadata"].pop("fee")
        assert lines(funding_journal(txn)) == {
            "id-1014": (1407.89, 0),
            "id-4030": (0, 1407.89),
        }

    def test_a_fee_on_another_kind_of_receipt_is_not_journaled_here(self, monkeypatch):
        txn = stored(PAYMENT)
        txn["transaction_type"] = "transfer"
        monkeypatch.setattr(FakeJournals, "_is_wholesale_payment", lambda *a: False)
        monkeypatch.setattr(FakeJournals, "_is_brand_collaboration", lambda *a: False)
        assert "id-8020" not in lines(funding_journal(txn))

    def test_journal_lines_balance(self):
        journal = funding_journal(stored(PAYMENT))
        debits = sum(Decimal(str(line["debit"])) for line in journal["line_items"])
        credits = sum(Decimal(str(line["credit"])) for line in journal["line_items"])
        assert debits == credits == Decimal("1407.89")
