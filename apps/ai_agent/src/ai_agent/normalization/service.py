"""Normalization service for statistics, monitoring, and direct processing fallback.

Provides a high-level API for:
- Statistics and monitoring
- Canonical record counts
- Direct processing (for use when Inngest is unavailable)

NOTE: The preferred workflow is through Inngest functions (inngest_functions.py).
This service is primarily used for read-only stats/monitoring operations.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from .models import ProcessingStatus
from .normalizer import NormalizationResult
from .persistence import PersistenceError, persistence_service
from .squarespace_normalizer import SquarespaceNormalizer
from .utils import extract_id, extract_row, extract_rows

logger = logging.getLogger(__name__)

# Suppress verbose HTTP logs from Supabase client
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)

# Provider normalizer registry
NORMALIZER_REGISTRY = {
    "squarespace": SquarespaceNormalizer,
}


class NormalizationService:
    """Service for normalization statistics and monitoring.

    Processing logic has been consolidated into Inngest functions
    (inngest_functions.py) for better retry handling and realtime updates.
    This service retains stats/monitoring and a direct processing fallback.
    """

    def __init__(self):
        """Initialize the normalization service."""
        self._client = None

    @property
    def client(self):
        """Lazy load Supabase client."""
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    def get_normalizer(self, provider: str, entity_id: UUID):
        """Get the appropriate normalizer for a provider."""
        normalizer_class = NORMALIZER_REGISTRY.get(provider)
        if not normalizer_class:
            raise ValueError(
                f"No normalizer for provider: {provider}. "
                f"Supported: {list(NORMALIZER_REGISTRY.keys())}"
            )
        return normalizer_class(entity_id)

    # =========================================================================
    # DIRECT PROCESSING FALLBACK
    # (Use Inngest functions for production workflows)
    # =========================================================================

    async def process_raw_event(
        self, raw_event_id: UUID, force: bool = False
    ) -> Tuple[bool, Optional[UUID], Optional[str]]:
        """Process a single raw event directly (fallback when Inngest unavailable).

        Prefer using trigger_normalization() from inngest_functions.py instead.
        """
        raw_event = await self._get_raw_event(raw_event_id)
        if not raw_event:
            return (False, None, f"Raw event not found: {raw_event_id}")

        if raw_event.get("processing_status") == "completed" and not force:
            return (True, None, "Already processed")

        entity_id = await self._get_entity_id_from_source(raw_event["source_id"])
        if not entity_id:
            error = (
                f"Could not determine entity_id for source: {raw_event['source_id']}"
            )
            await self._mark_failed(raw_event_id, error)
            return (False, None, error)

        await persistence_service.mark_processing(raw_event_id)

        try:
            normalizer = self.get_normalizer(raw_event["provider"], entity_id)
            result = normalizer.normalize(
                entity_type=raw_event["entity_type"],
                external_id=raw_event["external_id"],
                payload=raw_event["payload"],
                raw_event_id=raw_event_id,
            )
            success, canonical_id, error = await persistence_service.persist(result)
            return (success, canonical_id, error)
        except Exception as e:
            error = f"Error processing raw event: {str(e)}"
            logger.exception(error)
            await self._mark_failed(raw_event_id, error)
            return (False, None, error)

    # =========================================================================
    # STATISTICS & MONITORING
    # =========================================================================

    async def get_processing_stats(
        self, source_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get processing statistics.

        Args:
            source_id: Optional filter by source

        Returns:
            Dict with counts by status and entity type
        """

        def _build_query():
            query = self.client.table("external_raw_events").select(
                "processing_status, entity_type"
            )
            if source_id:
                query = query.eq("source_id", source_id)
            return query.execute()

        result = await asyncio.to_thread(_build_query)

        # Aggregate stats
        stats: Dict[str, Any] = {
            "by_status": {},
            "by_entity_type": {},
            "by_status_and_type": {},
        }

        for row in extract_rows(result):
            status = row.get("processing_status", "pending")
            entity_type_val = row["entity_type"]

            # By status
            stats["by_status"][status] = stats["by_status"].get(status, 0) + 1

            # By entity type
            stats["by_entity_type"][entity_type_val] = (
                stats["by_entity_type"].get(entity_type_val, 0) + 1
            )

            # Combined
            key = f"{status}_{entity_type_val}"
            stats["by_status_and_type"][key] = (
                stats["by_status_and_type"].get(key, 0) + 1
            )

        return stats

    async def get_canonical_counts(
        self, entity_id: Optional[UUID] = None
    ) -> Dict[str, int]:
        """Get counts of canonical records.

        Args:
            entity_id: Optional filter by entity

        Returns:
            Dict with counts per table
        """
        tables = ["customers", "orders", "products", "inventory_items", "payments"]
        counts: Dict[str, int] = {}

        for table in tables:

            def _count_query(t=table):
                # Use type: ignore for count parameter - Supabase API accepts string
                query = self.client.table(t).select("id", count="exact")  # type: ignore[arg-type]
                if entity_id:
                    query = query.eq("entity_id", str(entity_id))
                return query.execute()

            result = await asyncio.to_thread(_count_query)
            counts[table] = result.count or 0

        return counts

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    async def _get_raw_event(self, raw_event_id: UUID) -> Optional[Dict[str, Any]]:
        """Fetch a raw event by ID."""
        result = await asyncio.to_thread(
            lambda: self.client.table("external_raw_events")
            .select("*")
            .eq("id", str(raw_event_id))
            .execute()
        )
        return extract_row(result)

    async def _get_entity_id_from_source(self, source_id: str) -> Optional[UUID]:
        """Get entity_id from a source."""
        result = await asyncio.to_thread(
            lambda: self.client.table("external_sources")
            .select("entity_id")
            .eq("id", source_id)
            .execute()
        )
        if result.data:
            return extract_id(result, "entity_id")
        return None

    async def _mark_failed(self, raw_event_id: UUID, error_message: str) -> None:
        """Mark a raw event as failed."""
        await asyncio.to_thread(
            lambda: self.client.table("external_raw_events")
            .update(
                {
                    "processing_status": "failed",
                    "processing_error": error_message,
                    "processed_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", str(raw_event_id))
            .execute()
        )


# Global service instance
normalization_service = NormalizationService()
