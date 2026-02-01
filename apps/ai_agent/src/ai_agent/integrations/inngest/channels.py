"""Realtime channel definitions for Inngest streaming.

Defines typed channels for streaming progress updates to the frontend.
"""

from typing import TypedDict


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
