"""API routes for data normalization operations.

All normalization operations are routed through Inngest functions for:
- Automatic retries on failure
- Realtime progress streaming to frontend
- Async processing with proper backpressure
- Hard/soft sync mode support

Provides endpoints for:
- Processing individual raw events (via Inngest)
- Batch processing (via Inngest)
- Source normalization with hard/soft mode (via Inngest)
- Reprocessing failed events (via Inngest)
- Statistics and monitoring (direct DB queries)
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ...normalization.inngest_functions import (
    trigger_batch_normalization,
    trigger_normalization,
    trigger_reprocess_failed,
    trigger_source_normalization,
)
from ...normalization.service import normalization_service

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================


class ProcessEventRequest(BaseModel):
    """Request to process a single raw event."""

    raw_event_id: str = Field(description="UUID of the raw event to process")
    force: bool = Field(
        default=False, description="Force reprocessing even if already processed"
    )


class BatchProcessRequest(BaseModel):
    """Request for batch processing."""

    entity_type: Optional[str] = Field(
        default=None, description="Filter by entity type"
    )
    source_id: Optional[str] = Field(default=None, description="Filter by source ID")
    limit: int = Field(
        default=100, ge=1, le=1000, description="Maximum events to process"
    )


class NormalizeSourceRequest(BaseModel):
    """Request to normalize all events for a source."""

    source_id: str = Field(description="External source ID")
    mode: str = Field(
        default="soft",
        description="'hard' resets all events to pending; 'soft' only processes pending events",
    )
    batch_size: int = Field(default=100, ge=1, le=500, description="Events per batch")


class ReprocessFailedRequest(BaseModel):
    """Request to reprocess failed events."""

    source_id: Optional[str] = Field(
        default=None, description="Optional filter by source"
    )
    limit: int = Field(
        default=100, ge=1, le=500, description="Maximum events to reprocess"
    )


class ProcessingResult(BaseModel):
    """Result of a processing operation."""

    success: bool
    canonical_id: Optional[str] = None
    error: Optional[str] = None


class ProcessingStats(BaseModel):
    """Processing statistics."""

    by_status: Dict[str, int]
    by_entity_type: Dict[str, int]
    by_status_and_type: Dict[str, int]


class CanonicalCounts(BaseModel):
    """Counts of canonical records."""

    customers: int
    orders: int
    products: int
    inventory_items: int
    payments: int


# =============================================================================
# INNGEST-BACKED NORMALIZATION ENDPOINTS
# =============================================================================


@router.post("/process")
async def process_raw_event(request: ProcessEventRequest):
    """Queue a single raw event for normalization via Inngest.

    The event will be processed asynchronously with automatic retries.
    """
    try:
        event_uuid = UUID(request.raw_event_id)
        success = await trigger_normalization(event_uuid, force=request.force)

        if not success:
            raise HTTPException(
                status_code=500, detail="Failed to trigger normalization"
            )

        return {
            "status": "queued",
            "raw_event_id": request.raw_event_id,
            "message": "Normalization triggered in background",
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid UUID: {e}")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error triggering normalization")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch")
async def process_batch(request: BatchProcessRequest):
    """Queue a batch of pending raw events for normalization via Inngest.

    Events are processed asynchronously with automatic retries.
    """
    try:
        success = await trigger_batch_normalization(
            entity_type=request.entity_type,
            limit=request.limit,
            source_id=request.source_id,
        )

        if not success:
            raise HTTPException(
                status_code=500, detail="Failed to trigger batch normalization"
            )

        return {
            "status": "queued",
            "message": "Batch normalization triggered in background",
            "entity_type": request.entity_type,
            "limit": request.limit,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error triggering batch normalization")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/normalize-source")
async def normalize_source(request: NormalizeSourceRequest):
    """Normalize all events for a source with hard/soft mode.

    This is the primary endpoint for the "Load Data" UI action.
    Provides realtime progress updates via Inngest Realtime.

    Modes:
    - soft: Only processes events with processing_status='pending'
    - hard: Resets ALL events to 'pending' then reprocesses everything
    """
    try:
        if request.mode not in ("hard", "soft"):
            raise HTTPException(status_code=400, detail="mode must be 'hard' or 'soft'")

        event_ids = await trigger_source_normalization(
            source_id=request.source_id,
            mode=request.mode,
            batch_size=request.batch_size,
        )

        if event_ids is None:
            raise HTTPException(
                status_code=500, detail="Failed to trigger source normalization"
            )

        return {
            "status": "queued",
            "source_id": request.source_id,
            "mode": request.mode,
            "message": f"Source normalization triggered ({request.mode} mode)",
            "event_ids": event_ids,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error triggering source normalization")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reprocess-failed")
async def reprocess_failed(request: Optional[ReprocessFailedRequest] = None):
    """Queue failed events for reprocessing via Inngest.

    Events are retried with force=True to override previous failures.
    """
    try:
        source_id = request.source_id if request else None
        limit = request.limit if request else 100

        success = await trigger_reprocess_failed(source_id=source_id, limit=limit)

        if not success:
            raise HTTPException(
                status_code=500, detail="Failed to trigger reprocessing"
            )

        return {
            "status": "queued",
            "message": "Failed event reprocessing triggered in background",
            "source_id": source_id,
            "limit": limit,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error triggering reprocessing")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/trigger/{raw_event_id}")
async def trigger_single_normalization(
    raw_event_id: str, force: bool = Query(default=False)
):
    """Trigger normalization for a single event via Inngest.

    This queues the event for background processing.
    """
    try:
        event_uuid = UUID(raw_event_id)
        success = await trigger_normalization(event_uuid, force=force)

        if not success:
            raise HTTPException(
                status_code=500, detail="Failed to trigger normalization"
            )

        return {
            "status": "queued",
            "raw_event_id": raw_event_id,
            "message": "Normalization triggered in background",
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid UUID: {e}")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error triggering normalization")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# STATISTICS & MONITORING (Direct DB queries)
# =============================================================================


@router.get("/stats", response_model=ProcessingStats)
async def get_processing_stats(source_id: Optional[str] = Query(default=None)):
    """Get processing statistics.

    Returns counts by status, entity type, and combined status/type.
    """
    try:
        stats = await normalization_service.get_processing_stats(source_id=source_id)
        return ProcessingStats(**stats)

    except Exception as e:
        logger.exception("Error getting processing stats")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/canonical-counts", response_model=CanonicalCounts)
async def get_canonical_counts(entity_id: Optional[str] = Query(default=None)):
    """Get counts of canonical records.

    Returns counts for customers, orders, products, inventory_items, payments.
    """
    try:
        entity_uuid = UUID(entity_id) if entity_id else None
        counts = await normalization_service.get_canonical_counts(entity_id=entity_uuid)

        return CanonicalCounts(**counts)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid UUID: {e}")
    except Exception as e:
        logger.exception("Error getting canonical counts")
        raise HTTPException(status_code=500, detail=str(e))
