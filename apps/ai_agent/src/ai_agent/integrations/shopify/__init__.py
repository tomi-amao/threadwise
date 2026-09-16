"""Shopify Admin API adapter for ThreadWise.

Handles paginated data extraction from Shopify Admin REST API endpoints.
Uses OAuth 2.0 client credentials grant to obtain a short-lived access token
before making API calls. Never transforms data - stores exact API payloads.
"""

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, AsyncIterator, Dict, Iterable, Optional

import httpx

from ..common import PaginatedResult, RawEventRecord

__all__ = ["PaginatedResult", "RawEventRecord", "ShopifyAdapter"]

logger = logging.getLogger(__name__)

SHOPIFY_API_VERSION = "2024-01"

ENDPOINTS = {
    "products": "/admin/api/{version}/products.json",
    "orders": "/admin/api/{version}/orders.json",
    "customers": "/admin/api/{version}/customers.json",
    "inventory": "/admin/api/{version}/inventory_levels.json",
    "balance_transactions": "/admin/api/{version}/shopify_payments/balance/transactions.json",
}

INVENTORY_ITEMS_ENDPOINT = "/admin/api/{version}/inventory_items.json"

# Map endpoint name to the JSON key that wraps the items
RESPONSE_KEYS = {
    "products": "products",
    "orders": "orders",
    "customers": "customers",
    "inventory": "inventory_levels",
    "balance_transactions": "transactions",
}

# Map endpoint name to canonical entity type
ENTITY_TYPE_MAP = {
    "products": "product",
    "orders": "order",
    "customers": "customer",
    "inventory": "inventory_item",
    "balance_transactions": "payment_transaction",
}

# Endpoints that are only available for Shopify Payments stores.
# If these return 402/404/422 we skip gracefully instead of failing the sync.
PAYMENTS_ONLY_ENDPOINTS = {"balance_transactions"}

# Buffer before token expiry to trigger a refresh (5 minutes)
TOKEN_EXPIRY_BUFFER_SECONDS = 300


class ShopifyAdapter:
    """Adapter for Shopify Admin REST API.

    Authenticates via OAuth 2.0 client credentials grant:
      POST https://{shop}.myshopify.com/admin/oauth/access_token
      body: grant_type=client_credentials&client_id=...&client_secret=...

    The returned access_token (valid ~24 h) is used as X-Shopify-Access-Token.
    Tokens are refreshed automatically when they expire.
    """

    def __init__(
        self,
        credentials_json: str,
        shop_domain: str,
        page_size: int = 50,
        timeout: float = 30.0,
    ):
        """Initialize the Shopify adapter.

        Args:
            credentials_json: JSON string with "client_id" and "client_secret"
            shop_domain: Shop domain (e.g. mystore.myshopify.com)
            page_size: Number of items per page (default: 50, max: 250)
            timeout: Request timeout in seconds
        """
        creds = json.loads(credentials_json)
        self.client_id: str = creds["client_id"]
        self.client_secret: str = creds["client_secret"]
        self.shop_domain = shop_domain.rstrip("/")
        self.page_size = min(page_size, 250)
        self.timeout = timeout
        self._base_url = f"https://{self.shop_domain}"

        # Token cache — populated lazily on first request
        self._access_token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None

    # -------------------------------------------------------------------------
    # Token management
    # -------------------------------------------------------------------------

    async def _fetch_access_token(self) -> dict:
        """Exchange client credentials for an access token."""
        url = f"{self._base_url}/admin/oauth/access_token"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                url,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
            )
            response.raise_for_status()
            return response.json()

    async def _ensure_token(self) -> None:
        """Refresh the access token if missing or about to expire."""
        now = datetime.now(timezone.utc)
        if (
            self._access_token
            and self._token_expires_at
            and now < self._token_expires_at
        ):
            return

        token_data = await self._fetch_access_token()
        self._access_token = token_data["access_token"]
        expires_in = token_data.get("expires_in", 86399)
        self._token_expires_at = now + timedelta(
            seconds=expires_in - TOKEN_EXPIRY_BUFFER_SECONDS
        )
        logger.debug(
            f"Shopify access token refreshed, expires at {self._token_expires_at}"
        )

    def _auth_headers(self) -> Dict[str, str]:
        return {
            "X-Shopify-Access-Token": self._access_token or "",
            "Content-Type": "application/json",
            "User-Agent": "ThreadWise/1.0",
        }

    # -------------------------------------------------------------------------
    # HTTP helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _chunked(items: Iterable[str], chunk_size: int) -> list[list[str]]:
        chunk: list[str] = []
        chunks: list[list[str]] = []
        for item in items:
            chunk.append(item)
            if len(chunk) >= chunk_size:
                chunks.append(chunk)
                chunk = []
        if chunk:
            chunks.append(chunk)
        return chunks

    def _build_url(self, endpoint: str) -> str:
        path = ENDPOINTS[endpoint].format(version=SHOPIFY_API_VERSION)
        return f"{self._base_url}{path}"

    async def _make_request(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> tuple[Dict[str, Any], Optional[str]]:
        """Make an authenticated GET request.

        Returns:
            Tuple of (response_json, next_page_info_cursor)
        """
        await self._ensure_token()

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                url,
                headers=self._auth_headers(),
                params=params or {},
            )
            response.raise_for_status()
            data = response.json()
            next_cursor = self._extract_next_cursor(
                response.headers.get("link", "")
            )
            return data, next_cursor

    async def _fetch_inventory_item_costs(
        self,
        inventory_item_ids: list[str],
    ) -> Dict[str, Decimal]:
        """Fetch Shopify inventory item costs keyed by inventory_item_id.

        This uses the REST inventory_items endpoint so product and inventory payloads
        can carry cost metadata into normalization.
        """
        if not inventory_item_ids:
            return {}

        url = f"{self._base_url}{INVENTORY_ITEMS_ENDPOINT.format(version=SHOPIFY_API_VERSION)}"
        costs: Dict[str, Decimal] = {}

        for id_chunk in self._chunked(inventory_item_ids, 100):
            ids_csv = ",".join(id_chunk)
            data, _ = await self._make_request(url, {"ids": ids_csv, "limit": len(id_chunk)})
            for item in data.get("inventory_items", []) or []:
                item_id = str(item.get("id", "")).strip()
                if not item_id:
                    continue
                raw_cost = item.get("cost")
                if raw_cost in (None, ""):
                    continue
                try:
                    costs[item_id] = Decimal(str(raw_cost))
                except Exception:
                    logger.debug("Skipping unparsable Shopify inventory cost", exc_info=True)

        return costs

    async def _enrich_products_with_inventory_costs(self, products: list[Dict[str, Any]]) -> None:
        """Attach inventory item cost metadata to each product variant payload."""
        inventory_item_ids = {
            str(variant.get("inventory_item_id"))
            for product in products
            for variant in (product.get("variants") or [])
            if variant.get("inventory_item_id")
        }
        if not inventory_item_ids:
            return

        cost_map = await self._fetch_inventory_item_costs(sorted(inventory_item_ids))
        if not cost_map:
            return

        for product in products:
            for variant in product.get("variants") or []:
                inventory_item_id = variant.get("inventory_item_id")
                if not inventory_item_id:
                    continue
                cost = cost_map.get(str(inventory_item_id))
                if cost is None:
                    continue
                # Keep as string so payload remains JSON-serializable and lossless.
                variant["inventory_item_cost"] = str(cost)

    async def _enrich_inventory_with_costs(self, inventory_levels: list[Dict[str, Any]]) -> None:
        """Attach inventory item cost metadata to inventory level payloads."""
        inventory_item_ids = {
            str(level.get("inventory_item_id"))
            for level in inventory_levels
            if level.get("inventory_item_id")
        }
        if not inventory_item_ids:
            return

        cost_map = await self._fetch_inventory_item_costs(sorted(inventory_item_ids))
        if not cost_map:
            return

        for level in inventory_levels:
            inventory_item_id = level.get("inventory_item_id")
            if not inventory_item_id:
                continue
            cost = cost_map.get(str(inventory_item_id))
            if cost is None:
                continue
            level["inventory_item_cost"] = str(cost)

    @staticmethod
    def _extract_next_cursor(link_header: str) -> Optional[str]:
        """Extract the page_info cursor from a Shopify Link header.

        Format: <https://store.myshopify.com/...?page_info=xxx>; rel="next"
        """
        if not link_header:
            return None
        match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
        if not match:
            return None
        pi_match = re.search(r'[?&]page_info=([^&]+)', match.group(1))
        return pi_match.group(1) if pi_match else None

    # -------------------------------------------------------------------------
    # Entity helpers
    # -------------------------------------------------------------------------

    def _get_entity_type(self, endpoint: str) -> str:
        return ENTITY_TYPE_MAP.get(endpoint, endpoint)

    def _extract_external_id(self, item: Dict[str, Any], entity_type: str) -> str:
        """Inventory levels are keyed by (inventory_item_id, location_id)."""
        if entity_type == "inventory_item":
            return f"{item.get('inventory_item_id', '')}_{item.get('location_id', '')}"
        return str(item.get("id", ""))

    def _extract_occurred_at(
        self, item: Dict[str, Any], entity_type: str
    ) -> Optional[datetime]:
        for field in ("created_at", "updated_at", "processed_at"):
            value = item.get(field)
            if value:
                try:
                    return datetime.fromisoformat(value.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue
        return None

    # -------------------------------------------------------------------------
    # Pagination
    # -------------------------------------------------------------------------

    async def _fetch_location_ids(self) -> list[str]:
        """Fetch all location IDs for this store.

        Required before querying inventory_levels, which mandates at least one
        of location_ids or inventory_item_ids as a filter parameter.
        """
        url = f"{self._base_url}/admin/api/{SHOPIFY_API_VERSION}/locations.json"
        data, _ = await self._make_request(url)
        locations = data.get("locations", [])
        ids = [str(loc["id"]) for loc in locations if loc.get("id")]
        logger.info(f"Fetched {len(ids)} Shopify locations: {ids}")
        return ids

    async def fetch_page(
        self,
        endpoint: str,
        cursor: Optional[str] = None,
        extra_params: Optional[Dict[str, Any]] = None,
    ) -> PaginatedResult:
        """Fetch a single page from a Shopify endpoint."""
        if endpoint not in ENDPOINTS:
            raise ValueError(f"Unknown endpoint: {endpoint}")

        url = self._build_url(endpoint)

        if cursor:
            params: Dict[str, Any] = {"limit": self.page_size, "page_info": cursor}
        else:
            params = {"limit": self.page_size}
            if endpoint == "orders":
                params["status"] = "any"
            elif endpoint == "products":
                params["status"] = "active"
            if extra_params:
                params.update(extra_params)

        logger.info(f"Fetching Shopify {endpoint} page (cursor: {cursor or 'start'})")

        data, next_cursor = await self._make_request(url, params)
        fetched_at = datetime.now(timezone.utc)

        items_key = RESPONSE_KEYS.get(endpoint, endpoint)
        items = data.get(items_key, [])

        # Enrich payloads with variant/inventory item cost metadata where available.
        if isinstance(items, list) and items:
            try:
                if endpoint == "products":
                    await self._enrich_products_with_inventory_costs(items)
                elif endpoint == "inventory":
                    await self._enrich_inventory_with_costs(items)
            except Exception:
                logger.warning(
                    "Failed to enrich Shopify %s payloads with inventory costs",
                    endpoint,
                    exc_info=True,
                )

        return PaginatedResult(
            items=items if isinstance(items, list) else [],
            cursor=next_cursor,
            has_more=bool(next_cursor),
            endpoint=endpoint,
            fetched_at=fetched_at,
        )

    async def stream_endpoint(
        self,
        endpoint: str,
        start_cursor: Optional[str] = None,
    ) -> AsyncIterator[RawEventRecord]:
        """Stream all items from an endpoint as raw event records."""
        entity_type = self._get_entity_type(endpoint)
        cursor = start_cursor
        page_count = 0
        total_items = 0

        # inventory_levels requires location_ids — fetch them once up front.
        extra_params: Optional[Dict[str, Any]] = None
        if endpoint == "inventory":
            location_ids = await self._fetch_location_ids()
            if not location_ids:
                logger.warning("No Shopify locations found; skipping inventory sync")
                return
            extra_params = {"location_ids": ",".join(location_ids)}

        while True:
            page_count += 1

            try:
                result = await self.fetch_page(
                    endpoint,
                    cursor,
                    extra_params=extra_params if not cursor else None,
                )
            except httpx.HTTPStatusError as e:
                status_code = e.response.status_code
                if endpoint in PAYMENTS_ONLY_ENDPOINTS and status_code in (402, 404, 422):
                    logger.warning(
                        f"Shopify {endpoint} returned {status_code} — "
                        "store may not use Shopify Payments; skipping endpoint"
                    )
                    return
                logger.error(
                    f"HTTP error fetching Shopify {endpoint}: {status_code}"
                )
                raise
            except Exception as e:
                logger.error(f"Error fetching Shopify {endpoint}: {e}")
                raise

            for item in result.items:
                total_items += 1
                yield RawEventRecord(
                    provider="shopify",
                    entity_type=entity_type,
                    external_id=self._extract_external_id(item, entity_type),
                    payload=item,
                    occurred_at=self._extract_occurred_at(item, entity_type),
                    fetched_at=result.fetched_at,
                )

            logger.info(
                f"Processed page {page_count} of Shopify {endpoint} "
                f"({len(result.items)} items, {total_items} total)"
            )

            if not result.has_more or not result.cursor:
                break

            cursor = result.cursor

        logger.info(
            f"Completed streaming Shopify {endpoint}: "
            f"{total_items} items across {page_count} pages"
        )

    async def stream_all_endpoints(
        self,
        cursors: Optional[Dict[str, str]] = None,
    ) -> AsyncIterator[tuple[str, RawEventRecord]]:
        """Stream all endpoints sequentially."""
        cursors = cursors or {}
        for endpoint in ENDPOINTS:
            cursor = cursors.get(endpoint)
            try:
                async for record in self.stream_endpoint(endpoint, cursor):
                    yield (endpoint, record)
            except Exception as e:
                logger.error(f"Error streaming Shopify {endpoint}: {e}")
                continue

    async def fetch_order_transactions(
        self,
        order_id: str,
    ) -> list[RawEventRecord]:
        """Fetch all transactions for a single order.

        Uses GET /admin/api/{version}/orders/{order_id}/transactions.json
        Works for all payment gateways (PayPal, manual, Shopify Payments, etc.).
        Returns only transactions with status='success' and kind in
        (sale, capture, refund) — skips authorizations and voids.
        """
        url = (
            f"{self._base_url}/admin/api/{SHOPIFY_API_VERSION}"
            f"/orders/{order_id}/transactions.json"
        )
        data, _ = await self._make_request(url)
        transactions = data.get("transactions", [])
        fetched_at = datetime.now(timezone.utc)

        KEPT_KINDS = {"sale", "capture", "refund"}

        records = []
        for txn in transactions:
            if txn.get("status") != "success":
                continue
            if txn.get("kind") not in KEPT_KINDS:
                continue

            external_id = str(txn.get("id", ""))
            occurred_at = self._extract_occurred_at(txn, "order_transaction")
            records.append(
                RawEventRecord(
                    provider="shopify",
                    entity_type="order_transaction",
                    external_id=external_id,
                    payload={**txn, "_order_id": order_id},
                    occurred_at=occurred_at,
                    fetched_at=fetched_at,
                )
            )

        logger.info(
            f"Fetched {len(records)} transactions for Shopify order {order_id}"
        )
        return records

    async def test_connection(self) -> bool:
        """Test credentials by obtaining an access token and calling shop.json."""
        try:
            await self._ensure_token()
            url = f"{self._base_url}/admin/api/{SHOPIFY_API_VERSION}/shop.json"
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(url, headers=self._auth_headers())
                return response.status_code == 200
        except Exception as e:
            logger.error(f"Shopify connection test failed: {e}")
            return False
