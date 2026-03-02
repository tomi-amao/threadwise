"""Squarespace API adapter for ThreadWise.

Handles paginated data extraction from Squarespace Commerce API endpoints.
Never transforms data - stores exact API payloads.
"""

import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..common import PaginatedResult, RawEventRecord

# Re-export for backward compatibility
__all__ = ["PaginatedResult", "RawEventRecord", "SquarespaceAdapter"]

logger = logging.getLogger(__name__)

# Squarespace Commerce API endpoints
SQUARESPACE_BASE_URL = "https://api.squarespace.com"

ENDPOINTS = {
    "products": f"{SQUARESPACE_BASE_URL}/v2/commerce/products",
    "store_pages": f"{SQUARESPACE_BASE_URL}/1.0/commerce/store_pages",
    "orders": f"{SQUARESPACE_BASE_URL}/1.0/commerce/orders",
    "inventory": f"{SQUARESPACE_BASE_URL}/1.0/commerce/inventory",
    "transactions": f"{SQUARESPACE_BASE_URL}/1.0/commerce/transactions",
    "profiles": f"{SQUARESPACE_BASE_URL}/1.0/profiles"
}


class SquarespaceAdapter:
    """Adapter for Squarespace Commerce API.
    
    Features:
    - Paginated extraction from all commerce endpoints
    - Slow pagination to respect rate limits
    - Never transforms data - stores exact API payloads
    - Yields raw events for streaming storage
    """
    
    def __init__(
        self,
        api_key: str,
        page_size: int = 50,
        timeout: float = 30.0
    ):
        """Initialize the Squarespace adapter.
        
        Args:
            api_key: Squarespace API key
            page_size: Number of items per page (default: 50, max: 100)
            timeout: Request timeout in seconds
        """
        self.api_key = api_key
        self.page_size = min(page_size, 100)  # Max 100 per Squarespace docs
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "ThreadWise/1.0"
        }
    
    async def _make_request(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Make an authenticated request to Squarespace API.
        
        Args:
            url: API endpoint URL
            params: Query parameters
            
        Returns:
            API response as dict
            
        Raises:
            httpx.HTTPStatusError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                url,
                headers=self._headers,
                params=params or {}
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
            "products": "product",
            "store_pages": "store_page",
            "orders": "order",
            "inventory": "inventory_item",
            "transactions": "transaction",
            "profiles": "profile",
        }
        return mapping.get(endpoint, endpoint)
    
    def _extract_external_id(
        self,
        item: Dict[str, Any],
        entity_type: str
    ) -> str:
        """Extract the external ID from an item based on entity type.
        
        Args:
            item: Raw API item
            entity_type: Type of entity
            
        Returns:
            External ID string
        """
        # Squarespace uses 'id' for most entities
        if "id" in item:
            return str(item["id"])
        
        # Fallback mappings
        id_fields = {
            "product": ["productId", "id"],
            "store_page": ["id", "urlId"],
            "order": ["orderId", "id"],
            "inventory_item": ["variantId", "productId", "id"],
            "transaction": ["transactionId", "id"],
            "profile": ["profileId", "id"],
        }
        
        for field in id_fields.get(entity_type, ["id"]):
            if field in item:
                return str(item[field])
        
        # Last resort: use hash of payload
        import hashlib
        import json
        return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:32]
    
    def _extract_occurred_at(
        self,
        item: Dict[str, Any],
        entity_type: str
    ) -> Optional[datetime]:
        """Extract the occurred_at timestamp from an item.
        
        Args:
            item: Raw API item
            entity_type: Type of entity
            
        Returns:
            datetime or None
        """
        # Common timestamp fields
        timestamp_fields = [
            "createdOn",
            "modifiedOn",
            "fulfillmentDate",
            "orderDate",
            "updatedAt",
            "createdAt",
        ]
        
        for field in timestamp_fields:
            if field in item and item[field]:
                try:
                    # Squarespace uses ISO format
                    return datetime.fromisoformat(
                        item[field].replace("Z", "+00:00")
                    )
                except (ValueError, TypeError):
                    continue
        
        return None
    
    async def fetch_page(
        self,
        endpoint: str,
        cursor: Optional[str] = None
    ) -> PaginatedResult:
        """Fetch a single page of data from an endpoint.
        
        Args:
            endpoint: Endpoint name (products, store_pages, orders, inventory, transactions, profiles, etc.)
            cursor: Pagination cursor from previous request
            
        Returns:
            PaginatedResult with items and next cursor
        """
        url = ENDPOINTS.get(endpoint)
        if not url:
            raise ValueError(f"Unknown endpoint: {endpoint}")
        
        params = {"pageSize": self.page_size}
        if cursor:
            params["cursor"] = cursor
        
        logger.info(f"Fetching {endpoint} page (cursor: {cursor or 'start'})")
        
        response = await self._make_request(url, params)
        fetched_at = datetime.now(timezone.utc)
        
        # Extract items based on endpoint response structure
        # Squarespace wraps results in different keys
        items_key_mapping = {
            "products": "products",
            "store_pages": "storePages",
            "orders": "orders",
            "inventory": "inventory",
            "transactions": "documents",
            "profiles": "profiles",
        }
        
        items_key = items_key_mapping.get(endpoint, endpoint)
        items = response.get(items_key, response.get("result", []))
        
        # Get pagination info
        pagination = response.get("pagination", {})
        next_cursor = pagination.get("nextPageCursor")
        has_more = pagination.get("hasNextPage", bool(next_cursor))
        
        return PaginatedResult(
            items=items if isinstance(items, list) else [],
            cursor=next_cursor,
            has_more=has_more,
            endpoint=endpoint,
            fetched_at=fetched_at
        )
    
    async def stream_endpoint(
        self,
        endpoint: str,
        start_cursor: Optional[str] = None
    ) -> AsyncIterator[RawEventRecord]:
        """Stream all items from an endpoint as raw event records.
        
        Yields items one by one for memory efficiency.
        Never transforms data - exact API payloads are stored.
        
        Args:
            endpoint: Endpoint name
            start_cursor: Optional cursor to resume from
            
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
                    f"HTTP error fetching {endpoint}: {e.response.status_code}"
                )
                raise
            except Exception as e:
                logger.error(f"Error fetching {endpoint}: {e}")
                raise
            
            for item in result.items:
                total_items += 1
                
                yield RawEventRecord(
                    provider="squarespace",
                    entity_type=entity_type,
                    external_id=self._extract_external_id(item, entity_type),
                    payload=item,  # Never transform - exact API payload
                    occurred_at=self._extract_occurred_at(item, entity_type),
                    fetched_at=result.fetched_at
                )
            
            logger.info(
                f"Processed page {page_count} of {endpoint} "
                f"({len(result.items)} items, {total_items} total)"
            )
            
            if not result.has_more or not result.cursor:
                break
            
            cursor = result.cursor
        
        logger.info(
            f"Completed streaming {endpoint}: "
            f"{total_items} items across {page_count} pages"
        )
    
    async def stream_all_endpoints(
        self,
        cursors: Optional[Dict[str, str]] = None
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
    
    async def test_connection(self) -> bool:
        """Test the API connection.
        
        Returns:
            True if connection is successful
        """
        try:
            # Try to fetch one item from products
            await self.fetch_page("products")
            return True
        except Exception as e:
            logger.error(f"Connection test failed: {e}")
            return False
