"""Inngest functions for Revolut data synchronization.

Orchestrates bulk loading from Revolut Business API endpoints
with paginated extraction and raw event storage. Two more steps write straight to app tables:
receipts (``revolut_sync_receipts``) and the invoices sent from Revolut, which are Merchant API
payment requests (``revolut_merchant_sync``, the ``payment_requests`` endpoint).
"""

import logging
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

import httpx
import inngest
from inngest.experimental import realtime

from ...core.supabase_client import get_supabase_client
from ...integrations.common import resolve_sync_since
from ...integrations.revolut import ENDPOINTS, RevolutAdapter
from ...integrations.revolut.merchant import ENDPOINT as MERCHANT_ENDPOINT
from ...integrations.revolut.merchant import MerchantAdapter, is_invoice
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
    """Orchestrate a full Revolut sync: the endpoints, then receipts, then invoices.

    The overall status counts every step (receipts, and invoices when there is a Merchant
    key, as well as the endpoints), and ends with "completed": the progress toast waits for
    that, since the endpoints finish minutes before the steps after them.
    """
    # Imported here: the service imports integrations.revolut.merchant, and importing any
    # integrations module loads this one through the package's __init__.
    from ...services.revolut_invoice_sync import merchant_source_for

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

        async def _has_merchant_key() -> bool:
            return bool(await merchant_source_for(source_id))

        has_merchant_key = await ctx.step.run("has-merchant-key", _has_merchant_key)
        # Endpoints, receipts, and invoices when there is a key to read them with.
        steps_total = len(ENDPOINTS) + 1 + int(has_merchant_key)

        async def _status(status: str, done: int, items: int) -> None:
            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="status",
                data=SyncStatusData(
                    status=status,
                    endpoints_completed=done,
                    endpoints_total=steps_total,
                    total_items=items,
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

        async def _receipts_progress(
            status: str, items: int = 0, error: Optional[str] = None
        ) -> None:
            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="progress",
                data=SyncProgressData(
                    endpoint=RECEIPTS_SYNC_KEY,
                    status=status,
                    items_stored=items,
                    pages_processed=0,
                    total_items=items if status == "completed" else None,
                    error=error,
                    timestamp=datetime.now().isoformat(),
                ),
            )

        await _status("syncing", 0, 0)

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

            await _status(
                "syncing",
                completed_count,
                sum(r.get("items_stored", 0) for r in results.values()),
            )

            await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=2))

        # Attachments are extra: a business without the Expenses API, or a failed download,
        # must not fail the sync of its transactions. The step publishes nothing itself, so
        # its progress is reported from here.
        await _receipts_progress("starting")
        try:
            receipts = await ctx.step.invoke(
                "sync-receipts",
                function=revolut_sync_receipts,
                data={"source_id": source_id, "force_full": force_full},
            )
            results["receipts"] = receipts
            await _receipts_progress(
                "completed", int(receipts.get("receipts_stored", 0))
            )
        except inngest.StepError as e:
            ctx.logger.warning(f"Revolut receipts not synced for {source_id}: {e}")
            await _receipts_progress("error", error=str(e))
        completed_count += 1
        await _status(
            "syncing",
            completed_count,
            sum(r.get("items_stored", 0) for r in results.values()),
        )

        # Invoices sent from Revolut, after transactions so their payments can be linked in
        # this run. Only with a Merchant key; a failure does not fail the sync. The step
        # reports its own progress (as payment_requests) on this channel.
        if has_merchant_key:
            try:
                results[MERCHANT_ENDPOINT] = await ctx.step.invoke(
                    "sync-payment-requests",
                    function=revolut_merchant_sync,
                    data={"source_id": source_id},
                )
            except inngest.StepError as e:
                ctx.logger.warning(f"Revolut invoices not synced for {source_id}: {e}")
            completed_count += 1

        await ctx.step.run(
            "update-sync-status",
            lambda: sync_service.update_sync_status(source_id, "completed"),
        )

        total_items = sum(r.get("items_stored", 0) for r in results.values())
        await _status("completed", steps_total, total_items)

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

        if endpoint == MERCHANT_ENDPOINT:
            invoices: Dict[str, Any] = await ctx.step.invoke(
                "sync-payment-requests",
                function=revolut_merchant_sync,
                data={"source_id": source_id},
            )
            return invoices

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


INVOICES_PER_STEP = 20
LINKS_PER_STEP = 10


@inngest_client.create_function(
    fn_id="revolut_merchant_sync",
    trigger=inngest.TriggerEvent(event="revolut/sync.payment_requests"),
    retries=3,
)
async def revolut_merchant_sync(ctx: inngest.Context) -> Dict[str, Any]:
    """The Revolut integration's ``payment_requests`` endpoint: invoices sent from Revolut.

    Invoked by ``revolut_sync_all`` after receipts (so the Business transactions the payments
    are matched to are in first) and by ``revolut_sync_endpoint`` for "Sync one thing". It
    runs under the Revolut integration's id, reads the Merchant key from that integration's
    ``revolut_merchant`` row, and is skipped when no key was added.

    Revolut has few of these and their state changes after they are created (a request is
    paid days later), so every run reads the whole list rather than what is new since a
    watermark; storing is an upsert. Paid invoices with no payment linked yet are then read
    in full (the list has no payments) and linked to their "Merchant payment" transaction; a
    missing one is tried again next run. Nothing is posted: the transaction is journaled on
    its own.
    """
    # Imported here: the service imports integrations.revolut.merchant, and importing any
    # integrations module loads this one through the package's __init__.
    from ...services.revolut_invoice_sync import (
        link_order_payments,
        merchant_source_for,
        store_payment_request,
    )

    event_data: Dict[str, Any] = dict(ctx.event.data)
    source_id: str = event_data.get("source_id") or ""
    if not source_id:
        raise ValueError("source_id is required")
    channel = get_sync_channel(source_id)

    async def _progress(status: str, items: int, error: Optional[str] = None):
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="progress",
            data=SyncProgressData(
                endpoint=MERCHANT_ENDPOINT,
                status=status,
                items_stored=items,
                pages_processed=0,
                total_items=items if status == "completed" else None,
                error=error,
                timestamp=datetime.now().isoformat(),
            ),
        )

    merchant = await ctx.step.run(
        "get-merchant-source", lambda: merchant_source_for(source_id)
    )
    if not merchant:
        ctx.logger.info(f"No Revolut Merchant key for {source_id}: invoices skipped")
        return {"status": "skipped", "reason": "no merchant key", "items_stored": 0}

    try:
        await _progress("starting", 0)
        run_started_at = datetime.fromisoformat(
            await ctx.step.run("get-run-start-time", utc_now_iso)
        )
        if not merchant.get("entity_id"):
            raise inngest.NonRetriableError(f"Source has no business: {source_id}")
        entity_id = UUID(str(merchant["entity_id"]))

        api_key = await sync_service.get_api_key(merchant["id"])
        if not api_key:
            raise inngest.NonRetriableError(
                "Merchant key not found - add it on the Revolut integration"
            )
        adapter = MerchantAdapter(api_key)

        async def _list() -> List[Dict[str, Any]]:
            return [o async for o in adapter.list_orders() if is_invoice(o)]

        orders = await ctx.step.run("list-payment-requests", _list)

        created = 0
        to_link: List[Dict[str, str]] = []
        for start in range(0, len(orders), INVOICES_PER_STEP):
            chunk = orders[start : start + INVOICES_PER_STEP]

            async def _store(chunk: List[Dict[str, Any]] = chunk) -> Dict[str, Any]:
                made = 0
                pending: List[Dict[str, str]] = []
                for order in chunk:
                    result = await store_payment_request(entity_id, order)
                    made += int(result["created"])
                    if result["needs_link"]:
                        pending.append(
                            {
                                "order_id": order["id"],
                                "invoice_id": result["invoice"]["id"],
                            }
                        )
                return {"created": made, "to_link": pending}

            stored = await ctx.step.run(
                f"store-invoices-{start // INVOICES_PER_STEP}", _store
            )
            created += stored["created"]
            to_link.extend(stored["to_link"])

        linked = 0
        for start in range(0, len(to_link), LINKS_PER_STEP):
            chunk_ids = to_link[start : start + LINKS_PER_STEP]

            async def _link(chunk: List[Dict[str, str]] = chunk_ids) -> int:
                done = 0
                for item in chunk:
                    order = await adapter.get_order(item["order_id"])
                    done += await link_order_payments(
                        entity_id, UUID(item["invoice_id"]), order
                    )
                return done

            linked += await ctx.step.run(
                f"link-payments-{start // LINKS_PER_STEP}", _link
            )

        await ctx.step.run(
            "set-sync-watermark",
            lambda: sync_service.set_sync_watermark(
                source_id,
                MERCHANT_ENDPOINT,
                status="completed",
                synced_at=run_started_at,
            ),
        )
        await _progress("completed", len(orders))
        ctx.logger.info(
            f"Revolut payment requests for {source_id}: {len(orders)} synced "
            f"({created} new), {linked} payments linked, "
            f"{len(to_link) - linked} waiting for their bank transaction"
        )
        return {
            "status": "completed",
            "items_stored": len(orders),
            "created": created,
            "payments_linked": linked,
            "payments_waiting": len(to_link) - linked,
        }

    except Exception as e:
        error_text = str(e)
        ctx.logger.error(f"Error syncing Revolut payment requests: {error_text}")
        await ctx.step.run(
            "set-sync-watermark-error",
            lambda: sync_service.set_sync_watermark(
                source_id, MERCHANT_ENDPOINT, status="error", error=error_text
            ),
        )
        try:
            await _progress("error", 0, error_text)
        except Exception as pub_err:
            ctx.logger.error(f"Failed to publish error status: {pub_err}")
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code in (
            401,
            403,
        ):
            raise inngest.NonRetriableError(
                f"Revolut Merchant API authentication failed: {e}"
            ) from e
        raise


REVOLUT_SYNC_FUNCTIONS = [
    revolut_sync_all,
    revolut_sync_endpoint,
    revolut_sync_receipts,
    revolut_merchant_sync,
]
