"""Tests for the data normalization system.

Tests cover:
- Canonical model validation
- Squarespace normalizer logic
- Persistence layer operations
"""

import pytest
from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from ai_agent.normalization.models import (
    Address,
    CanonicalCustomer,
    CanonicalLineItem,
    CanonicalOrder,
    CanonicalProduct,
    CanonicalProductVariant,
    CanonicalInventoryItem,
    FulfillmentStatus,
    Money,
    OrderStatus,
    ProcessingStatus,
)
from ai_agent.normalization.normalizer import NormalizationResult
from ai_agent.normalization.squarespace_normalizer import SquarespaceNormalizer


# =============================================================================
# FIXTURES
# =============================================================================

@pytest.fixture
def entity_id():
    """Generate a test entity ID."""
    return uuid4()


@pytest.fixture
def raw_event_id():
    """Generate a test raw event ID."""
    return uuid4()


@pytest.fixture
def sample_order_payload():
    """Sample Squarespace order payload."""
    return {
        "id": "6519c77186b1297c666e4f58",
        "channel": "web",
        "subtotal": {"value": "50.00", "currency": "GBP"},
        "taxTotal": {"value": "0.00", "currency": "GBP"},
        "testmode": False,
        "createdOn": "2023-10-01T19:24:31.654Z",
        "lineItems": [
            {
                "id": "6519c758269dab00011e4472",
                "sku": "TBAXTYCOONE_GREEN_CAP",
                "quantity": 1,
                "productId": "6519a6440e80906b120659ff",
                "variantId": "f54a4e59-ab5a-4ffb-8cb6-69366aaf54ee",
                "productName": "TBA X TYCOONE GREEN INCOGNITO CAP (YORUBA)",
                "lineItemType": "PHYSICAL_PRODUCT",
                "unitPricePaid": {"value": "50.00", "currency": "GBP"},
                "imageUrl": "https://example.com/image.jpg",
            }
        ],
        "customerId": "645164a87e19df6ec7c00fa1",
        "grandTotal": {"value": "56.00", "currency": "GBP"},
        "modifiedOn": "2023-10-07T12:17:23.340Z",
        "channelName": "Squarespace",
        "fulfilledOn": "2023-10-07T12:17:23.339Z",
        "orderNumber": "2685",
        "fulfillments": [
            {
                "service": "Standard",
                "shipDate": "2023-10-07T12:17:23Z",
                "carrierName": "UPS",
                "trackingUrl": "https://www.track.com/12345",
                "trackingNumber": "1ZE53C926837580760"
            }
        ],
        "customerEmail": "test@example.com",
        "discountLines": [],
        "discountTotal": {"value": "0.00", "currency": "GBP"},
        "internalNotes": [],
        "refundedTotal": {"value": "0.00", "currency": "GBP"},
        "shippingLines": [
            {"amount": {"value": "6.00", "currency": "GBP"}, "method": "UK (TRACKED)"}
        ],
        "shippingTotal": {"value": "6.00", "currency": "GBP"},
        "billingAddress": {
            "city": "London",
            "phone": "",
            "state": "England",
            "address1": "123 Test Street",
            "address2": None,
            "lastName": "Doe",
            "firstName": "John",
            "postalCode": "SW1A 1AA",
            "countryCode": "GB"
        },
        "shippingAddress": {
            "city": "London",
            "phone": None,
            "state": "England",
            "address1": "123 Test Street",
            "address2": None,
            "lastName": "Doe",
            "firstName": "John",
            "postalCode": "SW1A 1AA",
            "countryCode": "GB"
        },
        "fulfillmentStatus": "FULFILLED",
    }


@pytest.fixture
def sample_profile_payload():
    """Sample Squarespace profile (customer) payload."""
    return {
        "id": "64516393073cd14f29963974",
        "email": "customer@example.com",
        "address": {
            "city": "Manchester",
            "phone": None,
            "state": "England",
            "address1": "456 Customer Ave",
            "address2": None,
            "lastName": "Smith",
            "firstName": "Jane",
            "postalCode": "M1 1AB",
            "countryCode": "GB"
        },
        "lastName": "Smith",
        "createdOn": "2023-05-02T19:25:07.935Z",
        "firstName": "Jane",
        "hasAccount": False,
        "isCustomer": True,
        "acceptsMarketing": False,
        "transactionsSummary": {
            "orderCount": 5,
            "donationCount": 0,
            "totalOrderAmount": {"value": "250.00", "currency": "GBP"},
            "totalRefundAmount": {"value": "0.00", "currency": "GBP"},
            "lastOrderSubmittedOn": "2024-04-05T15:21:15.955Z",
            "firstOrderSubmittedOn": "2023-05-02T19:25:07.949Z",
        }
    }


@pytest.fixture
def sample_product_payload():
    """Sample Squarespace product payload."""
    return {
        "id": "67a8c0b492266c68f8e432d0",
        "url": "https://www.example.com/store/test-product",
        "name": "Test T-Shirt",
        "tags": ["apparel", "summer"],
        "type": "PHYSICAL",
        "images": [
            {
                "id": "67a8c10d51efce572cd291c5",
                "url": "https://example.com/image.jpg",
                "altText": "",
                "orderIndex": 0
            }
        ],
        "urlSlug": "test-t-shirt",
        "variants": [
            {
                "id": "f7099b25-ee88-4dbb-b604-21f61803a302",
                "sku": "TEST-XS",
                "stock": {"quantity": 10, "unlimited": False},
                "pricing": {
                    "onSale": False,
                    "basePrice": {"value": "50.00", "currency": "GBP"},
                    "salePrice": {"value": "0.00", "currency": "GBP"}
                },
                "attributes": {"Size": "XS"},
                "shippingMeasurements": {
                    "weight": {"unit": "KILOGRAM", "value": 0.5},
                    "dimensions": {"unit": "CENTIMETER", "width": 0, "height": 0, "length": 0}
                }
            },
            {
                "id": "79514088-1032-4139-a1b0-b05e08c2544e",
                "sku": "TEST-S",
                "stock": {"quantity": 15, "unlimited": False},
                "pricing": {
                    "onSale": True,
                    "basePrice": {"value": "50.00", "currency": "GBP"},
                    "salePrice": {"value": "40.00", "currency": "GBP"}
                },
                "attributes": {"Size": "S"},
            }
        ],
        "createdOn": "2025-02-09T14:50:28.040Z",
        "isVisible": True,
        "modifiedOn": "2025-08-21T18:15:41.285Z",
        "description": "<p>A great test product</p>",
        "variantAttributes": ["Size"]
    }


@pytest.fixture
def sample_inventory_payload():
    """Sample Squarespace inventory item payload."""
    return {
        "sku": "D2DHL",
        "quantity": 25,
        "variantId": "9a2e1955-c515-46df-81e7-71d621241f52",
        "descriptor": "D2D FLOCK HOODIE [L]",
        "isUnlimited": False
    }


# =============================================================================
# MODEL TESTS
# =============================================================================

class TestMoneyModel:
    """Tests for Money model."""
    
    def test_money_from_dict(self):
        """Test parsing money from Squarespace format."""
        money = Money(amount={"value": "50.00", "currency": "GBP"}, currency="GBP")  # type: ignore[arg-type]
        assert money.amount == Decimal("50.00")
        assert money.currency == "GBP"
    
    def test_money_from_string(self):
        """Test parsing money from string."""
        money = Money(amount="99.99", currency="USD")  # type: ignore[arg-type]
        assert money.amount == Decimal("99.99")
    
    def test_money_from_decimal(self):
        """Test money with Decimal."""
        money = Money(amount=Decimal("123.45"), currency="EUR")
        assert money.amount == Decimal("123.45")


class TestAddressModel:
    """Tests for Address model."""
    
    def test_address_creation(self):
        """Test address model creation."""
        address = Address(
            first_name="John",
            last_name="Doe",
            address_line_1="123 Test St",
            city="London",
            postal_code="SW1A 1AA",
            country_code="GB"
        )
        assert address.first_name == "John"
        assert address.country_code == "GB"


# =============================================================================
# NORMALIZER TESTS
# =============================================================================

class TestSquarespaceNormalizer:
    """Tests for Squarespace normalizer."""
    
    def test_normalizer_init(self, entity_id):
        """Test normalizer initialization."""
        normalizer = SquarespaceNormalizer(entity_id)
        assert normalizer.provider == "squarespace"
        assert normalizer.entity_id == entity_id
        assert "order" in normalizer.supported_entity_types
    
    def test_normalize_order(self, entity_id, raw_event_id, sample_order_payload):
        """Test order normalization."""
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="order",
            external_id=sample_order_payload["id"],
            payload=sample_order_payload,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert result.status == ProcessingStatus.COMPLETED
        assert isinstance(result.canonical, CanonicalOrder)
        
        order = result.canonical
        assert order.provider == "squarespace"
        assert order.external_id == "6519c77186b1297c666e4f58"
        assert order.order_number == "2685"
        assert order.status == OrderStatus.DELIVERED
        assert order.fulfillment_status == FulfillmentStatus.FULFILLED
        assert order.grand_total.amount == Decimal("56.00")
        assert order.grand_total.currency == "GBP"
        assert len(order.line_items) == 1
        assert order.line_items[0].quantity == 1
        assert order.line_items[0].sku == "TBAXTYCOONE_GREEN_CAP"
    
    def test_normalize_profile(self, entity_id, raw_event_id, sample_profile_payload):
        """Test profile/customer normalization."""
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="profile",
            external_id=sample_profile_payload["id"],
            payload=sample_profile_payload,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert isinstance(result.canonical, CanonicalCustomer)
        
        customer = result.canonical
        assert customer.email == "customer@example.com"
        assert customer.first_name == "Jane"
        assert customer.last_name == "Smith"
        # Provider-specific fields moved to metadata
        assert customer.metadata["accepts_marketing"] is False
        assert customer.metadata["total_orders"] == 5
        assert customer.metadata["total_spent"]["amount"] == "250.00"
    
    def test_normalize_product(self, entity_id, raw_event_id, sample_product_payload):
        """Test product normalization."""
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="product",
            external_id=sample_product_payload["id"],
            payload=sample_product_payload,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert isinstance(result.canonical, CanonicalProduct)
        
        product = result.canonical
        assert product.name == "Test T-Shirt"
        assert len(product.variants) == 2
        assert product.variants[0].sku == "TEST-XS"
        assert product.variants[0].quantity == 10
        assert product.variants[1].on_sale is True
        assert product.tags == ["apparel", "summer"]
    
    def test_normalize_inventory_item(self, entity_id, raw_event_id, sample_inventory_payload):
        """Test inventory item normalization."""
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="inventory_item",
            external_id=sample_inventory_payload["variantId"],
            payload=sample_inventory_payload,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert isinstance(result.canonical, CanonicalInventoryItem)
        
        item = result.canonical
        assert item.sku == "D2DHL"
        assert item.is_unlimited is False
        assert item.description == "D2D FLOCK HOODIE [L]"
    
    def test_normalize_unsupported_type(self, entity_id, raw_event_id):
        """Test normalization of unsupported entity type."""
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="unknown_type",
            external_id="test-id",
            payload={},
            raw_event_id=raw_event_id
        )
        
        assert result.success is False
        assert result.status == ProcessingStatus.FAILED
        assert result.error_message is not None
        assert "Unsupported entity type" in result.error_message


class TestNormalizationResult:
    """Tests for NormalizationResult."""
    
    def test_success_result(self, entity_id, raw_event_id):
        """Test creating a success result."""
        customer = CanonicalCustomer(
            provider="squarespace",
            external_id="test-123",
            raw_event_id=raw_event_id,
            entity_id=entity_id,
            email="test@example.com"
        )
        
        result = NormalizationResult.success_result(
            canonical=customer,
            entity_type="profile",
            external_id="test-123",
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert result.status == ProcessingStatus.COMPLETED
        assert result.canonical == customer
    
    def test_failure_result(self, raw_event_id):
        """Test creating a failure result."""
        result = NormalizationResult.failure_result(
            entity_type="order",
            external_id="bad-order",
            raw_event_id=raw_event_id,
            error_message="Invalid data",
            error_details={"field": "amount", "reason": "negative value"}
        )
        
        assert result.success is False
        assert result.status == ProcessingStatus.FAILED
        assert result.error_message is not None
        assert "Invalid data" in result.error_message
    
    def test_needs_review_result(self, entity_id, raw_event_id):
        """Test creating a needs-review result."""
        customer = CanonicalCustomer(
            provider="squarespace",
            external_id="suspicious-123",
            raw_event_id=raw_event_id,
            entity_id=entity_id,
        )
        
        result = NormalizationResult.needs_review_result(
            canonical=customer,
            entity_type="profile",
            external_id="suspicious-123",
            raw_event_id=raw_event_id,
            review_reason="Missing required fields"
        )
        
        assert result.success is True
        assert result.status == ProcessingStatus.NEEDS_REVIEW
        assert result.needs_review is True


# =============================================================================
# EDGE CASES
# =============================================================================

class TestEdgeCases:
    """Tests for edge cases and error handling."""
    
    def test_empty_line_items(self, entity_id, raw_event_id, sample_order_payload):
        """Test order with no line items."""
        sample_order_payload["lineItems"] = []
        
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="order",
            external_id=sample_order_payload["id"],
            payload=sample_order_payload,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert isinstance(result.canonical, CanonicalOrder)
        assert len(result.canonical.line_items) == 0
    
    def test_missing_optional_fields(self, entity_id, raw_event_id):
        """Test with minimal required fields."""
        minimal_order = {
            "id": "minimal-order",
            "orderNumber": "1",
            "grandTotal": {"value": "10.00", "currency": "GBP"},
            "subtotal": {"value": "10.00", "currency": "GBP"},
            "taxTotal": {"value": "0.00", "currency": "GBP"},
            "discountTotal": {"value": "0.00", "currency": "GBP"},
            "shippingTotal": {"value": "0.00", "currency": "GBP"},
        }
        
        normalizer = SquarespaceNormalizer(entity_id)
        result = normalizer.normalize(
            entity_type="order",
            external_id="minimal-order",
            payload=minimal_order,
            raw_event_id=raw_event_id
        )
        
        assert result.success is True
        assert isinstance(result.canonical, CanonicalOrder)
        assert result.canonical.order_number == "1"
    
    def test_datetime_parsing(self, entity_id, raw_event_id):
        """Test various datetime formats."""
        normalizer = SquarespaceNormalizer(entity_id)
        
        # ISO format with Z
        dt1 = normalizer._parse_datetime("2023-10-01T19:24:31.654Z")
        assert dt1 is not None
        assert dt1.year == 2023
        
        # ISO format with timezone
        dt2 = normalizer._parse_datetime("2023-10-01T19:24:31+00:00")
        assert dt2 is not None
        
        # None value
        dt3 = normalizer._parse_datetime(None)
        assert dt3 is None
        
        # Invalid format
        dt4 = normalizer._parse_datetime("invalid-date")
        assert dt4 is None


# =============================================================================
# IDEMPOTENCY TESTS
# =============================================================================

class TestIdempotency:
    """Tests for normalization idempotency."""
    
    def test_same_input_same_output(self, entity_id, raw_event_id, sample_order_payload):
        """Test that same input always produces same output."""
        normalizer = SquarespaceNormalizer(entity_id)
        
        result1 = normalizer.normalize(
            entity_type="order",
            external_id=sample_order_payload["id"],
            payload=sample_order_payload,
            raw_event_id=raw_event_id
        )
        
        result2 = normalizer.normalize(
            entity_type="order",
            external_id=sample_order_payload["id"],
            payload=sample_order_payload,
            raw_event_id=raw_event_id
        )
        
        assert isinstance(result1.canonical, CanonicalOrder)
        assert isinstance(result2.canonical, CanonicalOrder)
        
        assert result1.canonical.external_id == result2.canonical.external_id
        assert result1.canonical.order_number == result2.canonical.order_number
        assert result1.canonical.grand_total == result2.canonical.grand_total
        assert len(result1.canonical.line_items) == len(result2.canonical.line_items)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
