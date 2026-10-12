"""Pushes an entity's tax deadlines to its connected Zoho Calendar.

Reads the tax_deadlines(p_entity_id) Postgres function — the single source
of truth shared with the frontend's Tax page (tax.server.ts) — rather than
re-deriving the "closed periods x {payment, filing}" logic in Python, which
would risk the calendar and the Tax page disagreeing on a date.
"""

import asyncio
import logging
from datetime import date, datetime, time, timezone
from typing import Any, Dict, List, cast
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..integrations.zoho_calendar import ZohoCalendarAdapter
from .calendar_push_service import calendar_push_service

logger = logging.getLogger(__name__)


def _source_key(deadline: Dict[str, Any]) -> str:
    """One calendar_event_links row per (period, kind) — a period has both
    a payment and a filing deadline, each pushed as its own event."""
    return f"{deadline['period_id']}:{deadline['kind']}"


def _title(deadline: Dict[str, Any]) -> str:
    kind_label = "Payment" if deadline["kind"] == "payment" else "Filing"
    return f"{deadline['label']} — Corporation Tax {kind_label} Due"


def _description(deadline: Dict[str, Any]) -> str:
    if deadline["kind"] == "payment" and deadline.get("amount") is not None:
        return f"Corporation tax payment of £{deadline['amount']} due."
    return f"Corporation tax {deadline['kind']} deadline."


def _as_all_day_range(due_date: date) -> tuple:
    """A deadline is a single day — model it as an all-day event spanning
    that day (Zoho's all-day convention: end is exclusive, i.e. the next
    day), consistent with how the pull side already treats all-day events.
    """
    start_at = datetime.combine(due_date, time.min, tzinfo=timezone.utc)
    end_at = datetime.combine(
        date.fromordinal(due_date.toordinal() + 1), time.min, tzinfo=timezone.utc
    )
    return start_at, end_at


async def push_tax_deadlines(
    entity_id: UUID, source_id: UUID, adapter: ZohoCalendarAdapter, calendar_uid: str
) -> Dict[str, Any]:
    """Push every non-satisfied-in-the-past-sense tax deadline for one entity.

    Pushes every deadline tax_deadlines() returns (overdue/due_soon/upcoming
    *and* satisfied) rather than filtering — a satisfied deadline that's
    already in the calendar should still get updated (not deleted) if its
    status or amount later changes; deletion/cancellation handling is out
    of scope for this phase.
    """
    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    result = await asyncio.to_thread(
        lambda: client.rpc("tax_deadlines", {"p_entity_id": str(entity_id)}).execute()
    )
    deadlines = cast(List[Dict[str, Any]], result.data or [])

    pushed = 0
    skipped = 0
    errors: List[Dict[str, Any]] = []

    for deadline in deadlines:
        try:
            start_at, end_at = _as_all_day_range(
                datetime.fromisoformat(deadline["due_date"]).date()
                if isinstance(deadline["due_date"], str)
                else deadline["due_date"]
            )
            push_result = await calendar_push_service.push_calendar_event(
                adapter=adapter,
                calendar_uid=calendar_uid,
                entity_id=entity_id,
                source_id=source_id,
                source_type="tax_deadline",
                source_key=_source_key(deadline),
                title=_title(deadline),
                start_at=start_at,
                end_at=end_at,
                all_day=True,
                description=_description(deadline),
            )
            if push_result["action"] == "skipped":
                skipped += 1
            else:
                pushed += 1
        except Exception as e:
            logger.error("Failed to push tax deadline %s: %s", _source_key(deadline), e)
            errors.append({"source_key": _source_key(deadline), "error": str(e)})

    return {
        "total": len(deadlines),
        "pushed": pushed,
        "skipped": skipped,
        "errors": errors,
    }
