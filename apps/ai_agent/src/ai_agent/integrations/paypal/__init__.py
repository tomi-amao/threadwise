"""PayPal Transaction Search API adapter for ThreadWise.

Handles paginated data extraction from the PayPal Reporting API.
Uses OAuth2 client-credentials flow for authentication.
Never transforms data - stores exact API payloads.
"""

import base64
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..common import PaginatedResult, RawEventRecord

logger = logging.getLogger(__name__)

PAYPAL_BASE_URL = os.environ.get(
    "PAYPAL_API_URL", "https://api-m.paypal.com"
)

ENDPOINTS = {
    "transactions": f"{PAYPAL_BASE_URL}/v1/reporting/transactions",
}


class PayPalAdapter:
    """Adapter for PayPal Transaction Search API.

    Features:
    - OAuth2 client-credentials authentication with auto-refresh
    - Page-number based pagination for transaction search
    - Default 30-day date window when no cursor is provided
    - Never transforms data - stores exact API payloads
    - Yields raw events for streaming storage
    """

    def __init__(
        self,
        credentials_json: str,
        page_size: int = 500,
        timeout: float = 30.0,
        lookback_days: int = 365,
    ):
        """Initialize the PayPal adapter.

        Args:
            credentials_json: JSON string containing ``client_id`` and ``secret``
            page_size: Number of items per page (max 500, default: 500)
            timeout: Request timeout in seconds
            lookback_days: Number of days to look back for historical data (default: 365)
                          PayPal supports up to 3 years (1095 days) of transaction history.
        """
        creds = json.loads(credentials_json)
        self.client_id: str = creds["client_id"]
        self.client_secret: str = creds["secret"]
        self.page_size = min(page_size, 500)
        self.timeout = timeout
        self.lookback_days = min(lookback_days, 1095)  # PayPal max is 3 years

        # OAuth2 token state
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0

    # =========================================================================
    # AUTHENTICATION
    # =========================================================================

    async def _authenticate(self) -> None:
        """Exchange client credentials for an OAuth2 access token.

        POSTs to ``/v1/oauth2/token`` with HTTP Basic auth (base64-encoded
        ``client_id:secret``) and ``grant_type=client_credentials``.

        Raises:
            httpx.HTTPStatusError: If token request fails
        """
        url = f"{PAYPAL_BASE_URL}/v1/oauth2/token"

        credentials = f"{self.client_id}:{self.client_secret}"
        encoded = base64.b64encode(credentials.encode()).decode()

        headers = {
            "Authorization": f"Basic {encoded}",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "ThreadWise/1.0",
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                url,
                headers=headers,
                data="grant_type=client_credentials",
            )
            response.raise_for_status()
            token_data = response.json()

        self._access_token = token_data["access_token"]
        expires_in = token_data.get("expires_in", 3600)
        # Subtract a safety margin so we refresh before actual expiry
        self._token_expires_at = time.monotonic() + expires_in - 60

        logger.info("PayPal OAuth2 token acquired (expires in %ds)", expires_in)

    async def _ensure_authenticated(self) -> None:
        """Ensure we have a valid access token, refreshing if needed."""
        if (
            self._access_token is None
            or time.monotonic() >= self._token_expires_at
        ):
            await self._authenticate()

    # =========================================================================
    # HTTP REQUESTS
    # =========================================================================

    async def _make_request(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an authenticated GET request to the PayPal API.

        Automatically refreshes the OAuth2 token when expired.

        Args:
            url: API endpoint URL
            params: Query parameters

        Returns:
            API response as parsed JSON

        Raises:
            httpx.HTTPStatusError: If request fails
        """
        await self._ensure_authenticated()

        headers = {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
            "User-Agent": "ThreadWise/1.0",
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                url,
                headers=headers,
                params=params or {},
            )
            response.raise_for_status()
            return response.json()

    # =========================================================================
    # ENTITY / FIELD EXTRACTION
    # =========================================================================

    def _get_entity_type(self, endpoint: str) -> str:
        """Map endpoint to entity type.

        Args:
            endpoint: API endpoint name

        Returns:
            Entity type string for storage
        """
        mapping = {
            "transactions": "financial_transaction",
        }
        return mapping.get(endpoint, endpoint)

    def _extract_external_id(
        self,
        item: Dict[str, Any],
        entity_type: str,
    ) -> str:
        """Extract the external ID from a PayPal transaction detail item.

        Args:
            item: Raw API item (a single ``transaction_details`` entry)
            entity_type: Type of entity

        Returns:
            External ID string
        """
        txn_info = item.get("transaction_info", {})
        txn_id = txn_info.get("transaction_id")
        if txn_id:
            return str(txn_id)

        # Last resort: use hash of payload
        import hashlib

        return hashlib.sha256(
            json.dumps(item, sort_keys=True).encode()
        ).hexdigest()[:32]

    def _extract_occurred_at(
        self,
        item: Dict[str, Any],
        entity_type: str,
    ) -> Optional[datetime]:
        """Extract the occurred_at timestamp from a transaction detail item.

        Uses ``transaction_initiation_date`` from ``transaction_info``.

        Args:
            item: Raw API item (a single ``transaction_details`` entry)
            entity_type: Type of entity

        Returns:
            datetime or None
        """
        txn_info = item.get("transaction_info", {})
        timestamp_fields = [
            "transaction_initiation_date",
            "transaction_updated_date",
        ]

        for field in timestamp_fields:
            value = txn_info.get(field)
            if value:
                try:
                    return datetime.fromisoformat(
                        value.replace("Z", "+00:00")
                    )
                except (ValueError, TypeError):
                    continue

        return None

    # =========================================================================
    # PAGINATION
    # =========================================================================

    async def fetch_page(
        self,
        endpoint: str,
        cursor: Optional[str] = None,
    ) -> PaginatedResult:
        """Fetch a single page of data from an endpoint.

        PayPal Transaction Search uses page-number based pagination.
        The cursor is a string representation of the 1-based page number.

        When no cursor is provided, defaults to page 1 with a 30-day
        lookback window.

        Args:
            endpoint: Endpoint name (``transactions``)
            cursor: Page number as a string (1-based), or None for first page

        Returns:
            PaginatedResult with items and next cursor
        """
        url = ENDPOINTS.get(endpoint)
        if not url:
            raise ValueError(f"Unknown endpoint: {endpoint}")

        page = int(cursor) if cursor else 1

        # Build query parameters
        params: Dict[str, Any] = {
            "page_size": self.page_size,
            "page": page,
        }

        # Date range for transaction search (uses configured lookback_days)
        if endpoint == "transactions":
            now = datetime.now(timezone.utc)
            start = now - timedelta(days=self.lookback_days)
            params["start_date"] = start.strftime("%Y-%m-%dT%H:%M:%S%z")
            params["end_date"] = now.strftime("%Y-%m-%dT%H:%M:%S%z")

        logger.info(
            "Fetching %s page %d (cursor: %s, lookback: %d days)",
            endpoint,
            page,
            cursor or "start",
            self.lookback_days,
        )

        response = await self._make_request(url, params)
        fetched_at = datetime.now(timezone.utc)

        # Extract items from PayPal response structure
        items: List[Dict[str, Any]] = response.get("transaction_details", [])

        total_pages = response.get("total_pages", 1)
        current_page = response.get("page", page)

        has_more = current_page < total_pages
        next_cursor = str(current_page + 1) if has_more else None

        return PaginatedResult(
            items=items,
            cursor=next_cursor,
            has_more=has_more,
            endpoint=endpoint,
            fetched_at=fetched_at,
        )

    # =========================================================================
    # STREAMING
    # =========================================================================

    async def stream_endpoint(
        self,
        endpoint: str,
        start_cursor: Optional[str] = None,
    ) -> AsyncIterator[RawEventRecord]:
        """Stream all items from an endpoint as raw event records.

        Yields items one by one for memory efficiency.
        Never transforms data - exact API payloads are stored.

        Args:
            endpoint: Endpoint name
            start_cursor: Optional page number string to resume from

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
                result = await self.fetch_page(endpoint, cursor)
            except httpx.HTTPStatusError as e:
                logger.error(
                    "HTTP error fetching %s: %s",
                    endpoint,
                    e.response.status_code,
                )
                raise
            except Exception as e:
                logger.error("Error fetching %s: %s", endpoint, e)
                raise

            for item in result.items:
                total_items += 1

                yield RawEventRecord(
                    provider="paypal",
                    entity_type=entity_type,
                    external_id=self._extract_external_id(item, entity_type),
                    payload=item,  # Never transform - exact API payload
                    occurred_at=self._extract_occurred_at(item, entity_type),
                    fetched_at=result.fetched_at,
                )

            logger.info(
                "Processed page %d of %s (%d items, %d total)",
                page_count,
                endpoint,
                len(result.items),
                total_items,
            )

            if not result.has_more or not result.cursor:
                break

            cursor = result.cursor

        logger.info(
            "Completed streaming %s: %d items across %d pages",
            endpoint,
            total_items,
            page_count,
        )

    async def stream_all_endpoints(
        self,
        cursors: Optional[Dict[str, str]] = None,
    ) -> AsyncIterator[tuple[str, RawEventRecord]]:
        """Stream all endpoints sequentially.

        PayPal adapter only supports the ``transactions`` endpoint.

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
                logger.error("Error streaming %s: %s", endpoint, e)
                # Continue with other endpoints
                continue

    # =========================================================================
    # CONNECTION TEST
    # =========================================================================

    async def test_connection(self) -> bool:
        """Test the API connection by authenticating with PayPal.

        Validates that the provided client credentials can obtain an
        access token.

        Returns:
            True if authentication is successful
        """
        try:
            await self._authenticate()
            return True
        except Exception as e:
            logger.error("Connection test failed: %s", e)
            return False
