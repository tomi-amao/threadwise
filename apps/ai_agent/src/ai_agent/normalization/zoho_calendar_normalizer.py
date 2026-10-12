"""Zoho Calendar normalizer: raw event payload -> CanonicalCalendarEvent.

Deliberately does not import anything from integrations/zoho_calendar — the
normalization layer only ever sees the JSON already stored in
external_raw_events.payload, never talks to Zoho's API directly, and keeps
its own tiny datetime parser rather than reaching back into the adapter
layer for one.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import UUID

from .calendar_normalizer import CalendarNormalizer
from .models import CanonicalCalendarEvent
from .normalizer import NormalizationResult

logger = logging.getLogger(__name__)


# Zoho's docs describe top-level "start"/"end" fields in "yyyyMMdd'T'HHmmss"
# format, but real payloads (confirmed against a live Zoho account, both a
# timed and an all-day event) never actually have top-level start/end at
# all — only a nested "dateandtime" object, and its format differs by
# event type: all-day is a bare "yyyyMMdd" date, timed is
# "yyyyMMdd'T'HHmmss+HHMM" with an explicit UTC offset (not "Z").
def _parse_zoho_event_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    if len(value) == 8 and value.isdigit():
        try:
            return datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y%m%dT%H%M%S%z", "%Y%m%dT%H%M%SZ"):
        try:
            parsed = datetime.strptime(value, fmt)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    logger.warning("Could not parse Zoho event datetime: %r", value)
    return None


class ZohoCalendarNormalizer(CalendarNormalizer):
    """Normalizer for Zoho Calendar events."""

    provider = "zoho_calendar"

    def normalize_calendar_event(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        calendar_uid = payload.get("caluid")
        if not calendar_uid:
            return NormalizationResult.failure_result(
                entity_type="calendar_event",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message="Zoho event payload is missing caluid",
            )

        dateandtime = payload.get("dateandtime") or {}

        canonical = CanonicalCalendarEvent(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            entity_id=self.entity_id,
            calendar_uid=calendar_uid,
            title=payload.get("title"),
            description=payload.get("description"),
            location=payload.get("location"),
            start_at=_parse_zoho_event_datetime(dateandtime.get("start")),
            end_at=_parse_zoho_event_datetime(dateandtime.get("end")),
            all_day=bool(payload.get("isallday", False)),
            organizer=payload.get("organizer"),
            attendees=payload.get("attendees") or [],
            # Zoho's events-list response doesn't document a cancellation
            # flag — deletions are handled by reconciliation (comparing
            # what a pull run sees against what's already stored), not by
            # a provider-reported status value. See the integration plan's
            # "Pull direction" section.
            status="confirmed",
            # created_at/updated_at are left unset: Zoho's createdtime/
            # lastmodifiedtime format isn't confirmed (unlike start/end,
            # which the module docstring in integrations/zoho_calendar
            # verified against live docs), so coercing them into a
            # datetime field risks a validation error on every event.
            # Both are preserved as-is in raw_metadata below regardless.
            raw_metadata=payload,
        )

        return NormalizationResult.success_result(
            canonical=canonical,
            entity_type="calendar_event",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )
