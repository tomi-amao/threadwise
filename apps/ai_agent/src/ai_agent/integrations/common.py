"""Common data models for ThreadWise integration adapters.

Shared dataclasses used across all provider adapters (Squarespace, Revolut, etc.)
for consistent paginated data extraction and raw event storage.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional


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
