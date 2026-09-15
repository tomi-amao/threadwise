"""Inngest functions for Shopify data synchronization.

Orchestrates bulk loading from Shopify Admin REST API
with paginated extraction and raw event storage.
"""

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import inngest
from inngest.experimental import realtime

from .config import get_client
from .channels import get_sync_channel, SyncProgressData, SyncStatusData
from ...services.external_sync_service import sync_service
from ...integrations.shopify import ShopifyAdapter, ENDPOINTS

logger = logging.getLogger(__name__)

inngest_client = get_client()

BATCH_SIZE = 50
PAGE_DELAY_SECONDS = 0.5  # Shopify REST: ~2 req/s leaky-bucket default


@inngest_client.create_function(
    fn_id="shopify_sync_all",
    trigger=inngest.TriggerEvent(event="shopify/sync.requested"),
    retries=3,
)
async def shopify_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full Shopify sync for all endpoints."""
    source_id: Optional[str] = None

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(f"Starting full Shopify sync for source {source_id}")

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
                function=shopify_sync_endpoint,
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
                    total_items=sum(r.get("items_stored", 0) for r in results.values()),
                    error=None,
                    timestamp=datetime.now().isoformat(),
                ),
            )

            await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=2))

        # order transactions are triggered automatically by shopify_sync_endpoint
        # when the orders endpoint completes — no separate invocation needed here.

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
                    name="shopify/sync.completed",
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
        ctx.logger.error(f"Error in Shopify sync: {str(e)}")

        if source_id:
            await ctx.step.run(
                "update-sync-status",
                lambda: sync_service.update_sync_status(source_id, "error", error=str(e)),
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
    fn_id="shopify_sync_endpoint",
    trigger=inngest.TriggerEvent(event="shopify/sync.endpoint"),
    retries=3,
)
async def shopify_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single Shopify endpoint with pagination.

    Paginates using Shopify's Link-header cursor and stores raw events
    without transformation.
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
            raise ValueError(f"Unknown Shopify endpoint: {endpoint}")

        ctx.logger.info(
            f"Syncing Shopify {endpoint} for source {source_id} "
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

        credentials_json = await sync_service.get_api_key(source_id)
        if not credentials_json:
            raise ValueError(
                "Credentials not found - please configure Shopify client_id and client_secret"
            )

        shop_domain = source.get("external_account_id", "")
        if not shop_domain:
            raise ValueError("Shop domain (external_account_id) is not configured")

        adapter = ShopifyAdapter(
            credentials_json=credentials_json,
            shop_domain=shop_domain,
            page_size=50,
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
                        source_id, "shopify", batch
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
                    source_id, "shopify", batch
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
            f"Completed Shopify {endpoint} sync: "
            f"{items_stored} items, {pages_processed} pages"
        )

        # When orders are synced directly, also fetch order transactions
        # so non-Shopify-Payments payments are always captured.
        if endpoint == "orders":
            ctx.logger.info("Orders endpoint synced — triggering order transactions sync")
            await ctx.step.invoke(
                "sync-order-transactions",
                function=shopify_sync_order_transactions,
                data={"source_id": source_id},
            )

        return {
            "status": "completed",
            "endpoint": endpoint,
            "items_stored": items_stored,
            "pages_processed": pages_processed,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error syncing Shopify {endpoint}: {str(e)}")

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
    fn_id="shopify_sync_order_transactions",
    trigger=inngest.TriggerEvent(event="shopify/sync.order_transactions.requested"),
    retries=3,
)
async def shopify_sync_order_transactions(ctx: inngest.Context) -> Dict[str, Any]:
    """Fetch and store order transactions for non-Shopify-Payments orders.

    Queries external_raw_events for Shopify order payloads whose
    payment_gateway_names doesn't solely contain shopify_payments, then
    calls GET /orders/{id}/transactions.json for each qualifying order.
    """
    source_id: Optional[str] = None

    try:
        event_data = ctx.event.data
        source_id = event_data.get("source_id")

        if not source_id:
            raise ValueError("source_id is required")

        ctx.logger.info(
            f"Fetching order transactions for non-Shopify-Payments orders "
            f"(source {source_id})"
        )

        # Fetch qualifying orders from the DB.
        # Returns list of dicts: {external_id, total_price_set} so the
        # normalizer can compute the GBP base_amount via the FX rate.
        async def _get_qualifying_orders():
            import asyncio as _asyncio
            from ...services.external_sync_service import sync_service as svc

            def _query():
                return svc.client.table("external_raw_events") \
                    .select("external_id, payload") \
                    .eq("source_id", source_id) \
                    .eq("entity_type", "order") \
                    .execute()

            result = await _asyncio.to_thread(_query)
            rows = result.data or []
            ctx.logger.info(f"Found {len(rows)} total Shopify order raw events for source {source_id}")
            qualifying = []
            for row in rows:
                payload = row.get("payload", {})
                gateways = payload.get("payment_gateway_names", [])
                ctx.logger.debug(f"Order {row['external_id']} gateways: {gateways}")
                if gateways != ["shopify_payments"]:
                    qualifying.append({
                        "external_id": row["external_id"],
                        "total_price_set": payload.get("total_price_set"),
                    })
            ctx.logger.info(
                f"Qualifying (non-Shopify-Payments) order count: {len(qualifying)}"
            )
            return qualifying

        qualifying_orders = await ctx.step.run("get-qualifying-orders", _get_qualifying_orders)
        # Build a lookup: order external_id → total_price_set
        order_price_set: Dict[str, Any] = {
            o["external_id"]: o["total_price_set"]
            for o in qualifying_orders
        }
        order_ids = list(order_price_set.keys())

        ctx.logger.info(
            f"Found {len(order_ids)} non-Shopify-Payments orders to fetch transactions for"
        )

        if not order_ids:
            return {
                "status": "completed",
                "source_id": source_id,
                "orders_processed": 0,
                "items_stored": 0,
            }

        source = await ctx.step.run(
            "get-source",
            lambda: sync_service.get_external_source(source_id),
        )

        if not source:
            raise ValueError(f"Source not found: {source_id}")

        credentials_json = await sync_service.get_api_key(source_id)
        if not credentials_json:
            raise ValueError("Credentials not found")

        shop_domain = source.get("external_account_id", "")
        adapter = ShopifyAdapter(
            credentials_json=credentials_json,
            shop_domain=shop_domain,
        )

        items_stored = 0
        orders_processed = 0

        # Process in batches of 10 to keep steps manageable
        for i in range(0, len(order_ids), 10):
            batch_order_ids = order_ids[i : i + 10]

            async def _fetch_and_store(oids=batch_order_ids):
                all_records = []
                for oid in oids:
                    try:
                        records = await adapter.fetch_order_transactions(oid)
                        ctx.logger.info(
                            f"Order {oid}: fetched {len(records)} transaction(s) "
                            f"({[r.external_id for r in records]})"
                        )
                        price_set = order_price_set.get(oid)
                        all_records.extend(
                            {
                                "entity_type": r.entity_type,
                                "external_id": r.external_id,
                                # Inject _total_price_set so the normalizer can
                                # derive the GBP base_amount via the FX rate.
                                "payload": {**r.payload, "_total_price_set": price_set},
                                "occurred_at": r.occurred_at,
                            }
                            for r in records
                        )
                    except Exception as err:
                        ctx.logger.warning(
                            f"Failed to fetch transactions for order {oid}: {err}"
                        )

                ctx.logger.info(
                    f"Batch {i}–{i + len(oids)}: {len(all_records)} total transaction records to store"
                )

                if not all_records:
                    return 0

                stored = await sync_service.store_raw_events_batch(
                    source_id, "shopify", all_records
                )
                ctx.logger.info(
                    f"Batch {i}–{i + len(oids)}: stored {stored} records into external_raw_events"
                )
                return stored

            batch_stored = await ctx.step.run(f"fetch-transactions-batch-{i}", _fetch_and_store)
            items_stored += batch_stored or 0

            orders_processed += len(batch_order_ids)
            ctx.logger.info(
                f"Progress: {orders_processed}/{len(order_ids)} orders processed, "
                f"{items_stored} transactions stored so far"
            )
            await ctx.step.sleep(
                f"rate-limit-order-txns-{i}", timedelta(seconds=1)
            )

        ctx.logger.info(
            f"Order transactions sync complete: {items_stored} transactions "
            f"from {orders_processed} orders"
        )

        return {
            "status": "completed",
            "source_id": source_id,
            "orders_processed": orders_processed,
            "items_stored": items_stored,
            "completed_at": datetime.now().isoformat(),
        }

    except Exception as e:
        ctx.logger.error(f"Error syncing order transactions: {str(e)}")
        raise


SHOPIFY_SYNC_FUNCTIONS = [
    shopify_sync_all,
    shopify_sync_endpoint,
    shopify_sync_order_transactions,
]
