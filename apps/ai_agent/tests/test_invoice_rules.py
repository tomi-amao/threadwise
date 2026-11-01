"""Tests for the invoice lifecycle rules (pure functions, no database)."""

from datetime import date
from decimal import Decimal

import pytest

from ai_agent.services.invoice_rules import (
    LOCKED,
    SYNCED_ORIGINS,
    TRANSITIONS,
    VALID_STATUSES,
    InvoiceRuleError,
    check_deletable,
    check_editable,
    check_transition,
    effective_status,
    status_from_payments,
)


class TestTransitions:
    def test_every_status_has_a_rule_and_only_points_at_real_statuses(self):
        assert set(TRANSITIONS) == set(VALID_STATUSES)
        for targets in TRANSITIONS.values():
            assert targets <= VALID_STATUSES

    @pytest.mark.parametrize(
        "current,target",
        [
            ("DRAFT", "OPEN"),
            ("DRAFT", "PAID"),
            ("OPEN", "PAID"),
            ("OPEN", "PARTIALLY_PAID"),
            ("PARTIALLY_PAID", "PAID"),
            ("OVERDUE", "PAID"),
            ("PAID", "OPEN"),
            ("OPEN", "VOID"),
            ("DRAFT", "CANCELLED"),
        ],
    )
    def test_allowed(self, current, target):
        check_transition(current, target)

    @pytest.mark.parametrize(
        "current,target",
        [
            ("OPEN", "DRAFT"),  # a finalised invoice does not go back to review
            ("PAID", "DRAFT"),
            ("PAID", "PARTIALLY_PAID"),
            ("VOID", "OPEN"),  # terminal
            ("CANCELLED", "DRAFT"),
            ("VOID", "PAID"),
        ],
    )
    def test_refused(self, current, target):
        with pytest.raises(InvoiceRuleError):
            check_transition(current, target)

    def test_staying_put_is_a_noop_even_for_terminal_states(self):
        for status in VALID_STATUSES:
            check_transition(status, status)

    def test_is_case_insensitive_and_rejects_unknown(self):
        check_transition("draft", "open")
        with pytest.raises(InvoiceRuleError, match="Unknown status"):
            check_transition("DRAFT", "ARCHIVED")

    def test_message_says_where_it_can_go(self):
        with pytest.raises(InvoiceRuleError, match="can only become OPEN, VOID"):
            check_transition("PAID", "DRAFT")


class TestDeletable:
    @pytest.mark.parametrize("status", ["DRAFT", "CANCELLED", "VOID"])
    def test_clean_non_live_invoices_can_go(self, status):
        check_deletable(status)

    @pytest.mark.parametrize("status", ["OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE"])
    def test_live_invoices_cannot(self, status):
        with pytest.raises(InvoiceRuleError, match="Void it instead"):
            check_deletable(status)


class TestEffectiveStatus:
    today = date(2026, 10, 17)

    def test_open_past_due_is_overdue(self):
        assert effective_status("OPEN", "2026-10-16", self.today) == "OVERDUE"
        assert effective_status("PARTIALLY_PAID", "2026-01-01", self.today) == "OVERDUE"

    def test_due_today_is_not_yet_overdue(self):
        assert effective_status("OPEN", "2026-10-17", self.today) == "OPEN"

    def test_only_unpaid_finalised_invoices_become_overdue(self):
        for status in ("DRAFT", "PAID", "VOID", "CANCELLED"):
            assert effective_status(status, "2020-01-01", self.today) == status

    def test_no_due_date_stays_as_is(self):
        assert effective_status("OPEN", None, self.today) == "OPEN"

    def test_accepts_timestamps_and_dates(self):
        assert (
            effective_status("OPEN", "2026-10-01T00:00:00+00:00", self.today)
            == "OVERDUE"
        )
        assert effective_status("OPEN", date(2026, 12, 1), self.today) == "OPEN"


class TestStatusFromPayments:
    def test_payments_covering_the_total_mean_paid(self):
        assert status_from_payments("OPEN", 180, "GBP", [(180, "GBP")]) == "PAID"
        assert (
            status_from_payments("OPEN", 180, "GBP", [(100, "GBP"), (80, "GBP")])
            == "PAID"
        )

    def test_fees_and_rounding_within_five_percent_still_count_as_paid(self):
        assert (
            status_from_payments("OPEN", 100, "GBP", [(Decimal("95"), "GBP")]) == "PAID"
        )
        assert (
            status_from_payments("OPEN", 100, "GBP", [(Decimal("94.99"), "GBP")])
            == "PARTIALLY_PAID"
        )

    def test_less_than_the_total_is_part_paid(self):
        # A real one: 1,272 of a 2,121 USD invoice.
        assert (
            status_from_payments("OPEN", "2121.0", "USD", [("1272.0000", "USD")])
            == "PARTIALLY_PAID"
        )

    def test_a_payment_in_another_currency_is_taken_as_paid(self):
        assert status_from_payments("OPEN", 100, "USD", [(79, "GBP")]) == "PAID"

    def test_no_links_left_reopens_a_paid_invoice_but_overdue_stays_overdue(self):
        assert status_from_payments("PAID", 100, "GBP", []) == "OPEN"
        assert status_from_payments("PARTIALLY_PAID", 100, "GBP", []) == "OPEN"
        assert status_from_payments("OVERDUE", 100, "GBP", []) == "OVERDUE"

    @pytest.mark.parametrize("status", ["DRAFT", "CANCELLED", "VOID"])
    def test_drafts_and_dead_invoices_keep_their_status(self, status):
        assert status_from_payments(status, 100, "GBP", [(100, "GBP")]) == status


class TestEditable:
    @pytest.mark.parametrize("change", ["status", "direction", "delete"])
    def test_uploads_and_old_rows_are_the_apps_to_change(self, change):
        check_editable("upload", change)
        check_editable(None, change)

    @pytest.mark.parametrize("change", ["status", "direction", "delete"])
    def test_payment_requests_belong_to_revolut(self, change):
        with pytest.raises(InvoiceRuleError, match="synced from Revolut"):
            check_editable("revolut_merchant", change)

    @pytest.mark.parametrize("change", ["status", "direction"])
    def test_an_invoice_read_from_a_receipt_follows_its_transaction(self, change):
        with pytest.raises(InvoiceRuleError, match="receipt"):
            check_editable("revolut_expense", change)

    def test_an_invoice_read_from_a_receipt_can_be_dismissed_whatever_its_status(self):
        check_editable("revolut_expense", "delete")
        check_deletable("PAID", "revolut_expense")
        with pytest.raises(InvoiceRuleError):
            check_deletable("PAID", "upload")

    def test_every_synced_origin_has_its_locks(self):
        assert set(LOCKED) == SYNCED_ORIGINS
