"""Inngest functions for Zoho Calendar synchronization.

Unlike the commerce providers (Shopify/PayPal/Revolut), this source's
endpoints aren't all the same shape: "calendar_events" is a pull (Zoho ->
ThreadWise, into external_raw_events), while "tax_deadlines" and
"collection_launches" are pushes (ThreadWise -> Zoho, via
services/calendar_push_service.py) that never touch external_raw_events at
all. zoho_calendar_sync_endpoint dispatches on the endpoint name rather
than assuming one shape like shopify_sync_endpoint does.

Zoho Calendar events have no incremental "since" cursor the way Shopify's
updated_at_min does, so calendar_events always re-fetches the same rolling
window (see ZohoCalendarAdapter.PULL_WINDOW_PAST_DAYS/FUTURE_DAYS) rather
than resuming from a watermark. The watermark row is still written on
success, but purely for "last synced" display in the UI.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import httpx
import inngest
from inngest.experimental import realtime

from ...core.config import settings
from ...integrations.zoho_calendar import (
    PULL_WINDOW_FUTURE_DAYS,
    PULL_WINDOW_PAST_DAYS,
    ZohoAuthError,
    ZohoCalendarAdapter,
)
from ...normalization.persistence import persistence_service
from ...services.collection_launch_service import push_collection_launches
from ...services.external_sync_service import sync_service
from ...services.tax_deadline_service import push_tax_deadlines
from .channels import SyncProgressData, SyncStatusData, get_sync_channel
from .config import get_client

logger = logging.getLogger(__name__)

inngest_client = get_client()

BATCH_SIZE = 50

# "calendar_events" pulls from Zoho; "tax_deadlines"/"collection_launches"
# push to it — see module docstring.
PULL_ENDPOINTS = ["calendar_events"]
PUSH_ENDPOINTS = ["tax_deadlines", "collection_launches"]
ALL_ENDPOINTS = PULL_ENDPOINTS + PUSH_ENDPOINTS


async def _get_adapter_and_deadlines_uid(
    source_id: str,
) -> tuple[ZohoCalendarAdapter, Optional[str], Optional[str]]:
    """Load credentials for a source and build an adapter.

    Returns (adapter, deadlines_calendar_uid, entity_id). The deadlines
    calendar UID is the source's external_account_id, set once at
    OAuth-connect time (see api/routes/oauth.py) — excluded from every
    pull so events ThreadWise itself pushes there are never re-imported as
    new, and the same UID every push endpoint writes into.
    """
    source = await sync_service.get_external_source(source_id)
    if not source:
        raise ValueError(f"Source not found: {source_id}")

    credentials_json = await sync_service.get_api_key(source_id)
    if not credentials_json:
        raise inngest.NonRetriableError(
            "Zoho Calendar credentials not found — please reconnect"
        )

    adapter = ZohoCalendarAdapter(
        credentials_json=credentials_json,
        accounts_domain=settings.zoho_accounts_domain,
    )
    return adapter, source.get("external_account_id"), source.get("entity_id")


@inngest_client.create_function(
    fn_id="zoho_calendar_sync_all",
    trigger=inngest.TriggerEvent(event="zoho_calendar/sync.requested"),
    retries=3,
)
async def zoho_calendar_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full Zoho Calendar sync across every endpoint."""
    source_id: Optional[str] = None

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        force_full = bool(event_data.get("force_full", False))

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(f"Starting Zoho Calendar sync for source {source_id}")

        channel = get_sync_channel(source_id)
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=SyncStatusData(
                status="syncing",
                endpoints_completed=0,
                endpoints_total=len(ALL_ENDPOINTS),
                total_items=0,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )

        await ctx.step.run(
            "update-sync-status",
            lambda: sync_service.update_sync_status(source_id, "syncing"),
        )

        results: Dict[str, Any] = {}
        completed_count = 0

        for endpoint in ALL_ENDPOINTS:
            endpoint_result = await ctx.step.invoke(
                f"sync-{endpoint}",
                function=zoho_calendar_sync_endpoint,
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
                    endpoints_total=len(ALL_ENDPOINTS),
                    total_items=sum(r.get("items_stored", 0) for r in results.values()),
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

            await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=1))

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
                endpoints_completed=len(ALL_ENDPOINTS),
                endpoints_total=len(ALL_ENDPOINTS),
                total_items=total_items,
                error=None,
                timestamp=datetime.now().isoformat(),
            ),
        )

        await ctx.step.run(
            "trigger-normalization",
            lambda: inngest_client.send(
                inngest.Event(
                    name="zoho_calendar/sync.completed",
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
        ctx.logger.error(f"Error in Zoho Calendar sync: {str(e)}")

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
                        endpoints_total=len(ALL_ENDPOINTS),
                        total_items=0,
                        error=str(e),
                        timestamp=datetime.now().isoformat(),
                    ),
                )
            except Exception as pub_err:
                ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")

        raise


@inngest_client.create_function(
    fn_id="zoho_calendar_sync_endpoint",
    trigger=inngest.TriggerEvent(event="zoho_calendar/sync.endpoint"),
    retries=3,
)
async def zoho_calendar_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single Zoho Calendar endpoint.

    Dispatches on endpoint name — see module docstring for why this
    provider's endpoints aren't all pulls the way every other provider's are.
    """
    endpoint: str = "unknown"
    source_id: Optional[str] = None

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")
        endpoint = event_data.get("endpoint", "unknown")

        if not source_id or endpoint == "unknown":
            raise ValueError("source_id and endpoint are required")

        if endpoint not in ALL_ENDPOINTS:
            raise ValueError(f"Unknown Zoho Calendar endpoint: {endpoint}")

        if endpoint == "tax_deadlines":
            return await _push_tax_deadlines(ctx, source_id)
        if endpoint == "collection_launches":
            return await _push_collection_launches(ctx, source_id)

        return await _sync_calendar_events(ctx, source_id)

    except inngest.NonRetriableError:
        raise
    except Exception as e:
        error_text = str(e)
        ctx.logger.error(f"Error syncing Zoho Calendar {endpoint}: {str(e)}")

        try:
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
                # No synced_at — a failed run doesn't advance the watermark,
                # purely observability (same convention as every other
                # provider's sync_endpoint).
                await ctx.step.run(
                    "set-sync-watermark-error",
                    lambda: sync_service.set_sync_watermark(
                        source_id, endpoint, status="error", error=error_text
                    ),
                )
        except Exception as pub_err:
            ctx.logger.error(f"Failed to publish error status: {str(pub_err)}")

        # A refresh-token failure is permanent until the user reconnects —
        # don't burn retries on it (mirrors ShopifyAdapter's 401/403 handling).
        if isinstance(e, ZohoAuthError):
            raise inngest.NonRetriableError(
                f"Zoho Calendar authentication failed: {e}"
            ) from e
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code in (
            401,
            403,
        ):
            raise inngest.NonRetriableError(
                f"Zoho Calendar API authentication failed: {e}"
            ) from e

        raise


async def _sync_calendar_events(ctx: inngest.Context, source_id: str) -> Dict[str, Any]:
    """Pull every event from every one of the user's calendars except the
    "ThreadWise Deadlines" calendar (which only ever holds events this
    app itself pushed — see get_or_create_deadlines_calendar).
    """
    endpoint = "calendar_events"

    run_started_at = datetime.fromisoformat(
        await ctx.step.run(
            "get-run-start-time",
            lambda: datetime.now(timezone.utc).isoformat(),
        )
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

    adapter, deadlines_uid, _entity_id = await _get_adapter_and_deadlines_uid(source_id)

    calendars = await ctx.step.run(
        "list-calendars",
        adapter.list_calendars,
    )
    target_calendars = [c for c in calendars if c.get("uid") != deadlines_uid]

    ctx.logger.info(
        "Zoho Calendar pull: %d calendar(s) to sync (excluding deadlines "
        "calendar %s)",
        len(target_calendars),
        deadlines_uid,
    )

    window_start = run_started_at - timedelta(days=PULL_WINDOW_PAST_DAYS)
    window_end = run_started_at + timedelta(days=PULL_WINDOW_FUTURE_DAYS)

    items_stored = 0
    pages_processed = 0
    batch: List[Dict[str, Any]] = []
    # Tracks every external_id Zoho actually returned this run, scoped to
    # this run's own window — fed to reconcile_calendar_events below so a
    # since-deleted event (one Zoho no longer returns, but that's still
    # stored from a previous run) gets marked cancelled rather than
    # lingering forever. Raw storage alone can't tell deletions apart from
    # "not re-fetched this time" since it only ever upserts.
    seen_external_ids: set[str] = set()

    for calendar in target_calendars:
        calendar_uid = calendar.get("uid")
        if not calendar_uid:
            continue

        async for record in adapter.stream_events(
            calendar_uid, window_start, window_end
        ):
            seen_external_ids.add(record.external_id)
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
                        source_id, "zoho_calendar", batch
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

        await ctx.step.sleep(f"rate-limit-after-{calendar_uid}", timedelta(seconds=1))

    if batch:
        stored = await ctx.step.run(
            "store-raw-events-batch",
            lambda: sync_service.store_raw_events_batch(
                source_id, "zoho_calendar", batch
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
        f"Completed Zoho Calendar {endpoint} sync: {items_stored} items "
        f"from {len(target_calendars)} calendar(s)"
    )

    cancelled_count = await ctx.step.run(
        "reconcile-cancelled-events",
        lambda: persistence_service.reconcile_calendar_events(
            source_id=UUID(source_id),
            window_start=window_start,
            window_end=window_end,
            seen_external_ids=list(seen_external_ids),
        ),
    )
    if cancelled_count:
        ctx.logger.info(
            "Marked %d calendar_events row(s) cancelled (no longer "
            "returned by Zoho within this run's window)",
            cancelled_count,
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
        "cancelled": cancelled_count,
        "completed_at": datetime.now().isoformat(),
    }


async def _push_tax_deadlines(ctx: inngest.Context, source_id: str) -> Dict[str, Any]:
    """Push every tax deadline for this source's entity to Zoho Calendar."""
    endpoint = "tax_deadlines"

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

    adapter, deadlines_uid, entity_id = await _get_adapter_and_deadlines_uid(source_id)
    if not deadlines_uid or not entity_id:
        raise inngest.NonRetriableError(
            "Zoho Calendar source is missing its deadlines calendar or entity_id"
        )

    push_result = await ctx.step.run(
        "push-tax-deadlines",
        lambda: push_tax_deadlines(
            UUID(entity_id), UUID(source_id), adapter, deadlines_uid
        ),
    )

    await realtime.publish(
        client=inngest_client,
        channel=channel,
        topic="progress",
        data=SyncProgressData(
            endpoint=endpoint,
            status="completed",
            items_stored=push_result["pushed"],
            pages_processed=1,
            total_items=push_result["total"],
            error=None,
            timestamp=datetime.now().isoformat(),
        ),
    )

    await ctx.step.run(
        "set-sync-watermark",
        lambda: sync_service.set_sync_watermark(
            source_id,
            endpoint,
            status="completed",
            synced_at=datetime.now(timezone.utc),
        ),
    )

    return {
        "status": "completed",
        "endpoint": endpoint,
        "items_stored": push_result["pushed"],
        "skipped": push_result["skipped"],
        "errors": push_result["errors"],
        "completed_at": datetime.now().isoformat(),
    }


async def _push_collection_launches(
    ctx: inngest.Context, source_id: str
) -> Dict[str, Any]:
    """Push every launch-dated collection for this source's entity."""
    endpoint = "collection_launches"

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

    adapter, deadlines_uid, entity_id = await _get_adapter_and_deadlines_uid(source_id)
    if not deadlines_uid or not entity_id:
        raise inngest.NonRetriableError(
            "Zoho Calendar source is missing its deadlines calendar or entity_id"
        )

    push_result = await ctx.step.run(
        "push-collection-launches",
        lambda: push_collection_launches(
            UUID(entity_id), UUID(source_id), adapter, deadlines_uid
        ),
    )

    await realtime.publish(
        client=inngest_client,
        channel=channel,
        topic="progress",
        data=SyncProgressData(
            endpoint=endpoint,
            status="completed",
            items_stored=push_result["pushed"],
            pages_processed=1,
            total_items=push_result["total"],
            error=None,
            timestamp=datetime.now().isoformat(),
        ),
    )

    await ctx.step.run(
        "set-sync-watermark",
        lambda: sync_service.set_sync_watermark(
            source_id,
            endpoint,
            status="completed",
            synced_at=datetime.now(timezone.utc),
        ),
    )

    return {
        "status": "completed",
        "endpoint": endpoint,
        "items_stored": push_result["pushed"],
        "skipped": push_result["skipped"],
        "errors": push_result["errors"],
        "completed_at": datetime.now().isoformat(),
    }


@inngest_client.create_function(
    fn_id="zoho_calendar_push_daily",
    trigger=inngest.TriggerCron(cron="0 6 * * *"),  # Daily at 6 AM
)
async def zoho_calendar_push_daily(ctx: inngest.Context) -> Dict[str, Any]:
    """Push tax deadlines and collection launches for every connected
    Zoho Calendar source, once a day.

    Exists so a user isn't stuck waiting up to 24h after filing a return
    or setting a launch date for the calendar to catch up — in practice
    most updates happen via the per-endpoint "sync now" button, which hits
    the same _push_tax_deadlines/_push_collection_launches via
    zoho_calendar_sync_endpoint; this cron is the fallback.
    """
    all_sources = await ctx.step.run(
        "list-zoho-calendar-sources",
        lambda: sync_service.list_external_sources(provider="zoho_calendar"),
    )
    sources = [s for s in all_sources if s.get("api_key_status") == "valid"]

    results = []
    for source in sources:
        source_id = source["id"]
        for endpoint in PUSH_ENDPOINTS:
            try:
                result = await ctx.step.invoke(
                    f"push-{endpoint}-{source_id[:8]}",
                    function=zoho_calendar_sync_endpoint,
                    data={"source_id": source_id, "endpoint": endpoint},
                )
                results.append({"source_id": source_id, **result})
            except Exception as e:
                ctx.logger.error(
                    f"Daily push failed for source {source_id}/{endpoint}: {e}"
                )
                results.append(
                    {"source_id": source_id, "endpoint": endpoint, "error": str(e)}
                )

    return {
        "status": "completed",
        "sources_processed": len(sources),
        "results": results,
        "completed_at": datetime.now().isoformat(),
    }


ZOHO_CALENDAR_SYNC_FUNCTIONS = [
    zoho_calendar_sync_all,
    zoho_calendar_sync_endpoint,
    zoho_calendar_push_daily,
]
