"""Splitting a payment's journal by the invoice it paid: the arithmetic, and when it can be done.

Applying and undoing are one database function each (apply_invoice_split, undo_invoice_split);
the cases here are the pure parts that decide what those functions are given.
"""

from decimal import Decimal
from typing import Any, Dict, List

import pytest

from ai_agent.services.invoice_split import (
    SplitError,
    balanced,
    cut,
    journal_lines,
    propose,
    split_lines,
)

EXPENSE, CASH, YARN, POSTAGE = "acct-8090", "acct-1014", "acct-5010", "acct-6300"


def line(
    i: int, qty: float, unit: float, vat: float = 0, account=None
) -> Dict[str, Any]:
    net = qty * unit
    return {
        "id": f"l{i}",
        "description": f"Line {i}",
        "quantity": qty,
        "unit_cost": unit,
        "vat_rate": vat,
        "line_net": net,
        "line_vat": net * vat,
        "line_gross": net * (1 + vat),
        "gl_account_id": account,
    }


INVOICE = {
    "id": "inv-1",
    "invoice_number": "PISSX2407006",
    "invoice_type": "PURCHASE",
    "currency": "USD",
    "gross_amount": 1176.0,
    "invoice_line_items": [
        line(1, 60, 15.0, account=YARN),  # 900
        line(2, 1, 276.0),  # 276, no account: keeps the payment's
    ],
}


def expense_journal(amount: float, currency="GBP", gbp=None) -> Dict[str, Any]:
    extra = {"gbp_equivalent": gbp} if gbp is not None else {}
    return {
        "id": "j-expense",
        "journal_type": "expense",
        "status": "posted",
        "journal_date": "2024-07-12",
        "lines": [
            {
                "account_id": EXPENSE,
                "debit": amount,
                "credit": 0,
                "currency": currency,
                "description": "Expense",
                **extra,
            },
            {
                "account_id": CASH,
                "debit": 0,
                "credit": amount,
                "currency": currency,
                "description": "Cash out",
                **extra,
            },
        ],
    }


def total(lines) -> Decimal:
    return sum((line.amount for line in lines), Decimal(0))


class TestSplitLines:
    def test_lines_take_their_share_and_add_up_to_the_payment(self):
        # A USD invoice paid from the GBP account: the journal is 913.37 GBP.
        split = split_lines(INVOICE["invoice_line_items"], Decimal("913.37"), EXPENSE)
        assert total(split) == Decimal("913.37")
        assert [line.amount for line in split] == [Decimal("699.01"), Decimal("214.36")]

    def test_a_line_without_an_account_keeps_the_payments(self):
        split = split_lines(INVOICE["invoice_line_items"], Decimal("100"), EXPENSE)
        assert [(s.account_id, s.from_invoice_account) for s in split] == [
            (YARN, True),
            (EXPENSE, False),
        ]

    def test_a_part_payment_is_that_share_of_every_line(self):
        # A deposit of 40%.
        split = split_lines(INVOICE["invoice_line_items"], Decimal("470.40"), EXPENSE)
        assert [line.amount for line in split] == [Decimal("360.00"), Decimal("110.40")]

    def test_rounding_lands_on_the_largest_line(self):
        lines = [line(1, 1, 1), line(2, 1, 1), line(3, 1, 1)]
        split = split_lines(lines, Decimal("100.00"), EXPENSE)
        assert total(split) == Decimal("100.00")
        assert sorted(line.amount for line in split) == [
            Decimal("33.33"),
            Decimal("33.33"),
            Decimal("33.34"),
        ]

    def test_vat_is_folded_in_and_its_share_kept(self):
        lines = [line(1, 1, 100, vat=0.2), line(2, 1, 30)]  # 120 gross, 30 gross
        split = split_lines(lines, Decimal("150"), EXPENSE)
        assert [s.amount for s in split] == [Decimal("120.00"), Decimal("30.00")]
        assert [s.vat for s in split] == [Decimal("20.00"), Decimal("0.00")]

    def test_lines_with_no_amount_are_left_out(self):
        split = split_lines([line(1, 0, 10), line(2, 2, 5)], Decimal("10"), EXPENSE)
        assert [s.line_item_id for s in split] == ["l2"]

    def test_an_invoice_with_nothing_to_weigh_is_refused(self):
        with pytest.raises(SplitError, match="no lines with an amount"):
            split_lines([line(1, 0, 10)], Decimal("10"), EXPENSE)


class TestJournalLines:
    def test_the_cash_side_is_kept_and_gbp_is_shared_out(self):
        made = cut(INVOICE, expense_journal(1176.0, currency="USD", gbp=913.37))
        debits = [i for i in made.items if i["debit"]]
        credits = [i for i in made.items if i["credit"]]
        assert credits == [
            {
                "account_id": CASH,
                "debit": 0,
                "credit": 1176.0,
                "currency": "USD",
                "description": "Cash out",
                "gbp_equivalent": 913.37,
            }
        ]
        assert [d["debit"] for d in debits] == [900.0, 276.0]
        assert sum(d["gbp_equivalent"] for d in debits) == pytest.approx(
            913.37, abs=0.001
        )
        assert all(d["description"].startswith("PISSX2407006: ") for d in debits)
        assert balanced(made.items)

    def test_a_gbp_journal_has_no_gbp_equivalents(self):
        made = cut(INVOICE, expense_journal(913.37))
        assert all("gbp_equivalent" not in item for item in made.items)

    def test_unbalanced_items_are_seen(self):
        items = journal_lines(
            [], [{"account_id": CASH, "credit": 5}], "GBP", None, Decimal(5), "X"
        )
        assert not balanced(items)


TXN = {
    "id": "t1",
    "occurred_at": "2024-07-12",
    "amount": -1176.0,
    "currency_code": "USD",
    "excluded_reason": None,
}


class TestPropose:
    def test_a_payment_journaled_as_one_expense_is_ready(self):
        proposal = propose(INVOICE, TXN, [expense_journal(913.37)], {})
        assert proposal.state == "ready"
        assert proposal.share_of_invoice == 1.0
        assert proposal.replaces == [
            {"id": "j-expense", "journal_type": "expense", "status": "posted"}
        ]
        assert sum(line["debit"] for line in proposal.lines) == pytest.approx(913.37)
        assert sum(line["credit"] for line in proposal.lines) == pytest.approx(913.37)

    def test_an_uncategorised_draft_is_ready_too(self):
        draft = {**expense_journal(913.37), "status": "draft"}
        assert propose(INVOICE, TXN, [draft], {}).state == "ready"

    def test_an_applied_split_is_shown(self):
        split = {
            **expense_journal(913.37),
            "id": "j-split",
            "journal_type": "invoice_split",
        }
        proposal = propose(INVOICE, TXN, [split], {})
        assert (proposal.state, proposal.split_journal_id) == ("applied", "j-split")

    @pytest.mark.parametrize(
        "invoice, txn, live, state, reason",
        [
            (INVOICE, {**TXN, "excluded_reason": "x"}, [], "unsupported", "left out"),
            (
                {**INVOICE, "invoice_type": "SALE"},
                TXN,
                [expense_journal(1)],
                "unsupported",
                "Only purchases",
            ),
            (INVOICE, TXN, [], "not_journaled", "Generate journals"),
            (
                INVOICE,
                TXN,
                [{**expense_journal(1), "journal_type": "funding"}],
                "unsupported",
                "one expense",
            ),
            (
                INVOICE,
                TXN,
                [expense_journal(1), expense_journal(1)],
                "unsupported",
                "one expense",
            ),
            (
                {**INVOICE, "invoice_line_items": []},
                TXN,
                [expense_journal(1)],
                "unsupported",
                "no lines",
            ),
        ],
        ids=[
            "excluded",
            "sale",
            "not-journaled",
            "other-type",
            "two-journals",
            "no-lines",
        ],
    )
    def test_what_cannot_be_split_says_why(self, invoice, txn, live, state, reason):
        proposal = propose(invoice, txn, live, {})
        assert proposal.state == state
        assert reason in (proposal.reason or "")

    def test_a_part_payment_shows_its_share(self):
        proposal = propose(
            INVOICE, {**TXN, "amount": -470.4}, [expense_journal(470.4)], {}
        )
        assert proposal.share_of_invoice == 0.4


def test_accounts_are_shown_by_number_and_name():
    accounts: Dict[str, Dict[str, Any]] = {
        YARN: {"account_number": "5010", "name": "Stock purchases"},
        EXPENSE: {"account_number": "8090", "name": "Miscellaneous"},
        CASH: {"account_number": "1014", "name": "Revolut GBP"},
    }
    proposal = propose(INVOICE, TXN, [expense_journal(1176.0)], accounts)
    numbers: List[str] = [line["account_number"] for line in proposal.lines]
    assert numbers == ["5010", "8090", "1014"]
