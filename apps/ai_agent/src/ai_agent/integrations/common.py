"""Common data models for ThreadWise integration adapters.

Shared dataclasses used across all provider adapters (Squarespace, Revolut, etc.)
for consistent paginated data extraction and raw event storage.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# Applied to a sync watermark before using it as the lower bound of an
# incremental fetch. Covers two real risks with time-based incremental sync:
# clock skew between our server and the provider's, and records that are
# committed but not yet visible to the provider's own search/index (Shopify
# and PayPal have both been observed to lag briefly here). Re-fetching a few
# extra minutes of already-seen records is free — store_raw_events_batch
# upserts on (provider, entity_type, external_id) — so this errs generous.
SYNC_OVERLAP = timedelta(minutes=15)


def resolve_sync_since(
    watermark: Optional[datetime], *, force_full: bool
) -> Optional[datetime]:
    """Compute the lower bound to pass to an adapter's incremental fetch.

    Args:
        watermark: The endpoint's last successful sync watermark (start time
            of that run), or None if it has never completed a sync.
        force_full: If True, ignore the watermark and return None (adapters
            treat since=None as "fetch full history").

    Returns:
        None (full historical fetch) or watermark - SYNC_OVERLAP.
    """
    if force_full or watermark is None:
        return None
    return watermark - SYNC_OVERLAP


@dataclass
class PaginatedResult:
    """Result from a paginated API call."""

    items: List[Dict[str, Any]]
    cursor: Optional[str]
    has_more: bool
    endpoint: str
    fetched_at: datetime


@dataclass
class RawEventRecord:
    """Raw event record to be stored in external_raw_events."""

    provider: str
    entity_type: str
    external_id: str
    payload: Dict[str, Any]
    occurred_at: Optional[datetime]
    fetched_at: datetime
