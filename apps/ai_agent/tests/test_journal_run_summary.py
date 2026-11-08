"""The journal run summary: figures come from the journals, the model only narrates."""

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List
from uuid import uuid4

import pytest

from ai_agent.services import journal_run_summary as summary
from ai_agent.services.journal_run_summary import build_run_stats
from ai_agent.services.journal_service import JournalService

ACCOUNTS = [
    {"id": "a-cash", "account_number": "1000", "name": "Cash"},
    {"id": "a-sales", "account_number": "4000", "name": "Sales"},
    {"id": "a-software", "account_number": "6100", "name": "Software"},
    {"id": "a-uncat", "account_number": "8090", "name": "Uncategorised"},
]


def journal(
    jid: str, jtype: str, status: str, amount: float, dr: str, cr: str, date: str
):
    return {
        "id": jid,
        "journal_type": jtype,
        "status": status,
        "journal_date": date,
        "description": f"{jtype} {jid}",
        "line_items": [
            {"account_id": dr, "debit": amount, "credit": 0},
            {"account_id": cr, "debit": 0, "credit": amount},
        ],
    }


RUN = [
    journal(
        "j1", "accrual", "posted", 120.0, "a-cash", "a-sales", "2026-10-01T00:00:00Z"
    ),
    journal(
        "j2", "accrual", "posted", 80.5, "a-cash", "a-sales", "2026-10-03T00:00:00Z"
    ),
    journal(
        "j3", "expense", "posted", 30.0, "a-software", "a-cash", "2026-10-02T00:00:00Z"
    ),
    journal(
        "j4", "expense", "draft", 999.99, "a-uncat", "a-cash", "2026-09-28T00:00:00Z"
    ),
]


class TestBuildRunStats:
    def test_counts_by_status_and_total(self):
        stats = build_run_stats(RUN, ACCOUNTS)
        assert stats["journals_total"] == 4
        assert stats["posted"] == 3
        assert stats["draft"] == 1
        assert stats["total_amount"] == pytest.approx(1230.49)

    def test_by_type_is_largest_first(self):
        stats = build_run_stats(RUN, ACCOUNTS)
        assert stats["by_type"] == [
            {"journal_type": "expense", "count": 2, "amount": 1029.99},
            {"journal_type": "accrual", "count": 2, "amount": 200.5},
        ]

    def test_date_range(self):
        stats = build_run_stats(RUN, ACCOUNTS)
        assert stats["first_date"] == "2026-09-28T00:00:00Z"
        assert stats["last_date"] == "2026-10-03T00:00:00Z"

    def test_top_accounts_named_and_ranked_by_movement(self):
        top = build_run_stats(RUN, ACCOUNTS)["top_accounts"]
        # Cash: 200.50 in, 1029.99 out — the most movement.
        assert top[0] == {
            "account_number": "1000",
            "name": "Cash",
            "debit": 200.5,
            "credit": 1029.99,
        }
        assert {a["account_number"] for a in top} == {"1000", "8090", "4000", "6100"}

    def test_largest_journals_first(self):
        largest = build_run_stats(RUN, ACCOUNTS)["largest_journals"]
        assert [j["id"] for j in largest] == ["j4", "j1", "j2", "j3"]
        assert largest[0]["status"] == "draft"

    def test_empty_run(self):
        stats = build_run_stats([], ACCOUNTS)
        assert stats["journals_total"] == 0
        assert stats["total_amount"] == 0
        assert stats["first_date"] is None
        assert stats["by_type"] == [] and stats["top_accounts"] == []

    def test_unknown_account_does_not_break(self):
        j = journal("j", "expense", "posted", 5, "gone", "a-cash", "2026-10-01")
        names = {a["name"] for a in build_run_stats([j], ACCOUNTS)["top_accounts"]}
        assert "Unknown account" in names


class FakeService(JournalService):
    async def get_chart_of_accounts(self, entity_id=None) -> List[Dict[str, Any]]:
        return ACCOUNTS


def run_summary(monkeypatch, journals, narrative):
    seen: Dict[str, Any] = {}

    async def fake_fetch(service, entity_id, since):
        seen["since"] = since
        return journals

    async def fake_narrative(stats):
        seen["narrated"] = True
        if isinstance(narrative, Exception):
            return None
        return narrative

    monkeypatch.setattr(summary, "_fetch_run_journals", fake_fetch)
    monkeypatch.setattr(summary, "_write_narrative", fake_narrative)
    since = datetime(2026, 11, 8, 9, 30, tzinfo=timezone.utc)
    result = asyncio.run(summary.summarize_journal_run(uuid4(), since, FakeService()))
    return result, seen


class TestSummarizeJournalRun:
    def test_stats_and_narrative(self, monkeypatch):
        text = {"headline": "4 journals.", "highlights": ["a"], "attention": []}
        result, seen = run_summary(monkeypatch, RUN, text)
        assert seen["since"] == datetime(2026, 11, 8, 9, 30, tzinfo=timezone.utc)
        assert result["stats"]["journals_total"] == 4
        assert result["narrative"] == text

    def test_empty_run_never_asks_the_model(self, monkeypatch):
        result, seen = run_summary(monkeypatch, [], {"headline": "x"})
        assert "narrated" not in seen
        assert result["narrative"] is None
        assert result["stats"]["journals_total"] == 0

    def test_model_failure_still_returns_the_figures(self, monkeypatch):
        result, _ = run_summary(monkeypatch, RUN, RuntimeError("model down"))
        assert result["narrative"] is None
        assert result["stats"]["posted"] == 3

    def test_no_model_key_costs_only_the_narrative(self, monkeypatch):
        def no_key(*a, **k):
            raise RuntimeError("GOOGLE_API_KEY not set")

        monkeypatch.setattr(summary, "init_chat_model", no_key)
        stats = build_run_stats(RUN, ACCOUNTS)
        assert asyncio.run(summary._write_narrative(stats)) is None

    def test_prompt_carries_the_computed_figures(self):
        prompt = summary._narrative_prompt(build_run_stats(RUN, ACCOUNTS))
        assert '"total_amount": 1230.49' in prompt
        assert "Use ONLY the figures" in prompt
