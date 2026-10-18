"""Tests for the invoice lifecycle rules (pure functions, no database)."""

from datetime import date

import pytest

from ai_agent.services.invoice_rules import (
    TRANSITIONS,
    VALID_STATUSES,
    InvoiceRuleError,
    check_deletable,
    check_transition,
    effective_status,
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
            ("OPEN", "DRAFT"),  # a finalised invoice has a journal; it cannot go back
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
        check_deletable(status, has_posted_journals=False)

    @pytest.mark.parametrize("status", ["OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE"])
    def test_live_invoices_cannot(self, status):
        with pytest.raises(InvoiceRuleError, match="Void it instead"):
            check_deletable(status, has_posted_journals=False)

    def test_posted_journals_block_even_a_draft(self):
        with pytest.raises(InvoiceRuleError, match="posted journals"):
            check_deletable("DRAFT", has_posted_journals=True)


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
