"""Realtime channel definitions for Inngest streaming.

Defines typed channels for streaming progress updates to the frontend.
Supports both sync operations and normalization pipelines.
"""

from typing import TypedDict

# =============================================================================
# SYNC CHANNELS
# =============================================================================


class SyncProgressData(TypedDict):
    """Progress update data for sync operations."""

    endpoint: str
    status: str  # 'starting', 'syncing', 'completed', 'error'
    items_stored: int
    pages_processed: int
    total_items: int | None
    error: str | None
    timestamp: str


class SyncStatusData(TypedDict):
    """Status update for overall sync operation."""

    status: str  # 'syncing', 'completed', 'error'
    endpoints_completed: int
    endpoints_total: int
    total_items: int
    error: str | None
    timestamp: str


def get_sync_channel(source_id: str) -> str:
    """Get the channel name for a sync operation.

    Args:
        source_id: The external source ID being synced

    Returns:
        Channel name in format 'sync:{source_id}'
    """
    return f"sync:{source_id}"


# Define topics for sync channels
SYNC_TOPICS = ["progress", "status"]


# =============================================================================
# NORMALIZATION CHANNELS
# =============================================================================


class NormalizationProgressData(TypedDict):
    """Progress update data for normalization of a single entity type."""

    entity_type: str  # 'profile', 'product', 'inventory_item', 'order'
    status: str  # 'starting', 'processing', 'completed', 'error'
    events_processed: int
    events_total: int
    events_succeeded: int
    events_failed: int
    error: str | None
    timestamp: str


class NormalizationStatusData(TypedDict):
    """Status update for overall normalization operation."""

    status: str  # 'starting', 'processing', 'completed', 'error'
    mode: str  # 'hard', 'soft'
    entity_types_completed: int
    entity_types_total: int
    total_processed: int
    total_succeeded: int
    total_failed: int
    error: str | None
    timestamp: str


def get_normalization_channel(source_id: str) -> str:
    """Get the channel name for a normalization operation.

    Args:
        source_id: The external source ID being normalized

    Returns:
        Channel name in format 'normalize:{source_id}'
    """
    return f"normalize:{source_id}"


# Define topics for normalization channels
NORMALIZATION_TOPICS = ["progress", "status"]
