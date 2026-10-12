"""Shared push helper for writing ThreadWise's own data out to Zoho Calendar.

Two push sources exist (tax_deadline_service.py, collection_launch_service.py)
and both funnel through push_calendar_event() here rather than duplicating
the create-vs-update-vs-skip logic — see the integration plan's "Push
direction" section.

Idempotency note: calendar_event_links is written *before* calling Zoho's
create endpoint, so a retry that lands after a prior attempt's Zoho call
succeeded but crashed before recording the uid will at least find a
pre-existing link row. It still can't tell "Zoho already has this" apart
from "a prior attempt never got that far" — Zoho's create-event endpoint
has no documented idempotency-key support — so that specific crash window
can still produce a duplicate event. Every other path (unchanged content,
or a content change against an already-linked event) is fully idempotent.
"""

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..integrations.zoho_calendar import ZohoCalendarAdapter

logger = logging.getLogger(__name__)


def compute_content_hash(
    title: str,
    start_at: datetime,
    end_at: datetime,
    description: Optional[str] = None,
) -> str:
    """Hash the fields that matter for "does this event need updating".

    Deliberately excludes anything that changes on every run without the
    underlying fact changing (e.g. a fetch timestamp) — the whole point is
    that re-running with nothing substantively different makes zero Zoho
    API calls.
    """
    raw = "|".join([title, start_at.isoformat(), end_at.isoformat(), description or ""])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CalendarPushService:
    """Service for pushing ThreadWise data to a connected Zoho Calendar."""

    def __init__(self):
        self._client = None

    @property
    def client(self):
        """Lazy load Supabase client."""
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    async def _get_link(
        self, source_id: UUID, source_type: str, source_key: str
    ) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("calendar_event_links")
            .select("external_event_uid, last_pushed_hash")
            .eq("source_id", str(source_id))
            .eq("source_type", source_type)
            .eq("source_key", source_key)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    async def _upsert_link(
        self,
        entity_id: UUID,
        source_id: UUID,
        source_type: str,
        source_key: str,
        calendar_uid: str,
        external_event_uid: Optional[str],
        content_hash: Optional[str],
    ) -> None:
        data = {
            "entity_id": str(entity_id),
            "source_id": str(source_id),
            "source_type": source_type,
            "source_key": source_key,
            "calendar_uid": calendar_uid,
            "external_event_uid": external_event_uid,
            "last_pushed_hash": content_hash,
            "last_pushed_at": datetime.now(timezone.utc).isoformat(),
        }
        await asyncio.to_thread(
            lambda: self.client.table("calendar_event_links")
            .upsert(data, on_conflict="source_id,source_type,source_key")
            .execute()
        )

    async def push_calendar_event(
        self,
        adapter: ZohoCalendarAdapter,
        calendar_uid: str,
        entity_id: UUID,
        source_id: UUID,
        source_type: str,
        source_key: str,
        title: str,
        start_at: datetime,
        end_at: datetime,
        all_day: bool = False,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create or update this item's event in Zoho, or skip if unchanged.

        Returns {"action": "skipped" | "created" | "updated", "event_uid": str}.
        """
        content_hash = compute_content_hash(title, start_at, end_at, description)
        existing = await self._get_link(source_id, source_type, source_key)

        if (
            existing
            and existing.get("external_event_uid")
            and existing.get("last_pushed_hash") == content_hash
        ):
            return {"action": "skipped", "event_uid": existing["external_event_uid"]}

        if existing and existing.get("external_event_uid"):
            event_uid = await adapter.update_event(
                calendar_uid,
                existing["external_event_uid"],
                title,
                start_at,
                end_at,
                all_day,
                description,
            )
            action = "updated"
        else:
            # Reserve the link row before calling Zoho — see module
            # docstring for what this does and doesn't protect against.
            await self._upsert_link(
                entity_id, source_id, source_type, source_key, calendar_uid, None, None
            )
            event_uid = await adapter.create_event(
                calendar_uid, title, start_at, end_at, all_day, description
            )
            action = "created"

        await self._upsert_link(
            entity_id,
            source_id,
            source_type,
            source_key,
            calendar_uid,
            event_uid,
            content_hash,
        )
        return {"action": action, "event_uid": event_uid}


calendar_push_service = CalendarPushService()
