"""Inngest functions for PayPal data synchronization.

Orchestrates bulk loading from PayPal Transaction Search API
with paginated extraction and raw event storage.
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
from ...integrations.paypal import PayPalAdapter, ENDPOINTS

logger = logging.getLogger(__name__)

inngest_client = get_client()

BATCH_SIZE = 50
PAGE_DELAY_SECONDS = 1.0


@inngest_client.create_function(
    fn_id="paypal_sync_all",
    trigger=inngest.TriggerEvent(event="paypal/sync.requested"),
    retries=3,
)
async def paypal_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full PayPal sync for all endpoints."""
    source_id: Optional[str] = None

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(f"Starting full PayPal sync for source {source_id}")

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

        await ctx.step.run(
            "update-sync-status",
            lambda: sync_service.update_sync_status(source_id, "syncing"),
        )

        results = {}
        completed_count = 0

        for endpoint in ENDPOINTS.keys():
            endpoint_result = await ctx.step.invoke(
                f"sync-{endpoint}",
                function=paypal_sync_endpoint,
                data={
                    "source_id": source_id,
                    "endpoint": endpoint,
                },
            )
            results[endpoint] = endpoint_result
            completed_count += 1

            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="status",
                data=SyncStatusData(
                    status="syncing",
                    endpoints_completed=completed_count,
                    endpoints_total=len(ENDPOINTS),
                    total_items=sum(
                        r.get("items_stored", 0) for r in results.values()
                    ),
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

        await ctx.step.run(
            "update-sync-status",
            lambda: sync_service.update_sync_status(source_id, "completed"),
        )

        total_items = sum(r.get("items_stored", 0) for r in results.values())

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

        await ctx.step.run(
            "trigger-normalization",
            lambda: inngest_client.send(
                inngest.Event(
                    name="paypal/sync.completed",
                    data={
                        "source_id": source_id,
                        "total_items": total_items,
                        "endpoints": list(results.keys()),
                    },
                )
            ),
        )

        return {
            "status": "completed",
            "source_id": source_id,
            "endpoints": results,
            "total_items": total_items,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error in PayPal sync: {str(e)}")

        if source_id:
            await ctx.step.run(
                "update-sync-status",
                lambda: sync_service.update_sync_status(
                    source_id, "error", error=str(e)
                ),
            )

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
                ctx.logger.error(
                    f"Failed to publish error status: {str(pub_err)}"
                )

        raise


@inngest_client.create_function(
    fn_id="paypal_sync_endpoint",
    trigger=inngest.TriggerEvent(event="paypal/sync.endpoint"),
    retries=3,
)
async def paypal_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync PayPal transactions endpoint with pagination.

    Fetches ALL available historical records (up to 3 years, PayPal's maximum).
    Uses page-number based pagination and continues through all pages until complete.
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
            f"Syncing PayPal {endpoint} for source {source_id} "
            f"(cursor: {resume_cursor or 'start'})"
        )

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

        source = await ctx.step.run(
            "get-source",
            lambda: sync_service.get_external_source(source_id),
        )

        if not source:
            raise ValueError(f"Source not found: {source_id}")

        # PayPal uses compound credentials (JSON with client_id + secret)
        credentials_json = await sync_service.get_api_key(source_id)

        if not credentials_json:
            raise ValueError(
                "Credentials not found - please configure PayPal client_id and secret"
            )

        # Use 3-year lookback (PayPal's maximum) to ensure we fetch all historical data
        adapter = PayPalAdapter(
            credentials_json=credentials_json,
            page_size=500,
            lookback_days=1095,  # 3 years - PayPal's maximum supported range
        )

        cursor = resume_cursor
        items_stored = 0
        pages_processed = 0
        batch: List[Dict[str, Any]] = []

        async for record in adapter.stream_endpoint(endpoint, cursor):
            batch.append(
                {
                    "entity_type": record.entity_type,
                    "external_id": record.external_id,
                    "payload": record.payload,
                    "occurred_at": record.occurred_at,
                }
            )

            if len(batch) >= BATCH_SIZE:
                stored = await ctx.step.run(
                    "store-raw-events-batch",
                    lambda: sync_service.store_raw_events_batch(
                        source_id, "paypal", batch
                    ),
                )
                items_stored += stored
                batch = []
                pages_processed += 1

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

                await ctx.step.sleep(
                    f"rate-limit-{pages_processed}",
                    timedelta(seconds=PAGE_DELAY_SECONDS),
                )

        if batch:
            stored = await ctx.step.run(
                "store-raw-events-batch",
                lambda: sync_service.store_raw_events_batch(
                    source_id, "paypal", batch
                ),
            )
            items_stored += stored

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
            f"Completed PayPal {endpoint} sync: "
            f"{items_stored} items, {pages_processed} pages"
        )

        return {
            "status": "completed",
            "endpoint": endpoint,
            "items_stored": items_stored,
            "pages_processed": pages_processed,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error syncing PayPal {endpoint}: {str(e)}")

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
            ctx.logger.error(
                f"Failed to publish error status: {str(pub_err)}"
            )

        raise


PAYPAL_SYNC_FUNCTIONS = [
    paypal_sync_all,
    paypal_sync_endpoint,
]
