"""Inngest functions for Revolut data synchronization.

Orchestrates bulk loading from Revolut Business API endpoints
with paginated extraction and raw event storage.
"""

import logging
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
import inngest
from inngest.experimental import realtime

from ...core.supabase_client import get_supabase_client
from ...integrations.common import resolve_sync_since
from ...integrations.revolut import ENDPOINTS, RevolutAdapter
from ...integrations.revolut.receipts import (
    ReceiptRef,
    known_receipt_ids,
    receipts_to_fetch,
    store_receipt,
)
from ...services.external_sync_service import sync_service
from .channels import SyncProgressData, SyncStatusData, get_sync_channel
from .config import get_client, utc_now_iso

logger = logging.getLogger(__name__)

inngest_client = get_client()

BATCH_SIZE = 50
PAGE_DELAY_SECONDS = 1.0

# Receipts have their own sync watermark. Each run re-reads this far back before it, because a
# receipt is often attached days or weeks after the payment; receipts already stored are skipped.
RECEIPTS_SYNC_KEY = "receipts"
RECEIPT_LOOKBACK = timedelta(days=90)
RECEIPTS_PER_STEP = 10


@inngest_client.create_function(
    fn_id="revolut_sync_all",
    trigger=inngest.TriggerEvent(event="revolut/sync.requested"),
    retries=3,
)
async def revolut_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full Revolut sync for all endpoints."""
    source_id: str = ""

    try:
        event_data: Dict[str, Any] = dict(ctx.event.data)
        source_id = event_data.get("source_id") or ""
        force_full = bool(event_data.get("force_full", False))

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(
            f"Starting {'full' if force_full else 'incremental'} Revolut sync "
            f"for source {source_id}"
        )

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
                function=revolut_sync_endpoint,
                data={
                    "source_id": source_id,
                    "endpoint": endpoint,
                    "force_full": force_full,
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
                    total_items=sum(r.get("items_stored", 0) for r in results.values()),
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

            await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=2))

        # Attachments are extra: a business without the Expenses API, or a failed download,
        # must not fail the sync of its transactions.
        try:
            results["receipts"] = await ctx.step.invoke(
                "sync-receipts",
                function=revolut_sync_receipts,
                data={"source_id": source_id, "force_full": force_full},
            )
        except inngest.StepError as e:
            ctx.logger.warning(f"Revolut receipts not synced for {source_id}: {e}")

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
                    name="revolut/sync.completed",
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
        error_text = str(e)
        ctx.logger.error(f"Error in Revolut sync: {str(e)}")

        if source_id:
            await ctx.step.run(
                "update-sync-status",
                lambda: sync_service.update_sync_status(
                    source_id, "error", error=error_text
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
                ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")

        raise


@inngest_client.create_function(
    fn_id="revolut_sync_endpoint",
    trigger=inngest.TriggerEvent(event="revolut/sync.endpoint"),
    retries=3,
)
async def revolut_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single Revolut endpoint with pagination.

    Fetches ALL historical records by paginating through all available pages.
    Revolut uses timestamp-based pagination (most recent first, working backwards).
    The adapter will continue fetching until no more records are available.
    """
    endpoint: str = "unknown"

    try:
        event_data: Dict[str, Any] = dict(ctx.event.data)
        source_id: str = event_data.get("source_id") or ""
        endpoint = event_data.get("endpoint", "unknown")
        resume_cursor = event_data.get("cursor")
        force_full = bool(event_data.get("force_full", False))

        if not source_id or endpoint == "unknown":
            raise ValueError("source_id and endpoint are required")

        if endpoint not in ENDPOINTS:
            raise ValueError(f"Unknown endpoint: {endpoint}")

        ctx.logger.info(
            f"Syncing Revolut {endpoint} for source {source_id} "
            f"(cursor: {resume_cursor or 'start'}, force_full: {force_full})"
        )

        run_started_at = datetime.fromisoformat(
            await ctx.step.run(
                "get-run-start-time",
                utc_now_iso,
            )
        )

        since = None
        if not force_full:

            async def _get_watermark() -> Optional[str]:
                watermark = await sync_service.get_sync_watermark(source_id, endpoint)
                return watermark.isoformat() if watermark else None

            watermark_iso = await ctx.step.run("get-sync-watermark", _get_watermark)
            watermark = datetime.fromisoformat(watermark_iso) if watermark_iso else None
            since = resolve_sync_since(watermark, force_full=False)

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

        api_key = await sync_service.get_api_key(source_id)

        if not api_key:
            raise inngest.NonRetriableError(
                "API key not found - please configure credentials"
            )

        adapter = RevolutAdapter(api_key=api_key, page_size=100)

        cursor = resume_cursor or source.get("sync_cursor")
        items_stored = 0
        pages_processed = 0
        batch: List[Dict[str, Any]] = []

        async for record in adapter.stream_endpoint(endpoint, cursor, since=since):
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
                        source_id, "revolut", batch
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
                    source_id, "revolut", batch
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
            f"Completed Revolut {endpoint} sync: "
            f"{items_stored} items, {pages_processed} pages"
        )

        await ctx.step.run(
            "set-sync-watermark",
            lambda: sync_service.set_sync_watermark(
                source_id, endpoint, status="completed", synced_at=run_started_at
            ),
        )

        return {
            "status": "completed",
            "endpoint": endpoint,
            "items_stored": items_stored,
            "pages_processed": pages_processed,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        error_text = str(e)
        ctx.logger.error(f"Error syncing Revolut {endpoint}: {str(e)}")

        try:
            event_data = dict(ctx.event.data)
            source_id = event_data.get("source_id") or ""
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
                await ctx.step.run(
                    "set-sync-watermark-error",
                    lambda: sync_service.set_sync_watermark(
                        source_id, endpoint, status="error", error=error_text
                    ),
                )
        except Exception as pub_err:
            ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")

        # 401/403 are permanent - the same key will fail every retry, so
        # don't burn ~100s of exponential backoff (retries=3) on a call
        # that can never succeed.
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code in (
            401,
            403,
        ):
            raise inngest.NonRetriableError(
                f"Revolut API authentication failed: {e}"
            ) from e

        raise


@inngest_client.create_function(
    fn_id="revolut_sync_receipts",
    trigger=inngest.TriggerEvent(event="revolut/sync.receipts"),
    retries=3,
)
async def revolut_sync_receipts(ctx: inngest.Context) -> Dict[str, Any]:
    """Copy new Revolut receipts onto their transactions (integrations/revolut/receipts.py).

    Lists the expenses since the last run (less RECEIPT_LOOKBACK), downloads each receipt not
    stored yet, and stores it in batches of RECEIPTS_PER_STEP so a retry repeats little.
    """
    event_data: Dict[str, Any] = dict(ctx.event.data)
    source_id: str = event_data.get("source_id") or ""
    force_full = bool(event_data.get("force_full", False))
    if not source_id:
        raise ValueError("source_id is required")

    run_started_at = datetime.fromisoformat(
        await ctx.step.run("get-run-start-time", utc_now_iso)
    )

    async def _get_watermark() -> Optional[str]:
        watermark = await sync_service.get_sync_watermark(source_id, RECEIPTS_SYNC_KEY)
        return watermark.isoformat() if watermark else None

    watermark_iso = (
        None if force_full else await ctx.step.run("get-sync-watermark", _get_watermark)
    )
    since = (
        datetime.fromisoformat(watermark_iso) - RECEIPT_LOOKBACK
        if watermark_iso
        else None
    )

    source = await ctx.step.run(
        "get-source", lambda: sync_service.get_external_source(source_id)
    )
    if not source or not source.get("entity_id"):
        raise inngest.NonRetriableError(
            f"Source not found or has no business: {source_id}"
        )
    entity_id = str(source["entity_id"])

    api_key = await sync_service.get_api_key(source_id)
    if not api_key:
        raise inngest.NonRetriableError(
            "API key not found - please configure credentials"
        )
    adapter = RevolutAdapter(api_key=api_key, page_size=100)

    def _client():
        client = get_supabase_client()
        if client is None:
            raise RuntimeError("Supabase is not configured")
        return client

    async def _find_new() -> List[Dict[str, str]]:
        known = await known_receipt_ids(_client(), entity_id)
        try:
            expenses = [e async for e in adapter.list_expenses(since)]
        except httpx.HTTPStatusError as e:
            # Revolut enables the Expenses API per business; without it this never works.
            if e.response.status_code in (401, 403):
                raise inngest.NonRetriableError(
                    f"Revolut Expenses API is not available: {e}"
                ) from e
            raise
        return [asdict(r) for r in receipts_to_fetch(expenses, known)]

    refs = await ctx.step.run("find-new-receipts", _find_new)

    stored = 0
    missing = 0
    for start in range(0, len(refs), RECEIPTS_PER_STEP):
        chunk = refs[start : start + RECEIPTS_PER_STEP]

        async def _store(chunk: List[Dict[str, str]] = chunk) -> Dict[str, int]:
            client = _client()
            done = gone = 0
            for raw in chunk:
                ref = ReceiptRef(**raw)
                try:
                    content, content_type = await adapter.download_receipt(
                        ref.expense_id, ref.receipt_id
                    )
                except httpx.HTTPStatusError as e:
                    # Removed in Revolut since the expense was listed: nothing to keep.
                    if e.response.status_code == 404:
                        gone += 1
                        continue
                    raise
                await store_receipt(client, entity_id, ref, content, content_type)
                done += 1
            return {"stored": done, "missing": gone}

        batch = await ctx.step.run(
            f"store-receipts-{start // RECEIPTS_PER_STEP}", _store
        )
        stored += batch["stored"]
        missing += batch["missing"]

    await ctx.step.run(
        "set-sync-watermark",
        lambda: sync_service.set_sync_watermark(
            source_id, RECEIPTS_SYNC_KEY, status="completed", synced_at=run_started_at
        ),
    )
    ctx.logger.info(
        f"Revolut receipts for {source_id}: {stored} stored, {missing} no longer in Revolut"
    )
    return {
        "status": "completed",
        "receipts_stored": stored,
        "receipts_missing": missing,
    }


REVOLUT_SYNC_FUNCTIONS = [
    revolut_sync_all,
    revolut_sync_endpoint,
    revolut_sync_receipts,
]
