"""Summary of one journal-generation run, for the modal's Summary tab.

Two halves, kept apart on purpose:

- ``build_run_stats`` is pure: every figure the tab shows (counts, totals, the
  accounts that moved most, the largest journals) is computed here from the
  journals the run created. Nothing the user reads as a number comes from a model.
- ``summarize_journal_run`` adds a short narrative from a model, written only from
  those stats. It is advisory: if the call fails, the stats are still returned
  with ``narrative`` set to ``None``.

"The run" is every journal whose ``generation_run_id`` points at it. Journals are never
deleted, only reversed, so the set is stable; a draft posted from the Review tab
afterwards shows as posted. The narrative is written the first time a run is opened and
then kept, so a run nobody opens costs nothing and the text does not change between visits.
"""

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, cast
from uuid import UUID

from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

from ..core.config import settings
from ..normalization.utils import extract_rows
from .journal_runs import JournalRunStore, journal_runs
from .journal_service import JournalService, journal_service

logger = logging.getLogger(__name__)

# Enough for any realistic run; the stats say when the cap was reached.
MAX_RUN_JOURNALS = 1000
TOP_ACCOUNTS = 5
LARGEST_JOURNALS = 5


class JournalRunNotFound(Exception):
    """No such run for this business."""


class JournalRunNarrative(BaseModel):
    headline: str = Field(
        ..., description="One plain sentence saying what this run recorded overall"
    )
    highlights: List[str] = Field(
        ...,
        max_length=4,
        description="Two to four short points about what was recorded, using the figures given",
    )
    attention: List[str] = Field(
        default_factory=list,
        max_length=3,
        description="Up to three things the user should look at (e.g. drafts to review); empty if none",
    )


def _money(value: float) -> float:
    return round(value, 2)


def _journal_amount(journal: Dict[str, Any]) -> float:
    """A journal's size is its debit total (debits equal credits)."""
    return float(sum(li.get("debit") or 0 for li in journal.get("line_items", [])))


def build_run_stats(
    journals: List[Dict[str, Any]],
    accounts: List[Dict[str, Any]],
    truncated: bool = False,
) -> Dict[str, Any]:
    """Every figure the Summary tab shows, computed from the run's journals."""
    accounts_by_id = {a["id"]: a for a in accounts}

    by_type: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "amount": 0.0}
    )
    by_status: Dict[str, int] = defaultdict(int)
    account_moves: Dict[str, Dict[str, float]] = defaultdict(
        lambda: {"debit": 0.0, "credit": 0.0}
    )
    total_amount = 0.0
    dates: List[str] = []

    for j in journals:
        amount = _journal_amount(j)
        total_amount += amount
        jtype = j.get("journal_type") or "unknown"
        by_type[jtype]["count"] += 1
        by_type[jtype]["amount"] += amount
        by_status[j.get("status") or "unknown"] += 1
        if j.get("journal_date"):
            dates.append(j["journal_date"])
        for li in j.get("line_items", []):
            moves = account_moves[li.get("account_id") or ""]
            moves["debit"] += float(li.get("debit") or 0)
            moves["credit"] += float(li.get("credit") or 0)

    top_accounts = []
    for account_id, moves in sorted(
        account_moves.items(),
        key=lambda kv: kv[1]["debit"] + kv[1]["credit"],
        reverse=True,
    )[:TOP_ACCOUNTS]:
        account = accounts_by_id.get(account_id, {})
        top_accounts.append(
            {
                "account_number": account.get("account_number"),
                "name": account.get("name") or "Unknown account",
                "debit": _money(moves["debit"]),
                "credit": _money(moves["credit"]),
            }
        )

    largest = sorted(journals, key=_journal_amount, reverse=True)[:LARGEST_JOURNALS]

    return {
        "journals_total": len(journals),
        "posted": by_status.get("posted", 0),
        "draft": by_status.get("draft", 0),
        "reversed": by_status.get("reversed", 0),
        "total_amount": _money(total_amount),
        "currency": "GBP",
        "first_date": min(dates) if dates else None,
        "last_date": max(dates) if dates else None,
        "by_type": [
            {"journal_type": t, "count": v["count"], "amount": _money(v["amount"])}
            for t, v in sorted(by_type.items(), key=lambda kv: -kv[1]["amount"])
        ],
        "top_accounts": top_accounts,
        "largest_journals": [
            {
                "id": j["id"],
                "description": j.get("description"),
                "journal_type": j.get("journal_type"),
                "journal_date": j.get("journal_date"),
                "status": j.get("status"),
                "amount": _money(_journal_amount(j)),
            }
            for j in largest
        ],
        "truncated": truncated,
    }


def _narrative_prompt(stats: Dict[str, Any]) -> str:
    return (
        "You are a bookkeeper explaining to a small-business owner what an automatic "
        "journal-generation run just recorded in their books. Write in plain UK "
        "English, no jargon beyond 'journal', 'posted' and 'draft'.\n\n"
        "Use ONLY the figures in the JSON below. Do not invent, estimate or "
        "recalculate any number, and do not give tax or financial advice. Amounts "
        "are in GBP; write them as £1,234.56. 'draft' journals could not be "
        "categorised automatically and wait for the user on the Review tab; "
        "'posted' ones are already in the books.\n\n"
        f"RUN STATS:\n{json.dumps(stats, indent=2, default=str)}\n\n"
        "Return a one-sentence headline, two to four highlights (what kinds of "
        "journals were recorded, the biggest movements), and up to three points "
        "needing attention (e.g. drafts to review, a journal much larger than the "
        "rest). Leave attention empty if nothing needs it."
    )


async def _write_narrative(stats: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    prompt = _narrative_prompt(stats)
    try:
        # Inside the guard: building the client fails without a model key, and that
        # must cost only the narrative, not the figures.
        model = init_chat_model(settings.default_chat_model)
        structured_model = model.with_structured_output(JournalRunNarrative)
        result = cast(
            JournalRunNarrative,
            await asyncio.to_thread(
                lambda: structured_model.invoke([{"role": "user", "content": prompt}])
            ),
        )
    except Exception as e:
        logger.warning("Journal run narrative failed: %s", e)
        return None
    return result.model_dump()


async def _first_narrative(
    run: Dict[str, Any], stats: Dict[str, Any], runs: JournalRunStore
) -> Optional[Dict[str, Any]]:
    narrative = await _write_narrative(stats)
    if narrative is not None:
        try:
            await runs.save_narrative(run["id"], narrative)
        except Exception as e:
            # The user still gets the text; it is written again next time.
            logger.warning("Could not store the journal run narrative: %s", e)
    return narrative


async def _fetch_run_journals(
    service: JournalService, entity_id: UUID, run_id: UUID
) -> List[Dict[str, Any]]:
    def _fetch():
        return (
            service.client.table("journals")
            .select(
                "id, journal_type, journal_date, description, status, created_at, "
                "journal_line_items(account_id, debit, credit, description)"
            )
            .eq("entity_id", str(entity_id))
            .eq("generation_run_id", str(run_id))
            .order("created_at")
            .limit(MAX_RUN_JOURNALS)
            .execute()
        )

    journals = extract_rows(await asyncio.to_thread(_fetch))
    for j in journals:
        j["line_items"] = j.pop("journal_line_items", None) or []
    return journals


async def summarize_journal_run(
    entity_id: UUID,
    run_id: UUID,
    service: JournalService = journal_service,
    include_narrative: bool = True,
    runs: JournalRunStore = journal_runs,
) -> Dict[str, Any]:
    """Stats for the journals this run created, plus a model's narrative.

    ``include_narrative=False`` re-reads the figures without calling the model: the
    tab does that after a draft is posted from Review, so the numbers stay true
    without paying for (or changing) the text.
    """
    run = await runs.get_run(entity_id, run_id)
    if run is None:
        raise JournalRunNotFound(str(run_id))

    journals, accounts = await asyncio.gather(
        _fetch_run_journals(service, entity_id, run_id),
        service.get_chart_of_accounts(),
    )
    stats = build_run_stats(
        journals, accounts, truncated=len(journals) >= MAX_RUN_JOURNALS
    )
    # Nothing was recorded: there is nothing for a model to say.
    narrative = None
    if journals and include_narrative:
        narrative = run.get("narrative") or await _first_narrative(run, stats, runs)
    return {
        "entity_id": str(entity_id),
        "run_id": str(run_id),
        "stats": stats,
        "narrative": narrative,
    }
