"""Shopify products: which statuses the first page asks for."""

import asyncio
import json
from typing import Any, Dict, Optional

from ai_agent.integrations.shopify import ShopifyAdapter


def first_page_params(endpoint: str, **kwargs: Any) -> Dict[str, Any]:
    adapter = ShopifyAdapter(
        credentials_json=json.dumps({"client_id": "id", "client_secret": "secret"}),
        shop_domain="shop.myshopify.com",
    )
    sent: Dict[str, Any] = {}

    async def fake_request(
        url: str, params: Optional[Dict[str, Any]] = None
    ) -> tuple[Dict[str, Any], Optional[str]]:
        sent.update(params or {})
        return {endpoint: []}, None

    adapter._make_request = fake_request  # type: ignore[method-assign]
    asyncio.run(adapter.fetch_page(endpoint, **kwargs))
    return sent


class TestProductStatuses:
    def test_only_active_products_by_default(self):
        assert first_page_params("products")["status"] == "active"

    def test_drafts_are_added_on_request(self):
        assert first_page_params("products", include_drafts=True)["status"] == (
            "active,draft"
        )

    def test_archived_products_are_never_asked_for(self):
        assert (
            "archived"
            not in first_page_params("products", include_drafts=True)["status"]
        )

    def test_other_endpoints_ignore_the_option(self):
        sent = first_page_params("orders", include_drafts=True)
        assert sent["status"] == "any"
