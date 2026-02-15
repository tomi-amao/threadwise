"""Inngest functions for data normalization pipeline.

This is the primary orchestrator for all normalization and persistence workflows.
All normalization operations should flow through these Inngest functions to benefit
from automatic retries, realtime progress updates, and async processing.

Supports:
- Single event normalization
- Batch normalization by entity type
- Full source normalization (with dependency ordering)
- Hard/soft sync modes
- Automatic post-sync normalization
- Failed event reprocessing
- Realtime progress streaming to frontend
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

import inngest  # type: ignore
from inngest.experimental import realtime

from ..integrations.inngest.channels import (
    NormalizationProgressData,
    NormalizationStatusData,
    get_normalization_channel,
)
from ..integrations.inngest.config import get_client
from .models import ProcessingStatus
from .normalizer import NormalizationResult
from .persistence import persistence_service
from .squarespace_normalizer import SquarespaceNormalizer
from .utils import extract_id, extract_row, extract_rows

logger = logging.getLogger(__name__)

# Get the Inngest client
inngest_client = get_client()

# Batch size for processing
BATCH_SIZE = 50

# Supported providers and their normalizers
PROVIDER_NORMALIZERS = {
    "squarespace": SquarespaceNormalizer,
}

# Entity type processing order (respects foreign key dependencies)
ENTITY_TYPE_ORDER = ["profile", "product", "inventory_item", "order", "transaction"]


def get_normalizer(provider: str, entity_id: UUID):
    """Get the appropriate normalizer for a provider."""
    normalizer_class = PROVIDER_NORMALIZERS.get(provider)
    if not normalizer_class:
        raise ValueError(f"No normalizer found for provider: {provider}")
    return normalizer_class(entity_id)


# =============================================================================
# NORMALIZATION FUNCTIONS
# =============================================================================


@inngest_client.create_function(
    fn_id="normalize_raw_event",
    trigger=inngest.TriggerEvent(event="normalization/event.received"),
    retries=3,
)
async def normalize_raw_event(ctx: inngest.Context) -> Dict[str, Any]:
    """Normalize a single raw event.

    Triggered when a new raw event is stored or when reprocessing is requested.

    Event data:
        - raw_event_id: UUID of the raw event to process
        - force: Boolean to force reprocessing even if already processed
    """
    try:
        event_data = ctx.event.data
        raw_event_id = UUID(event_data.get("raw_event_id"))
        force = event_data.get("force", False)

        ctx.logger.info(f"Normalizing raw event {raw_event_id}")

        # Step 1: Fetch the raw event
        raw_event = await ctx.step.run(
            "fetch-raw-event", lambda: _fetch_raw_event(raw_event_id)
        )

        if not raw_event:
            return {"status": "error", "error": f"Raw event not found: {raw_event_id}"}

        # Check if already processed
        if raw_event.get("processing_status") == "completed" and not force:
            return {
                "status": "skipped",
                "reason": "Already processed",
                "raw_event_id": str(raw_event_id),
            }

        # Step 2: Mark as processing
        await ctx.step.run(
            "mark-processing", lambda: persistence_service.mark_processing(raw_event_id)
        )

        # Step 3: Get entity_id from source
        entity_id_str = await ctx.step.run(
            "get-entity-id", lambda: _get_entity_id_from_source(raw_event["source_id"])
        )

        if not entity_id_str:
            return {
                "status": "error",
                "error": f"Could not determine entity_id for source: {raw_event['source_id']}",
            }

        # Convert back to UUID for normalizer
        entity_id = UUID(entity_id_str)

        # Step 4: Normalize
        result_dict = await ctx.step.run(
            "normalize",
            lambda: _normalize_event(
                provider=raw_event["provider"],
                entity_type=raw_event["entity_type"],
                external_id=raw_event["external_id"],
                payload=raw_event["payload"],
                raw_event_id=raw_event_id,
                entity_id=entity_id,
            ),
        )

        # Step 5: Persist (need to re-normalize to get full NormalizationResult)
        persist_result = await ctx.step.run(
            "persist",
            lambda: _persist_event(
                provider=raw_event["provider"],
                entity_type=raw_event["entity_type"],
                external_id=raw_event["external_id"],
                payload=raw_event["payload"],
                raw_event_id=raw_event_id,
                entity_id=entity_id,
            ),
        )

        success = persist_result["success"]
        canonical_id = persist_result["canonical_id"]
        error = persist_result["error"]

        return {
            "status": "completed" if success else "failed",
            "raw_event_id": str(raw_event_id),
            "entity_type": raw_event["entity_type"],
            "external_id": raw_event["external_id"],
            "canonical_id": str(canonical_id) if canonical_id else None,
            "error": error,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error normalizing raw event: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="normalize_batch",
    trigger=inngest.TriggerEvent(event="normalization/batch.requested"),
    retries=2,
)
async def normalize_batch(ctx: inngest.Context) -> Dict[str, Any]:
    """Process a batch of pending raw events for a specific entity type.

    Event data:
        - entity_type: Optional filter by entity type
        - limit: Max events to process (default 100)
        - source_id: Optional filter by source
        - source_id_for_channel: Optional source_id for realtime channel
    """
    try:
        event_data = ctx.event.data
        entity_type = event_data.get("entity_type")
        limit = event_data.get("limit", 100)
        source_id = event_data.get("source_id")
        channel_source_id = event_data.get("source_id_for_channel")

        ctx.logger.info(
            f"Starting batch normalization (type={entity_type}, limit={limit})"
        )

        # Step 1: Get pending events
        pending_events = await ctx.step.run(
            "fetch-pending-events",
            lambda: _fetch_pending_events(
                entity_type=entity_type, limit=limit, source_id=source_id
            ),
        )

        if not pending_events:
            return {
                "status": "completed",
                "events_processed": 0,
                "events_total": 0,
                "completed": 0,
                "failed": 0,
                "skipped": 0,
                "message": "No pending events found",
            }

        ctx.logger.info(f"Found {len(pending_events)} pending events")

        # Step 2: Process each event
        results = {"completed": 0, "failed": 0, "skipped": 0, "errors": []}

        for i, raw_event in enumerate(pending_events):
            raw_event_id = UUID(raw_event["id"])

            try:
                event_result = await ctx.step.invoke(
                    f"normalize-{i}-{raw_event['external_id'][:8]}",
                    function=normalize_raw_event,
                    data={"raw_event_id": str(raw_event_id), "force": False},
                )

                if event_result.get("status") == "completed":
                    results["completed"] += 1
                elif event_result.get("status") == "skipped":
                    results["skipped"] += 1
                else:
                    results["failed"] += 1
                    results["errors"].append(
                        {
                            "raw_event_id": str(raw_event_id),
                            "error": event_result.get("error"),
                        }
                    )

            except Exception as e:
                results["failed"] += 1
                results["errors"].append(
                    {"raw_event_id": str(raw_event_id), "error": str(e)}
                )

            # Publish progress update if we have a channel
            if channel_source_id and entity_type:
                total_done = (
                    results["completed"] + results["failed"] + results["skipped"]
                )
                try:
                    channel = get_normalization_channel(channel_source_id)
                    await realtime.publish(
                        client=inngest_client,
                        channel=channel,
                        topic="progress",
                        data=NormalizationProgressData(
                            entity_type=entity_type,
                            status="processing",
                            events_processed=total_done,
                            events_total=len(pending_events),
                            events_succeeded=results["completed"],
                            events_failed=results["failed"],
                            error=None,
                            timestamp=datetime.now().isoformat(),
                        ),
                    )
                except Exception as pub_err:
                    ctx.logger.warning(f"Failed to publish progress: {pub_err}")

            # Small delay between events
            if i < len(pending_events) - 1:
                await ctx.step.sleep(f"delay-{i}", timedelta(milliseconds=100))

        # Publish completion for this entity type
        if channel_source_id and entity_type:
            try:
                channel = get_normalization_channel(channel_source_id)
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="progress",
                    data=NormalizationProgressData(
                        entity_type=entity_type,
                        status="completed",
                        events_processed=len(pending_events),
                        events_total=len(pending_events),
                        events_succeeded=results["completed"],
                        events_failed=results["failed"],
                        error=None,
                        timestamp=datetime.now().isoformat(),
                    ),
                )
            except Exception as pub_err:
                ctx.logger.warning(f"Failed to publish completion: {pub_err}")

        return {
            "status": "completed",
            "events_total": len(pending_events),
            **results,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error in batch normalization: {str(e)}")
        raise


# =============================================================================
# SOURCE NORMALIZATION (Primary entry point for UI)
# =============================================================================


@inngest_client.create_function(
    fn_id="normalize_source",
    trigger=inngest.TriggerEvent(event="normalization/source.requested"),
    retries=2,
)
async def normalize_source(ctx: inngest.Context) -> Dict[str, Any]:
    """Normalize all raw events for a specific source.

    This is the primary entry point for the UI "Load Data" action.
    Processes events in dependency order with realtime progress updates.
    Supports hard/soft sync modes.

    Event data:
        - source_id: External source ID (required)
        - mode: 'hard' or 'soft' (default: 'soft')
          - hard: Resets all processing_status to 'pending' before processing
          - soft: Only processes events that are still 'pending'
        - batch_size: Events per batch (default: 100)
    """
    source_id = None
    mode = "soft"

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        mode = event_data.get("mode", "soft")
        batch_size = event_data.get("batch_size", 100)

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(f"Starting source normalization for {source_id} (mode={mode})")

        channel = get_normalization_channel(source_id)

        # Publish initial status
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=NormalizationStatusData(
                status="starting",
                mode=mode,
                entity_types_completed=0,
                entity_types_total=len(ENTITY_TYPE_ORDER),
                total_processed=0,
                total_succeeded=0,
                total_failed=0,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )

        # Step 1: If hard mode, reset processing status
        if mode == "hard":
            reset_count = await ctx.step.run(
                "reset-processing-status", lambda: _reset_processing_status(source_id)
            )
            ctx.logger.info(f"Hard mode: reset {reset_count} events to pending")

        # Step 2: Process each entity type in dependency order
        all_results = {}
        total_succeeded = 0
        total_failed = 0
        completed_types = 0

        for entity_type in ENTITY_TYPE_ORDER:
            # Publish progress for starting this entity type
            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="progress",
                data=NormalizationProgressData(
                    entity_type=entity_type,
                    status="starting",
                    events_processed=0,
                    events_total=0,
                    events_succeeded=0,
                    events_failed=0,
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

            # Count pending events for this type
            pending_count = await ctx.step.run(
                f"count-pending-{entity_type}",
                lambda et=entity_type: _count_pending_events(
                    entity_type=et, source_id=source_id
                ),
            )

            if pending_count == 0:
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="progress",
                    data=NormalizationProgressData(
                        entity_type=entity_type,
                        status="completed",
                        events_processed=0,
                        events_total=0,
                        events_succeeded=0,
                        events_failed=0,
                        error=None,
                        timestamp=datetime.now().isoformat(),
                    ),
                )
                completed_types += 1
                all_results[entity_type] = {
                    "completed": 0,
                    "failed": 0,
                    "skipped": 0,
                    "events_total": 0,
                }
                continue

            # Process in batches
            type_results = {
                "completed": 0,
                "failed": 0,
                "skipped": 0,
                "events_total": 0,
            }
            offset_batch = 0

            while True:
                batch_result = await ctx.step.invoke(
                    f"normalize-{entity_type}-batch-{offset_batch}",
                    function=normalize_batch,
                    data={
                        "entity_type": entity_type,
                        "source_id": source_id,
                        "limit": batch_size,
                        "source_id_for_channel": source_id,
                    },
                )

                batch_total = batch_result.get("events_total", 0)
                type_results["completed"] += batch_result.get("completed", 0)
                type_results["failed"] += batch_result.get("failed", 0)
                type_results["skipped"] += batch_result.get("skipped", 0)
                type_results["events_total"] += batch_total

                if batch_total < batch_size:
                    break

                offset_batch += 1
                await ctx.step.sleep(
                    f"delay-batch-{entity_type}-{offset_batch}",
                    timedelta(milliseconds=200),
                )

            all_results[entity_type] = type_results
            total_succeeded += type_results["completed"]
            total_failed += type_results["failed"]
            completed_types += 1

            # Publish overall status update
            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="status",
                data=NormalizationStatusData(
                    status="processing",
                    mode=mode,
                    entity_types_completed=completed_types,
                    entity_types_total=len(ENTITY_TYPE_ORDER),
                    total_processed=total_succeeded + total_failed,
                    total_succeeded=total_succeeded,
                    total_failed=total_failed,
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

            await ctx.step.sleep(f"delay-after-{entity_type}", timedelta(seconds=1))

        # Publish final completion status
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=NormalizationStatusData(
                status="completed",
                mode=mode,
                entity_types_completed=len(ENTITY_TYPE_ORDER),
                entity_types_total=len(ENTITY_TYPE_ORDER),
                total_processed=total_succeeded + total_failed,
                total_succeeded=total_succeeded,
                total_failed=total_failed,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )

        return {
            "status": "completed",
            "source_id": source_id,
            "mode": mode,
            "entity_types": all_results,
            "total_succeeded": total_succeeded,
            "total_failed": total_failed,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error in source normalization: {str(e)}")

        if source_id:
            try:
                channel = get_normalization_channel(source_id)
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="status",
                    data=NormalizationStatusData(
                        status="error",
                        mode=mode,
                        entity_types_completed=0,
                        entity_types_total=len(ENTITY_TYPE_ORDER),
                        total_processed=0,
                        total_succeeded=0,
                        total_failed=0,
                        error=str(e),
                        timestamp=datetime.now().isoformat(),
                    ),
                )
            except Exception as pub_err:
                ctx.logger.error(f"Failed to publish error status: {pub_err}")

        raise


@inngest_client.create_function(
    fn_id="normalize_after_sync",
    trigger=inngest.TriggerEvent(event="squarespace/sync.completed"),
    retries=2,
)
async def normalize_after_sync(ctx: inngest.Context) -> Dict[str, Any]:
    """Trigger normalization after a sync completes.

    Automatically processes all new raw events from a sync using soft mode.
    """
    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        total_items = event_data.get("total_items", 0)

        ctx.logger.info(
            f"Triggering normalization after sync for source {source_id} "
            f"({total_items} items)"
        )

        # Delegate to normalize_source with soft mode
        result = await ctx.step.invoke(
            "normalize-source-after-sync",
            function=normalize_source,
            data={
                "source_id": source_id,
                "mode": "soft",
                "batch_size": 100,
            },
        )

        return {
            "status": "completed",
            "source_id": source_id,
            "normalization_result": result,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error in post-sync normalization: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="reprocess_failed_events",
    trigger=inngest.TriggerCron(cron="0 */6 * * *"),  # Every 6 hours
)
async def reprocess_failed_events(ctx: inngest.Context) -> Dict[str, Any]:
    """Periodically retry failed normalizations."""
    try:
        ctx.logger.info("Starting reprocessing of failed events")

        failed_events = await ctx.step.run(
            "fetch-failed-events", lambda: _fetch_failed_events(limit=100)
        )

        if not failed_events:
            return {
                "status": "completed",
                "events_retried": 0,
                "message": "No failed events to reprocess",
            }

        ctx.logger.info(f"Found {len(failed_events)} failed events to retry")

        results = {"retried": 0, "succeeded": 0, "failed_again": 0}

        for raw_event in failed_events:
            raw_event_id = raw_event["id"]

            event_result = await ctx.step.invoke(
                f"retry-{raw_event_id[:8]}",
                function=normalize_raw_event,
                data={"raw_event_id": raw_event_id, "force": True},
            )

            results["retried"] += 1
            if event_result.get("status") == "completed":
                results["succeeded"] += 1
            else:
                results["failed_again"] += 1

        return {
            "status": "completed",
            **results,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error reprocessing failed events: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="reprocess_stuck_processing_events",
    trigger=inngest.TriggerCron(cron="0 */2 * * *"),  # Every 2 hours
)
async def reprocess_stuck_processing_events(ctx: inngest.Context) -> Dict[str, Any]:
    """Periodically reprocess events stuck in 'processing' status.

    Sometimes raw events get stuck in 'processing' status due to crashes or timeouts.
    This cron job finds events that have been processing for more than 30 minutes
    and resets them to 'pending' so they can be reprocessed.
    """
    try:
        ctx.logger.info("Starting reprocessing of stuck events")

        # Fetch events stuck in processing for more than 30 minutes
        stuck_events = await ctx.step.run(
            "fetch-stuck-events",
            lambda: _fetch_stuck_processing_events(minutes_threshold=30, limit=100),
        )

        if not stuck_events:
            return {
                "status": "completed",
                "events_reset": 0,
                "message": "No stuck events found",
            }

        ctx.logger.info(f"Found {len(stuck_events)} stuck events to reset")

        results = {"reset": 0, "succeeded": 0, "failed_again": 0}

        for raw_event in stuck_events:
            raw_event_id = raw_event["id"]

            # Reset the event status to pending
            await ctx.step.run(
                f"reset-{raw_event_id[:8]}",
                lambda: _reset_event_to_pending(raw_event_id),
            )
            results["reset"] += 1

            # Then reprocess it
            event_result = await ctx.step.invoke(
                f"reprocess-{raw_event_id[:8]}",
                function=normalize_raw_event,
                data={"raw_event_id": raw_event_id, "force": True},
            )

            if event_result.get("status") == "completed":
                results["succeeded"] += 1
            else:
                results["failed_again"] += 1

        return {
            "status": "completed",
            **results,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error reprocessing stuck events: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="reprocess_failed_manual",
    trigger=inngest.TriggerEvent(event="normalization/reprocess.requested"),
    retries=1,
)
async def reprocess_failed_manual(ctx: inngest.Context) -> Dict[str, Any]:
    """Manually triggered reprocessing of failed events.

    Event data:
        - source_id: Optional filter by source
        - limit: Max events to reprocess (default 100)
    """
    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        limit = event_data.get("limit", 100)

        ctx.logger.info(
            f"Manual reprocessing triggered (source={source_id}, limit={limit})"
        )

        failed_events = await ctx.step.run(
            "fetch-failed-events",
            lambda: _fetch_failed_events(limit=limit, source_id=source_id),
        )

        if not failed_events:
            return {
                "status": "completed",
                "events_retried": 0,
                "message": "No failed events to reprocess",
            }

        results = {"retried": 0, "succeeded": 0, "failed_again": 0}

        for raw_event in failed_events:
            raw_event_id = raw_event["id"]

            event_result = await ctx.step.invoke(
                f"retry-{raw_event_id[:8]}",
                function=normalize_raw_event,
                data={"raw_event_id": raw_event_id, "force": True},
            )

            results["retried"] += 1
            if event_result.get("status") == "completed":
                results["succeeded"] += 1
            else:
                results["failed_again"] += 1

        return {
            "status": "completed",
            **results,
            "processed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error in manual reprocessing: {str(e)}")
        raise


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


async def _fetch_raw_event(raw_event_id: UUID) -> Optional[Dict[str, Any]]:
    """Fetch a raw event by ID."""
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")
    result = await asyncio.to_thread(
        lambda: client.table("external_raw_events")
        .select("*")
        .eq("id", str(raw_event_id))
        .execute()
    )
    return extract_row(result)


async def _get_entity_id_from_source(source_id: str) -> Optional[str]:
    """Get entity_id from source."""
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")
    result = await asyncio.to_thread(
        lambda: client.table("external_sources")
        .select("entity_id")
        .eq("id", source_id)
        .execute()
    )
    if result.data:
        entity_id = extract_id(result, "entity_id")
        return str(entity_id) if entity_id else None
    return None


async def _normalize_event(
    provider: str,
    entity_type: str,
    external_id: str,
    payload: Dict[str, Any],
    raw_event_id: UUID,
    entity_id: UUID,
) -> Dict[str, Any]:
    """Normalize a single event (async for step function).

    Returns a serializable dict instead of NormalizationResult for Inngest compatibility.
    """
    normalizer = get_normalizer(provider, entity_id)
    result = normalizer.normalize(entity_type, external_id, payload, raw_event_id)

    # Convert to serializable dict (NormalizationResult is not JSON-serializable)
    return {
        "success": result.success,
        "status": result.status.value,
        "entity_type": result.entity_type,
        "external_id": result.external_id,
        "raw_event_id": str(result.raw_event_id) if result.raw_event_id else None,
        "error_message": result.error_message,
        "error_details": result.error_details,
        "warnings": result.warnings,
        "needs_review": result.needs_review,
        "review_reason": result.review_reason,
        "processed_at": (
            result.processed_at.isoformat() if result.processed_at else None
        ),
        # Note: canonical object is intentionally omitted as it's not serializable
        # and will be reconstructed during persistence
    }


async def _persist_event(
    provider: str,
    entity_type: str,
    external_id: str,
    payload: Dict[str, Any],
    raw_event_id: UUID,
    entity_id: UUID,
) -> Dict[str, Any]:
    """Normalize and persist an event (async for step function).

    Returns a serializable dict with persistence results.
    """
    normalizer = get_normalizer(provider, entity_id)
    result = normalizer.normalize(entity_type, external_id, payload, raw_event_id)

    # Persist the result
    success, canonical_id, error = await persistence_service.persist(result)

    return {
        "success": success,
        "canonical_id": str(canonical_id) if canonical_id else None,
        "error": error,
    }


async def _fetch_pending_events(
    entity_type: Optional[str] = None, limit: int = 100, source_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Fetch pending raw events."""
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    def _query():
        query = (
            client.table("external_raw_events")
            .select("*")
            .eq("processing_status", "pending")
        )

        if entity_type:
            query = query.eq("entity_type", entity_type)
        if source_id:
            query = query.eq("source_id", source_id)

        return query.order("fetched_at").limit(limit).execute()

    result = await asyncio.to_thread(_query)
    return extract_rows(result)


async def _count_pending_events(
    entity_type: Optional[str] = None, source_id: Optional[str] = None
) -> int:
    """Count pending raw events."""
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    def _query():
        query = (
            client.table("external_raw_events")
            .select("id", count="exact")
            .eq("processing_status", "pending")
        )

        if entity_type:
            query = query.eq("entity_type", entity_type)
        if source_id:
            query = query.eq("source_id", source_id)

        return query.execute()

    result = await asyncio.to_thread(_query)
    return result.count or 0


async def _fetch_failed_events(
    limit: int = 100,
    source_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Fetch failed raw events for retry."""
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    def _query():
        query = (
            client.table("external_raw_events")
            .select("*")
            .eq("processing_status", "failed")
            .order("fetched_at")
            .limit(limit)
        )

        if source_id:
            query = query.eq("source_id", source_id)

        return query.execute()

    result = await asyncio.to_thread(_query)
    return extract_rows(result)


async def _fetch_stuck_processing_events(
    minutes_threshold: int = 30,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Fetch raw events stuck in 'processing' status for more than threshold minutes.

    Args:
        minutes_threshold: How many minutes an event can be in processing before considered stuck
        limit: Maximum number of events to fetch

    Returns:
        List of stuck raw events
    """
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    # Calculate the threshold timestamp
    threshold_time = datetime.now() - timedelta(minutes=minutes_threshold)

    def _query():
        # Find events that are in 'processing' status and were fetched more than threshold ago
        # Using fetched_at as proxy for when processing started
        query = (
            client.table("external_raw_events")
            .select("*")
            .eq("processing_status", "processing")
            .lt("fetched_at", threshold_time.isoformat())
            .order("fetched_at")
            .limit(limit)
        )

        return query.execute()

    result = await asyncio.to_thread(_query)
    return extract_rows(result)


async def _reset_event_to_pending(raw_event_id: UUID) -> bool:
    """Reset a raw event's processing status to pending.

    Args:
        raw_event_id: The event ID to reset

    Returns:
        True if successful, False otherwise
    """
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    def _update():
        return (
            client.table("external_raw_events")
            .update(
                {
                    "processing_status": "pending",
                    "processing_error": None,
                    "processed_at": None,
                }
            )
            .eq("id", str(raw_event_id))
            .execute()
        )

    result = await asyncio.to_thread(_update)
    return bool(result.data)


async def _reset_processing_status(source_id: str) -> int:
    """Reset processing_status to 'pending' for all events in a source.

    Used in hard sync mode to force reprocessing of all events.

    Returns:
        Number of events reset
    """
    from ..core.supabase_client import get_supabase_client

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    def _update():
        return (
            client.table("external_raw_events")
            .update(
                {
                    "processing_status": "pending",
                    "processing_error": None,
                    "processed_at": None,
                }
            )
            .eq("source_id", source_id)
            .neq("processing_status", "pending")
            .execute()
        )

    result = await asyncio.to_thread(_update)
    return len(result.data) if result.data else 0


# =============================================================================
# EVENT TRIGGERS (Called from API routes)
# =============================================================================


async def trigger_normalization(raw_event_id: UUID, force: bool = False) -> bool:
    """Trigger normalization for a single raw event."""
    try:
        await inngest_client.send(
            inngest.Event(
                name="normalization/event.received",
                data={
                    "raw_event_id": str(raw_event_id),
                    "force": force,
                },
            )
        )
        return True
    except Exception as e:
        logger.error(f"Failed to trigger normalization: {e}")
        return False


async def trigger_batch_normalization(
    entity_type: Optional[str] = None, limit: int = 100, source_id: Optional[str] = None
) -> bool:
    """Trigger batch normalization."""
    try:
        await inngest_client.send(
            inngest.Event(
                name="normalization/batch.requested",
                data={
                    "entity_type": entity_type,
                    "limit": limit,
                    "source_id": source_id,
                },
            )
        )
        return True
    except Exception as e:
        logger.error(f"Failed to trigger batch normalization: {e}")
        return False


async def trigger_source_normalization(
    source_id: str,
    mode: str = "soft",
    batch_size: int = 100,
) -> Optional[List[str]]:
    """Trigger normalization for all events in a source.

    Args:
        source_id: External source ID
        mode: 'hard' or 'soft'
        batch_size: Events per batch

    Returns:
        List of event IDs if successful, None on failure
    """
    try:
        event_ids = await inngest_client.send(
            inngest.Event(
                name="normalization/source.requested",
                data={
                    "source_id": source_id,
                    "mode": mode,
                    "batch_size": batch_size,
                },
            )
        )
        return event_ids
    except Exception as e:
        logger.error(f"Failed to trigger source normalization: {e}")
        return None


async def trigger_reprocess_failed(
    source_id: Optional[str] = None,
    limit: int = 100,
) -> bool:
    """Trigger reprocessing of failed events."""
    try:
        await inngest_client.send(
            inngest.Event(
                name="normalization/reprocess.requested",
                data={
                    "source_id": source_id,
                    "limit": limit,
                },
            )
        )
        return True
    except Exception as e:
        logger.error(f"Failed to trigger reprocessing: {e}")
        return False


# =============================================================================
# EXPORT FUNCTIONS
# =============================================================================

NORMALIZATION_FUNCTIONS = [
    normalize_raw_event,
    normalize_batch,
    normalize_source,
    normalize_after_sync,
    reprocess_failed_events,
    reprocess_stuck_processing_events,
    reprocess_failed_manual,
]
