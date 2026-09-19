"""Realtime channel definitions for Inngest streaming.

Defines typed channels for streaming progress updates to the frontend.
Supports both sync operations and normalization pipelines.
"""

from typing import Any, TypedDict

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


# =============================================================================
# JOURNAL GENERATION CHANNELS
# =============================================================================


class JournalStepProgressData(TypedDict):
    """Progress update for one step of the journal-generation pipeline.

    One step (e.g. "journal_payments") covers a whole batch of items
    (e.g. all unjournaled payments) — this is step-level granularity, not
    per-item, unlike SyncProgressData's per-page updates within an endpoint.
    step is one of: journal_payments, journal_settlements, journal_inbound,
    journal_expenses.
    """

    step: str
    title: str
    status: str  # 'starting', 'completed', 'error'
    created: int
    skipped: int
    # Item-level errors (e.g. one payment's accrual journal failed to
    # create) — each dict looks like {"payment_id" | "transaction_id": str,
    # "error": str}. Distinct from step_error below, which is the whole
    # step failing outright (e.g. the unjournaled-items query itself erroring).
    errors: list[dict[str, Any]]
    total_items: int | None
    step_error: str | None
    # journal_inbound only: per-category breakdown (funding/sales_receipt/
    # refund/fx_conversion/merchant) and PayPal passthrough classification —
    # None for every other step.
    by_type: dict[str, Any] | None
    passthrough: dict[str, Any] | None
    timestamp: str


class JournalPipelineStatusData(TypedDict):
    """Status update for the overall journal-generation pipeline."""

    status: str  # 'running', 'completed', 'completed_with_errors', 'error'
    scope: str  # 'all', 'payments', 'transactions'
    steps_completed: int
    steps_total: int
    total_created: int
    total_skipped: int
    total_errors: int
    error: str | None
    timestamp: str


def get_journal_channel(entity_id: str) -> str:
    """Get the channel name for a journal-generation run.

    Args:
        entity_id: The entity whose journals are being generated

    Returns:
        Channel name in format 'journals:{entity_id}'
    """
    return f"journals:{entity_id}"


# Define topics for journal-generation channels
JOURNAL_TOPICS = ["progress", "status"]
