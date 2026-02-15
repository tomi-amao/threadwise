"""External sync service for storing raw events in Supabase.

Handles bulk loading of raw API data without transformation.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union, cast

from ..core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


class ExternalSyncService:
    """Service for managing external data synchronization."""

    def __init__(self):
        """Initialize the sync service."""
        self._client = None

    @property
    def client(self):
        """Lazy load Supabase client."""
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    # =========================================================================
    # ENTITY MANAGEMENT
    # =========================================================================

    async def create_entity(
        self,
        name: str,
        currency: str,
        legal_name: Optional[str] = None,
        country: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new entity.

        Args:
            name: Entity name
            currency: 3-letter currency code
            legal_name: Optional legal name
            country: Optional country code

        Returns:
            Created entity record
        """
        data = {
            "name": name,
            "currency": currency,
            "legal_name": legal_name,
            "country": country,
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("entities").insert(data).execute()
        )
        return result.data[0] if result.data else None

    async def get_entity(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """Get an entity by ID."""
        result = await asyncio.to_thread(
            lambda: self.client.table("entities")
            .select("*")
            .eq("id", entity_id)
            .execute()
        )
        return result.data[0] if result.data else None

    async def list_entities(self) -> List[Dict[str, Any]]:
        """List all entities."""
        result = await asyncio.to_thread(
            lambda: self.client.table("entities")
            .select("*")
            .order("created_at")
            .execute()
        )
        return result.data or []

    # =========================================================================
    # EXTERNAL SOURCE MANAGEMENT
    # =========================================================================

    async def create_external_source(
        self,
        entity_id: str,
        provider: str,
        external_account_id: str,
        credentials: Dict[str, Any],
        display_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new external source connection.

        Args:
            entity_id: Parent entity ID
            provider: Provider name (e.g., 'squarespace')
            external_account_id: External account identifier
            credentials: Dict with 'api_key' - will be stored securely in Vault
            display_name: Optional display name

        Returns:
            Created external source record
        """
        # First create the source record (without credentials)
        data = {
            "entity_id": str(entity_id),
            "provider": provider,
            "external_account_id": external_account_id,
            "display_name": display_name,
            "sync_status": "idle",
            "api_key_status": "pending",
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("external_sources").insert(data).execute()
        )

        if not result.data:
            return None

        source = result.data[0]

        # Store API key securely in Vault using our function
        api_key = credentials.get("api_key")
        if api_key:
            try:
                await asyncio.to_thread(
                    lambda: self.client.rpc(
                        "store_api_key_secure",
                        {
                            "p_source_id": source["id"],
                            "p_api_key": api_key,
                            "p_provider": provider,
                        },
                    ).execute()
                )
                logger.info(
                    f"Stored API key securely in Vault for source {source['id']}"
                )
            except Exception as e:
                logger.error(f"Failed to store API key in Vault: {e}")
                # Fall back to legacy storage (will be migrated later)
                await asyncio.to_thread(
                    lambda: self.client.table("external_sources")
                    .update({"credentials": credentials})
                    .eq("id", source["id"])
                    .execute()
                )

        # Refetch to get updated data
        result = await asyncio.to_thread(
            lambda: self.client.table("external_sources")
            .select("*")
            .eq("id", source["id"])
            .execute()
        )
        return result.data[0] if result.data else source

    async def get_api_key(self, source_id: str) -> Optional[str]:
        """Retrieve decrypted API key for a source.

        Uses Vault's secure decryption - only for server-side use.

        Args:
            source_id: External source ID

        Returns:
            Decrypted API key or None
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.client.rpc(
                    "get_api_key_secure", {"p_source_id": source_id}
                ).execute()
            )
            return result.data if result.data else None
        except Exception as e:
            logger.error(f"Failed to retrieve API key from Vault: {e}")
            return None

    async def update_api_key_status(
        self, source_id: str, status: str, error: Optional[str] = None
    ) -> None:
        """Update API key validation status.

        Args:
            source_id: External source ID
            status: 'pending', 'valid', 'invalid', or 'expired'
            error: Optional error message
        """
        try:
            await asyncio.to_thread(
                lambda: self.client.rpc(
                    "update_api_key_status",
                    {"p_source_id": source_id, "p_status": status, "p_error": error},
                ).execute()
            )
        except Exception as e:
            logger.error(f"Failed to update API key status: {e}")

    async def get_external_source(self, source_id: str) -> Optional[Dict[str, Any]]:
        """Get an external source by ID."""
        result = await asyncio.to_thread(
            lambda: self.client.table("external_sources")
            .select("*")
            .eq("id", source_id)
            .execute()
        )
        return result.data[0] if result.data else None

    async def list_external_sources(
        self, entity_id: Optional[str] = None, provider: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List external sources with optional filtering."""

        def _query():
            query = self.client.table("external_sources").select("*, entities(name)")

            if entity_id:
                query = query.eq("entity_id", entity_id)
            if provider:
                query = query.eq("provider", provider)

            return query.order("created_at").execute()

        result = await asyncio.to_thread(_query)
        return result.data or []

    async def update_sync_status(
        self,
        source_id: str,
        status: str,
        cursor: Optional[str] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update sync status for an external source.

        Args:
            source_id: External source ID
            status: New status ('idle', 'syncing', 'error', 'completed')
            cursor: Optional pagination cursor
            error: Optional error message
        """
        data = {
            "sync_status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        if cursor is not None:
            data["sync_cursor"] = cursor

        if status == "completed":
            data["last_synced_at"] = datetime.now(timezone.utc).isoformat()
            data["sync_error"] = None

        if error:
            data["sync_error"] = error

        result = await asyncio.to_thread(
            lambda: self.client.table("external_sources")
            .update(data)
            .eq("id", source_id)
            .execute()
        )
        return result.data[0] if result.data else None

    # =========================================================================
    # RAW EVENT STORAGE
    # =========================================================================

    async def store_raw_event(
        self,
        source_id: str,
        provider: str,
        entity_type: str,
        external_id: str,
        payload: Dict[str, Any],
        occurred_at: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Store a single raw event.

        Uses upsert to handle re-syncs gracefully.

        Args:
            source_id: Parent external source ID
            provider: Provider name
            entity_type: Type of entity
            external_id: External identifier
            payload: Raw API payload (never transformed)
            occurred_at: When event occurred in source system
        """
        data = {
            "source_id": source_id,
            "provider": provider,
            "entity_type": entity_type,
            "external_id": external_id,
            "payload": payload,
            "occurred_at": occurred_at.isoformat() if occurred_at else None,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

        # Upsert based on unique constraint (provider, entity_type, external_id)
        result = await asyncio.to_thread(
            lambda: self.client.table("external_raw_events")
            .upsert(data, on_conflict="provider,entity_type,external_id")
            .execute()
        )
        return result.data[0] if result.data else None

    async def store_raw_events_batch(
        self, source_id: str, provider: str, events: List[Dict[str, Any]]
    ) -> int:
        """Store multiple raw events in a batch.

        Args:
            source_id: Parent external source ID
            provider: Provider name
            events: List of event dicts with entity_type, external_id, payload, occurred_at

        Returns:
            Number of events stored
        """
        if not events:
            return 0

        now = datetime.now(timezone.utc).isoformat()

        data = [
            {
                "source_id": source_id,
                "provider": provider,
                "entity_type": event["entity_type"],
                "external_id": event["external_id"],
                "payload": event["payload"],
                "occurred_at": (
                    event["occurred_at"].isoformat()
                    if event.get("occurred_at")
                    else None
                ),
                "fetched_at": now,
            }
            for event in events
        ]

        result = await asyncio.to_thread(
            lambda: self.client.table("external_raw_events")
            .upsert(data, on_conflict="provider,entity_type,external_id")
            .execute()
        )

        return len(result.data) if result.data else 0

    async def get_raw_events(
        self,
        source_id: Optional[str] = None,
        provider: Optional[str] = None,
        entity_type: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Query raw events with optional filtering."""

        def _query():
            query = self.client.table("external_raw_events").select("*")

            if source_id:
                query = query.eq("source_id", source_id)
            if provider:
                query = query.eq("provider", provider)
            if entity_type:
                query = query.eq("entity_type", entity_type)

            return query.order("fetched_at", desc=True).limit(limit).execute()

        result = await asyncio.to_thread(_query)
        return result.data or []

    async def get_sync_stats(self, source_id: str) -> Dict[str, int]:
        """Get sync statistics for a source.

        Returns count of unique items by entity type (deduplicated by external_id).
        """
        # Use RPC call to get distinct counts per entity_type
        # This ensures we count unique items, not duplicate sync records
        result = await asyncio.to_thread(
            lambda: self.client.rpc(
                "get_sync_stats_by_source", {"p_source_id": source_id}
            ).execute()
        )

        stats = {}
        for row in result.data or []:
            entity_type = row["entity_type"]
            stats[entity_type] = row["unique_count"]

        return stats


# Global service instance
sync_service = ExternalSyncService()
