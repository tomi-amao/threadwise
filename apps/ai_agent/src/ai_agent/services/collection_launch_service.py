"""Pushes an entity's upcoming collection/product launches to Zoho Calendar.

Reads collections directly (filtered to launch_date is not null) — unlike
tax deadlines there's no existing frontend derivation to share, since
launch_date is just a plain stored column.
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


def _as_all_day_range(launch_date: date) -> tuple:
    start_at = datetime.combine(launch_date, time.min, tzinfo=timezone.utc)
    end_at = datetime.combine(
        date.fromordinal(launch_date.toordinal() + 1), time.min, tzinfo=timezone.utc
    )
    return start_at, end_at


async def push_collection_launches(
    entity_id: UUID, source_id: UUID, adapter: ZohoCalendarAdapter, calendar_uid: str
) -> Dict[str, Any]:
    """Push every collection with a launch_date set for one entity."""
    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    result = await asyncio.to_thread(
        lambda: client.table("collections")
        .select("id, name, launch_date, status")
        .eq("entity_id", str(entity_id))
        .not_.is_("launch_date", "null")
        .execute()
    )
    collections = cast(List[Dict[str, Any]], result.data or [])

    pushed = 0
    skipped = 0
    errors: List[Dict[str, Any]] = []

    for collection in collections:
        source_key = str(collection["id"])
        try:
            raw_launch_date = collection["launch_date"]
            launch_date = (
                datetime.fromisoformat(raw_launch_date).date()
                if isinstance(raw_launch_date, str)
                else raw_launch_date
            )
            start_at, end_at = _as_all_day_range(launch_date)
            push_result = await calendar_push_service.push_calendar_event(
                adapter=adapter,
                calendar_uid=calendar_uid,
                entity_id=entity_id,
                source_id=source_id,
                source_type="collection_launch",
                source_key=source_key,
                title=f"{collection['name']} — Collection Launch",
                start_at=start_at,
                end_at=end_at,
                all_day=True,
                description=f"Launch of collection '{collection['name']}'.",
            )
            if push_result["action"] == "skipped":
                skipped += 1
            else:
                pushed += 1
        except Exception as e:
            logger.error("Failed to push collection launch %s: %s", source_key, e)
            errors.append({"source_key": source_key, "error": str(e)})

    return {
        "total": len(collections),
        "pushed": pushed,
        "skipped": skipped,
        "errors": errors,
    }
