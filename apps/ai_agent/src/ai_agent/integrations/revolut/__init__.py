"""Revolut Business API adapter for ThreadWise.

Handles paginated data extraction from Revolut Business API endpoints.
Never transforms data - stores exact API payloads.
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..common import PaginatedResult, RawEventRecord

logger = logging.getLogger(__name__)

# Revolut Business API endpoints (built dynamically from base URL)
REVOLUT_BASE_URL = os.environ.get("REVOLUT_API_URL", "https://b2b.revolut.com")

ENDPOINTS = {
    "transactions": f"{REVOLUT_BASE_URL}/api/1.0/transactions",
    "accounts": f"{REVOLUT_BASE_URL}/api/1.0/accounts",
}

# Not a synced endpoint: expenses are read only to find the receipts attached to transactions
# (see integrations/inngest/revolut_sync_functions.py, revolut_sync_receipts).
EXPENSES_URL = f"{REVOLUT_BASE_URL}/api/1.0/expenses"


class RevolutAdapter:
    """Adapter for Revolut Business API.

    Features:
    - Paginated extraction from transaction and account endpoints
    - Date-based pagination for transactions (uses `from`/`to` params)
    - Never transforms data - stores exact API payloads
    - Yields raw events for streaming storage
    """

    def __init__(
        self,
        api_key: str,
        page_size: int = 100,
        timeout: float = 30.0,
    ):
        """Initialize the Revolut adapter.

        Args:
            api_key: Revolut Business API access token
            page_size: Number of items per page for transactions (default: 100)
            timeout: Request timeout in seconds
        """
        self.api_key = api_key
        self.page_size = page_size
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "ThreadWise/1.0",
        }

    async def _make_request(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an authenticated request to Revolut API.

        Args:
            url: API endpoint URL
            params: Query parameters

        Returns:
            API response (list or dict depending on endpoint)

        Raises:
            httpx.HTTPStatusError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                url,
                headers=self._headers,
                params=params or {},
            )
            response.raise_for_status()
            return response.json()

    def _get_entity_type(self, endpoint: str) -> str:
        """Map endpoint to entity type.

        Args:
            endpoint: API endpoint name

        Returns:
            Entity type string for storage
        """
        mapping = {
            "transactions": "financial_transaction",
            "accounts": "bank_account",
        }
        return mapping.get(endpoint, endpoint)

    def _extract_external_id(
        self,
        item: Dict[str, Any],
        entity_type: str,
    ) -> str:
        """Extract the external ID from an item.

        Args:
            item: Raw API item
            entity_type: Type of entity

        Returns:
            External ID string
        """
        if "id" in item:
            return str(item["id"])

        # Last resort: use hash of payload
        import hashlib
        import json

        return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[
            :32
        ]

    def _extract_occurred_at(
        self,
        item: Dict[str, Any],
        entity_type: str,
    ) -> Optional[datetime]:
        """Extract the occurred_at timestamp from an item.

        For transactions, prefers completed_at then falls back to created_at.
        For accounts, tries created_at and updated_at.

        Args:
            item: Raw API item
            entity_type: Type of entity

        Returns:
            datetime or None
        """
        if entity_type == "financial_transaction":
            timestamp_fields = ["completed_at", "created_at"]
        else:
            timestamp_fields = ["created_at", "updated_at"]

        for field in timestamp_fields:
            if field in item and item[field]:
                try:
                    return datetime.fromisoformat(item[field].replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue

        return None

    async def fetch_page(
        self,
        endpoint: str,
        cursor: Optional[str] = None,
        since: Optional[datetime] = None,
    ) -> PaginatedResult:
        """Fetch a single page of data from an endpoint.

        For transactions, Revolut uses date-based pagination:
        the cursor is an ISO-8601 timestamp used as the ``to`` parameter on
        the next request. Results are ordered by ``created_at`` descending so
        the last item's ``created_at`` becomes the cursor for the following page.

        For accounts, all records are returned in a single call (no pagination).

        Args:
            endpoint: Endpoint name (``transactions`` or ``accounts``)
            cursor: Pagination cursor (ISO-8601 timestamp for transactions)
            since: Only fetch records at-or-after this time (Revolut's
                ``from`` parameter, inclusive). Sent on every page, not just
                the first — unlike Shopify's opaque cursor, Revolut's `to`
                cursor is a plain param that composes with `from` throughout
                pagination, so the lower bound stays enforced page to page.

        Returns:
            PaginatedResult with items and next cursor
        """
        url = ENDPOINTS.get(endpoint)
        if not url:
            raise ValueError(f"Unknown endpoint: {endpoint}")

        params: Dict[str, Any] = {}

        if endpoint == "transactions":
            params["count"] = self.page_size
            if cursor:
                # cursor is an ISO-8601 timestamp used as the upper bound
                params["to"] = cursor
            if since is not None:
                params["from"] = since.isoformat()

        logger.info(
            f"Fetching {endpoint} page (cursor: {cursor or 'start'}, count: {params.get('count', 'N/A')})"
        )

        response = await self._make_request(url, params)
        fetched_at = datetime.now(timezone.utc)

        # Revolut returns a JSON array for both endpoints
        items: List[Dict[str, Any]] = response if isinstance(response, list) else []

        # Determine pagination for transactions
        has_more = False
        next_cursor: Optional[str] = None

        if endpoint == "transactions" and items:
            # Results are ordered by created_at descending. If we received a
            # full page, there are likely more results available.
            if len(items) >= self.page_size:
                next_cursor = items[-1].get("created_at")
                has_more = next_cursor is not None

        # accounts endpoint is never paginated
        return PaginatedResult(
            items=items,
            cursor=next_cursor,
            has_more=has_more,
            endpoint=endpoint,
            fetched_at=fetched_at,
        )

    async def stream_endpoint(
        self,
        endpoint: str,
        start_cursor: Optional[str] = None,
        since: Optional[datetime] = None,
    ) -> AsyncIterator[RawEventRecord]:
        """Stream all items from an endpoint as raw event records.

        Yields items one by one for memory efficiency.
        Never transforms data - exact API payloads are stored.

        Args:
            endpoint: Endpoint name
            start_cursor: Optional cursor to resume from
            since: Only fetch records at-or-after this time. Ignored for
                ``accounts``, which is a point-in-time snapshot with no
                created/updated timestamp to filter on.

        Yields:
            RawEventRecord for each item
        """
        entity_type = self._get_entity_type(endpoint)
        cursor = start_cursor
        page_count = 0
        total_items = 0

        while True:
            page_count += 1

            try:
                result = await self.fetch_page(endpoint, cursor, since=since)
            except httpx.HTTPStatusError as e:
                logger.error(
                    f"HTTP error fetching {endpoint}: {e.response.status_code}"
                )
                raise
            except Exception as e:
                logger.error(f"Error fetching {endpoint}: {e}")
                raise

            for item in result.items:
                total_items += 1

                yield RawEventRecord(
                    provider="revolut",
                    entity_type=entity_type,
                    external_id=self._extract_external_id(item, entity_type),
                    payload=item,  # Never transform - exact API payload
                    occurred_at=self._extract_occurred_at(item, entity_type),
                    fetched_at=result.fetched_at,
                )

            logger.info(
                f"Processed page {page_count} of {endpoint} "
                f"({len(result.items)} items, {total_items} total, "
                f"has_more={result.has_more}, next_cursor={result.cursor[:19] if result.cursor else None})"
            )

            if not result.has_more or not result.cursor:
                logger.info(
                    f"Pagination complete for {endpoint}: "
                    f"has_more={result.has_more}, cursor={result.cursor}"
                )
                break

            cursor = result.cursor

        logger.info(
            f"Completed streaming {endpoint}: "
            f"{total_items} items across {page_count} pages"
        )

    async def stream_all_endpoints(
        self,
        cursors: Optional[Dict[str, str]] = None,
    ) -> AsyncIterator[tuple[str, RawEventRecord]]:
        """Stream all endpoints sequentially.

        Args:
            cursors: Optional dict of endpoint -> cursor for resuming

        Yields:
            Tuple of (endpoint, RawEventRecord) for each item
        """
        cursors = cursors or {}

        for endpoint in ENDPOINTS:
            cursor = cursors.get(endpoint)

            try:
                async for record in self.stream_endpoint(endpoint, cursor):
                    yield (endpoint, record)
            except Exception as e:
                logger.error(f"Error streaming {endpoint}: {e}")
                # Continue with other endpoints
                continue

    async def list_expenses(
        self, since: Optional[datetime] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """Yield every expense at or after ``since`` (all of them if None), newest first.

        Pages backwards like transactions: each page's last ``expense_date`` is the ``to`` of
        the next request. The Expenses API must be enabled for the business by Revolut; when
        it is not, the request fails with 403.
        """
        cursor: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"count": self.page_size}
            if cursor:
                params["to"] = cursor
            if since is not None:
                params["from"] = since.isoformat()
            response = await self._make_request(EXPENSES_URL, params)
            items: List[Dict[str, Any]] = response if isinstance(response, list) else []
            for item in items:
                yield item
            if len(items) < self.page_size:
                break
            next_cursor = items[-1].get("expense_date") or items[-1].get("created_at")
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor

    async def download_receipt(
        self, expense_id: str, receipt_id: str
    ) -> tuple[bytes, str]:
        """One receipt file: its bytes and content type."""
        url = f"{EXPENSES_URL}/{expense_id}/receipts/{receipt_id}/content"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(url, headers=self._headers)
            response.raise_for_status()
            content_type = response.headers.get(
                "content-type", "application/octet-stream"
            )
            return response.content, content_type.split(";")[0].strip()

    async def test_connection(self) -> bool:
        """Test the API connection by fetching accounts.

        Returns:
            True if connection is successful
        """
        try:
            await self.fetch_page("accounts")
            return True
        except Exception as e:
            logger.error(f"Connection test failed: {e}")
            return False
