"""Inngest functions for external data synchronization.

Orchestrates bulk loading from external APIs (Squarespace, etc.)
with slow pagination and raw event storage.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import inngest
from inngest.experimental import realtime

from .config import get_client
from .channels import get_sync_channel, SyncProgressData, SyncStatusData
from ...services.external_sync_service import sync_service
from ...integrations.squarespace import SquarespaceAdapter, ENDPOINTS

logger = logging.getLogger(__name__)

# Get the Inngest client
inngest_client = get_client()

# Batch size for storing events
BATCH_SIZE = 50

# Delay between pages (rate limiting)
PAGE_DELAY_SECONDS = 1.0


@inngest_client.create_function(
    fn_id="squarespace_sync_all",
    trigger=inngest.TriggerEvent(event="squarespace/sync.requested"),
    retries=3,
)
async def squarespace_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full Squarespace sync for all endpoints.
    
    This function triggers individual endpoint syncs sequentially
    to respect rate limits.
    """
    source_id: Optional[str] = None
    
    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        
        if not source_id:
            raise ValueError("source_id is required")
        
        ctx.logger.info(f"Starting full Squarespace sync for source {source_id}")
        
        # Publish initial status
        channel = get_sync_channel(source_id)
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=SyncStatusData(
                status="syncing",
                endpoints_completed=0,
                endpoints_total=len(ENDPOINTS),
                total_items=0,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )
        
        # Update sync status
        await ctx.step.run("update-sync-status", lambda: sync_service.update_sync_status(source_id, "syncing"))
        
        # Sync each endpoint sequentially
        results = {}
        completed_count = 0
        
        for endpoint in ENDPOINTS.keys():
            endpoint_result = await ctx.step.invoke(
                f"sync-{endpoint}",
                function=squarespace_sync_endpoint,
                data={
                    "source_id": source_id,
                    "endpoint": endpoint,
                }
            )
            results[endpoint] = endpoint_result
            completed_count += 1
            
            # Publish progress update
            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="status",
                data=SyncStatusData(
                    status="syncing",
                    endpoints_completed=completed_count,
                    endpoints_total=len(ENDPOINTS),
                    total_items=sum(r.get("items_stored", 0) for r in results.values()),
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )
            
            # Small delay between endpoints
            await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=2))
        
        # Mark sync as completed
        await ctx.step.run("update-sync-status", lambda: sync_service.update_sync_status(source_id, "completed"))
        
        total_items = sum(r.get("items_stored", 0) for r in results.values())
        
        # Publish final status
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=SyncStatusData(
                status="completed",
                endpoints_completed=len(ENDPOINTS),
                endpoints_total=len(ENDPOINTS),
                total_items=total_items,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )
        
        return {
            "status": "completed",
            "source_id": source_id,
            "endpoints": results,
            "total_items": total_items,
            "completed_at": datetime.now().isoformat()
        }
        
    except Exception as e:
        ctx.logger.error(f"Error in Squarespace sync: {str(e)}")
        
        # Update status to error
        if source_id:
            await ctx.step.run("update-sync-status", lambda: sync_service.update_sync_status(source_id, "error", error=str(e)))
            
            # Publish error status
            try:
                channel = get_sync_channel(source_id)
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="status",
                    data=SyncStatusData(
                        status="error",
                        endpoints_completed=0,
                        endpoints_total=len(ENDPOINTS),
                        total_items=0,
                        error=str(e),
                        timestamp=datetime.now().isoformat(),
                    ),
                )
            except Exception as pub_err:
                ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")
        
        raise


@inngest_client.create_function(
    fn_id="squarespace_sync_endpoint",
    trigger=inngest.TriggerEvent(event="squarespace/sync.endpoint"),
    retries=3,
)
async def squarespace_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single Squarespace endpoint with pagination.
    
    Paginates slowly and stores raw events without transformation.
    """
    endpoint: str = "unknown"
    
    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        endpoint = event_data.get("endpoint", "unknown")
        resume_cursor = event_data.get("cursor")
        
        if not source_id or endpoint == "unknown":
            raise ValueError("source_id and endpoint are required")
        
        if endpoint not in ENDPOINTS:
            raise ValueError(f"Unknown endpoint: {endpoint}")
        
        ctx.logger.info(
            f"Syncing {endpoint} for source {source_id} "
            f"(cursor: {resume_cursor or 'start'})"
        )
        
        # Publish initial progress
        channel = get_sync_channel(source_id)
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="progress",
            data=SyncProgressData(
                endpoint=endpoint,
                status="starting",
                items_stored=0,
                pages_processed=0,
                total_items=None,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )
        
        # Get source and API key
        source = await ctx.step.run("get-source", lambda: sync_service.get_external_source(source_id))
        
        if not source:
            raise ValueError(f"Source not found: {source_id}")
        
        # Get API key from Vault (secure storage)
        api_key = await sync_service.get_api_key(source_id)
        
        if not api_key:
            raise ValueError("API key not found - please configure credentials")
        
        # Initialize adapter
        adapter = SquarespaceAdapter(api_key=api_key, page_size=50)
        
        # Process pages
        cursor = resume_cursor or source.get("sync_cursor")
        items_stored = 0
        pages_processed = 0
        batch: List[Dict[str, Any]] = []
        
        async for record in adapter.stream_endpoint(endpoint, cursor):
            batch.append({
                "entity_type": record.entity_type,
                "external_id": record.external_id,
                "payload": record.payload,
                "occurred_at": record.occurred_at,
            })
            
            # Store in batches
            if len(batch) >= BATCH_SIZE:
                stored = await ctx.step.run("store-raw-events-batch", lambda: sync_service.store_raw_events_batch(source_id, "squarespace", batch))
                items_stored += stored
                batch = []
                pages_processed += 1
                
                # Publish progress update
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="progress",
                    data=SyncProgressData(
                        endpoint=endpoint,
                        status="syncing",
                        items_stored=items_stored,
                        pages_processed=pages_processed,
                        total_items=None,
                        error=None,
                        timestamp=datetime.now().isoformat(),
                    ),
                )
                
                # Rate limiting delay
                await ctx.step.sleep(f"rate-limit-{pages_processed}", timedelta(seconds=PAGE_DELAY_SECONDS))
        
        # Store remaining items
        if batch:
            stored = await ctx.step.run("store-raw-events-batch", lambda: sync_service.store_raw_events_batch(source_id, "squarespace", batch))
            items_stored += stored
        
        # Publish completion status
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="progress",
            data=SyncProgressData(
                endpoint=endpoint,
                status="completed",
                items_stored=items_stored,
                pages_processed=pages_processed,
                total_items=items_stored,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )
        
        ctx.logger.info(
            f"Completed {endpoint} sync: {items_stored} items, {pages_processed} pages"
        )
        
        return {
            "status": "completed",
            "endpoint": endpoint,
            "items_stored": items_stored,
            "pages_processed": pages_processed,
            "completed_at": datetime.now().isoformat()
        }
        
    except Exception as e:
        ctx.logger.error(f"Error syncing {endpoint}: {str(e)}")
        
        # Publish error status
        try:
            event_data = ctx.event.data
            source_id = event_data.get("source_id")
            if source_id:
                channel = get_sync_channel(source_id)
                await realtime.publish(
                    client=inngest_client,
                    channel=channel,
                    topic="progress",
                    data=SyncProgressData(
                        endpoint=endpoint,
                        status="error",
                        items_stored=0,
                        pages_processed=0,
                        total_items=None,
                        error=str(e),
                        timestamp=datetime.now().isoformat(),
                    ),
                )
        except Exception as pub_err:
            ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")
        
        raise


@inngest_client.create_function(
    fn_id="squarespace_sync_single_endpoint",
    trigger=inngest.TriggerEvent(event="squarespace/sync.single_endpoint"),
    retries=3,
)
async def squarespace_sync_single_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single endpoint (manual trigger for specific endpoints)."""
    # Reuse the endpoint sync logic
    return await squarespace_sync_endpoint(ctx)


# List of all sync functions for export
SYNC_FUNCTIONS = [
    squarespace_sync_all,
    squarespace_sync_endpoint,
    squarespace_sync_single_endpoint,
]
