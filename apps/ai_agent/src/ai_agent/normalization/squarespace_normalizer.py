"""Squarespace-specific normalizer for transforming raw payloads.

Handles the specific structure of Squarespace Commerce API responses
and transforms them into canonical models.
"""

import logging
import re
from decimal import Decimal
from typing import Any, Dict, List, Optional, cast
from uuid import UUID

from .models import (
    Address,
    CanonicalBase,
    CanonicalCustomer,
    CanonicalInventoryItem,
    CanonicalLineItem,
    CanonicalOrder,
    CanonicalPayment,
    CanonicalPaymentFee,
    CanonicalProduct,
    CanonicalProductVariant,
    FulfillmentStatus,
    Money,
    OrderStatus,
    PaymentStatus,
)
from .normalizer import BaseNormalizer, NormalizationResult

logger = logging.getLogger(__name__)


class SquarespaceNormalizer(BaseNormalizer):
    """Normalizer for Squarespace Commerce API payloads.

    Supports:
    - Orders (commerce/orders)
    - Products (commerce/products)
    - Profiles (profiles - customers)
    - Inventory items (commerce/inventory)
    - Transactions (commerce/transactions)
    """

    provider = "squarespace"
    supported_entity_types = [
        "order",
        "product",
        "profile",
        "inventory_item",
        "transaction",
    ]

    # =========================================================================
    # STATUS MAPPINGS
    # =========================================================================

    # Map Squarespace fulfillment status to canonical
    FULFILLMENT_STATUS_MAP = {
        "PENDING": FulfillmentStatus.UNFULFILLED,
        "UNFULFILLED": FulfillmentStatus.UNFULFILLED,
        "PARTIALLY_FULFILLED": FulfillmentStatus.PARTIAL,
        "FULFILLED": FulfillmentStatus.FULFILLED,
    }

    # Map Squarespace order to canonical order status
    # Squarespace doesn't have explicit order status, it's derived from fulfillment
    ORDER_STATUS_MAP = {
        "PENDING": OrderStatus.PENDING,
        "UNFULFILLED": OrderStatus.CONFIRMED,
        "PARTIALLY_FULFILLED": OrderStatus.PROCESSING,
        "FULFILLED": OrderStatus.DELIVERED,
        "CANCELED": OrderStatus.CANCELLED,
    }

    # =========================================================================
    # ORDER NORMALIZATION
    # =========================================================================

    def normalize_order(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a Squarespace order payload.

        Squarespace Order structure:
        - id, orderNumber
        - customerId, customerEmail
        - lineItems[]
        - subtotal, taxTotal, discountTotal, shippingTotal, grandTotal
        - billingAddress, shippingAddress
        - fulfillmentStatus, fulfillments[]
        - createdOn, modifiedOn, fulfilledOn
        """
        warnings: List[str] = []

        # Extract timestamps
        created_at = self._parse_datetime(payload.get("createdOn"))
        updated_at = self._parse_datetime(payload.get("modifiedOn"))

        # Extract currency from grand total
        currency = self._get_nested(payload, "grandTotal", "currency", default="GBP")

        # Normalize line items
        line_items = self._normalize_line_items(payload.get("lineItems", []), currency)

        # Normalize addresses
        shipping_address = self._normalize_address(payload.get("shippingAddress"))
        billing_address = self._normalize_address(payload.get("billingAddress"))

        # Determine statuses
        sqsp_fulfillment_status = payload.get("fulfillmentStatus", "PENDING")
        fulfillment_status = self.FULFILLMENT_STATUS_MAP.get(
            sqsp_fulfillment_status, FulfillmentStatus.UNFULFILLED
        )
        order_status = self.ORDER_STATUS_MAP.get(
            sqsp_fulfillment_status, OrderStatus.PENDING
        )

        # Check for refunds
        refunded_total = self._normalize_money(payload.get("refundedTotal"), currency)
        if refunded_total and refunded_total.amount > 0:
            order_status = OrderStatus.REFUNDED

        # Collect provider-specific data into metadata
        metadata: Dict[str, Any] = {}
        if payload.get("channel"):
            metadata["channel"] = payload["channel"]
        if payload.get("channelName"):
            metadata["channel_name"] = payload["channelName"]
        if payload.get("testmode"):
            metadata["is_test"] = True
        if payload.get("internalNotes"):
            metadata["internal_notes"] = [
                note.get("content", "")
                for note in payload["internalNotes"]
                if note.get("content")
            ]
        if payload.get("shippingLines"):
            metadata["shipping_lines"] = payload["shippingLines"]
        if payload.get("fulfillments"):
            metadata["fulfillments"] = payload["fulfillments"]
        fulfilled_at = self._parse_datetime(payload.get("fulfilledOn"))
        if fulfilled_at:
            metadata["fulfilled_at"] = fulfilled_at.isoformat()

        # Build canonical order
        canonical_order = CanonicalOrder(
            # Provenance
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            updated_at=updated_at,
            # Entity scoping
            entity_id=self.entity_id,
            # Customer reference
            customer_external_id=payload.get("customerId"),
            customer_email=payload.get("customerEmail"),
            # Order details
            order_number=payload.get("orderNumber", external_id),
            currency=currency,
            # Status
            status=order_status,
            fulfillment_status=fulfillment_status,
            # Line items
            line_items=line_items,
            # Totals
            subtotal=self._normalize_money(payload.get("subtotal"), currency),
            discount_total=self._normalize_money(
                payload.get("discountTotal"), currency
            ),
            shipping_total=self._normalize_money(
                payload.get("shippingTotal"), currency
            ),
            tax_total=self._normalize_money(payload.get("taxTotal"), currency),
            grand_total=self._normalize_money(payload.get("grandTotal"), currency),
            refunded_total=refunded_total,
            # Addresses
            shipping_address=shipping_address,
            billing_address=billing_address,
            # Provider-specific metadata
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_order,
            entity_type="order",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    def _normalize_line_items(
        self, line_items: List[Dict[str, Any]], default_currency: str
    ) -> List[CanonicalLineItem]:
        """Normalize Squarespace line items."""
        result = []

        for item in line_items:
            unit_price = self._normalize_money(
                item.get("unitPricePaid"), default_currency
            )

            quantity = item.get("quantity", 1)

            # Calculate total price
            total_value = unit_price.amount * quantity if unit_price else Decimal("0")
            total_price = Money(amount=total_value, currency=default_currency)

            # Collect provider-specific line item data
            item_metadata: Dict[str, Any] = {}
            if item.get("imageUrl"):
                item_metadata["image_url"] = item["imageUrl"]
            if item.get("customizations"):
                item_metadata["customizations"] = item["customizations"]
            if item.get("lineItemType"):
                item_metadata["line_item_type"] = item["lineItemType"]

            canonical_item = CanonicalLineItem(
                external_id=item.get("id", ""),
                product_external_id=item.get("productId"),
                variant_external_id=item.get("variantId"),
                sku=item.get("sku"),
                product_name=item.get("productName", "Unknown Product"),
                quantity=quantity,
                unit_price=unit_price,
                total_price=total_price,
                metadata=item_metadata,
            )
            result.append(canonical_item)

        return result

    # =========================================================================
    # CUSTOMER/PROFILE NORMALIZATION
    # =========================================================================

    def normalize_profile(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a Squarespace profile (customer) payload.

        Squarespace Profile structure:
        - id, email, firstName, lastName
        - address{}
        - hasAccount, isCustomer, acceptsMarketing
        - transactionsSummary{}
        """
        warnings: List[str] = []

        # Extract timestamps
        created_at = self._parse_datetime(payload.get("createdOn"))

        # Normalize address
        default_address = self._normalize_address(payload.get("address"))

        # Collect provider-specific data into metadata
        metadata: Dict[str, Any] = {}
        if payload.get("acceptsMarketing"):
            metadata["accepts_marketing"] = True
        if payload.get("hasAccount"):
            metadata["has_account"] = True

        # Store transaction summary aggregates in metadata
        tx_summary = payload.get("transactionsSummary", {})
        if tx_summary:
            metadata["transaction_summary"] = tx_summary

        canonical_customer = CanonicalCustomer(
            # Provenance
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            # Entity scoping
            entity_id=self.entity_id,
            # Customer details
            email=payload.get("email"),
            first_name=payload.get("firstName"),
            last_name=payload.get("lastName"),
            # Address
            default_address=default_address,
            # Provider-specific metadata
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_customer,
            entity_type="profile",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    # =========================================================================
    # PRODUCT NORMALIZATION
    # =========================================================================

    def normalize_product(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a Squarespace product payload.

        Squarespace Product structure:
        - id, name, description, type
        - url, urlSlug
        - isVisible
        - variants[]
        - variantAttributes[]
        - images[]
        - tags[]
        """
        warnings: List[str] = []

        # Extract timestamps
        created_at = self._parse_datetime(payload.get("createdOn"))
        updated_at = self._parse_datetime(payload.get("modifiedOn"))

        # Normalize variants
        variants = self._normalize_variants(payload.get("variants", []))

        # Collect provider-specific data into metadata
        metadata: Dict[str, Any] = {}
        if payload.get("url"):
            metadata["url"] = payload["url"]
        if payload.get("urlSlug"):
            metadata["url_slug"] = payload["urlSlug"]
        if payload.get("isVisible") is not None:
            metadata["is_visible"] = payload["isVisible"]
        if payload.get("variantAttributes"):
            metadata["variant_attributes"] = payload["variantAttributes"]
        if payload.get("images"):
            metadata["images"] = payload["images"]
        seo_options = payload.get("seoOptions") or {}
        if seo_options:
            metadata["seo"] = seo_options

        # Map Squarespace visibility to universal status
        status = "active"
        if payload.get("isVisible") is False:
            status = "draft"

        canonical_product = CanonicalProduct(
            # Provenance
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            updated_at=updated_at,
            # Entity scoping
            entity_id=self.entity_id,
            # Product details
            name=payload.get("name", "Unknown Product"),
            description=payload.get("description"),
            product_type=payload.get("type"),
            status=status,
            # Variants
            variants=variants,
            # Tags
            tags=payload.get("tags", []),
            # Provider-specific metadata
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_product,
            entity_type="product",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    def _normalize_variants(
        self, variants: List[Dict[str, Any]]
    ) -> List[CanonicalProductVariant]:
        """Normalize Squarespace product variants."""
        result = []

        for variant in variants:
            # Extract pricing
            pricing = variant.get("pricing", {})
            base_price = pricing.get("basePrice", {})
            sale_price = pricing.get("salePrice", {})

            price = Money(
                amount=Decimal(str(base_price.get("value", "0"))),
                currency=base_price.get("currency", "GBP"),
            )

            compare_at = None
            if pricing.get("onSale") and sale_price.get("value"):
                compare_at = price
                price = Money(
                    amount=Decimal(str(sale_price.get("value", "0"))),
                    currency=sale_price.get("currency", "GBP"),
                )

            # Extract stock
            stock = variant.get("stock", {})
            quantity = stock.get("quantity", 0)
            is_unlimited = stock.get("unlimited", False)

            canonical_variant = CanonicalProductVariant(
                external_id=variant.get("id", ""),
                sku=variant.get("sku"),
                price=price,
                compare_at_price=compare_at,
                on_sale=pricing.get("onSale", False),
                quantity=quantity,
                is_unlimited=is_unlimited,
                attributes=variant.get("attributes", {}),
            )
            result.append(canonical_variant)

        return result

    # =========================================================================
    # INVENTORY NORMALIZATION
    # =========================================================================

    def normalize_inventory_item(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a Squarespace inventory item payload.

        Squarespace Inventory structure:
        - variantId, sku, descriptor
        - quantity, isUnlimited
        """
        warnings: List[str] = []

        # Provider-specific fields → metadata
        metadata: Dict[str, Any] = {}
        if payload.get("descriptor"):
            metadata["descriptor"] = payload["descriptor"]

        canonical_item = CanonicalInventoryItem(
            # Provenance
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            # Entity scoping
            entity_id=self.entity_id,
            # Product reference
            variant_external_id=payload.get("variantId", external_id),
            sku=payload.get("sku"),
            # Inventory levels
            quantity=payload.get("quantity", 0),
            is_unlimited=payload.get("isUnlimited", False),
            # Provider-specific
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_item,
            entity_type="inventory_item",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    # =========================================================================
    # TRANSACTION/PAYMENT NORMALIZATION
    # =========================================================================

    def normalize_transaction(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a Squarespace transaction document.

        Note: Squarespace transactions API returns 'documents' which represent
        transaction records that contain multiple payments. We normalize each
        payment within a document as a separate CanonicalPayment.

        For multi-payment scenarios, we return a list of CanonicalPayment objects.

        Squarespace Transaction Document structure:
        - id, createdOn, modifiedOn
        - customerEmail, salesOrderId
        - totalSales, totalNetSales, totalNetShipping, totalTaxes, total, totalNetPayment
        - payments[] (with refunds, processingFees)
        - salesLineItems[], discounts[], shippingLineItems[]
        - voided, paymentGatewayError
        """
        warnings: List[str] = []

        # Extract payments array
        payments_data = payload.get("payments", [])

        if not payments_data:
            warnings.append("Transaction document contains no payments")
            return NormalizationResult.failure_result(
                entity_type="transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message="No payments found in transaction document",
            )

        # Get order reference
        order_external_id = payload.get("salesOrderId")
        customer_email = payload.get("customerEmail")

        # Build document-level metadata (only truly supplementary info)
        document_metadata: Dict[str, Any] = {
            "document_id": payload.get("id"),
            "customer_email": customer_email,
            "voided": payload.get("voided", False),
        }

        # Document-level totals (useful for reconciliation)
        for key in (
            "totalSales",
            "totalNetSales",
            "total",
            "totalNetPayment",
            "totalNetShipping",
            "totalTaxes",
        ):
            if payload.get(key):
                document_metadata[f"document_{self._camel_to_snake(key)}"] = payload[
                    key
                ]

        # Supplementary document data
        if payload.get("salesLineItems"):
            document_metadata["sales_line_items"] = payload["salesLineItems"]
        if payload.get("discounts"):
            document_metadata["discounts"] = payload["discounts"]
        if payload.get("shippingLineItems"):
            document_metadata["shipping_line_items"] = payload["shippingLineItems"]
        if payload.get("paymentGatewayError"):
            document_metadata["payment_gateway_error"] = payload["paymentGatewayError"]
            warnings.append(f"Payment gateway error: {payload['paymentGatewayError']}")

        # Normalize each payment in the document
        canonical_payments: List[CanonicalPayment] = []

        for idx, payment_data in enumerate(payments_data):
            payment_id = payment_data.get("id", f"{external_id}-payment-{idx}")

            # Extract monetary values
            amount_raw = payment_data.get("amount", {})
            refunded_raw = payment_data.get("refundedAmount", {})
            net_raw = payment_data.get("netAmount", {})

            amount_value = Decimal(str(amount_raw.get("value", "0")))
            refunded_value = Decimal(str(refunded_raw.get("value", "0")))
            net_value = Decimal(str(net_raw.get("value", "0")))
            payment_currency = amount_raw.get("currency", "USD")

            # Determine payment status
            payment_status = PaymentStatus.CAPTURED
            if refunded_value > 0:
                if refunded_value >= amount_value:
                    payment_status = PaymentStatus.REFUNDED
                # Partial refunds still show as CAPTURED in our model
            if payload.get("voided"):
                payment_status = PaymentStatus.FAILED

            # Extract gateway and payment method
            gateway = payment_data.get("provider")
            credit_card_type = payment_data.get("creditCardType")

            payment_method = credit_card_type
            if payment_data.get("giftCardId"):
                payment_method = "GIFT_CARD"
            elif not payment_method:
                payment_method = gateway or "UNKNOWN"

            # Parse timestamps
            created_at = self._parse_datetime(payload.get("createdOn"))
            paid_on = self._parse_datetime(payment_data.get("paidOn"))

            # Normalize processing fees into dedicated models
            fees = self._normalize_processing_fees(
                payment_data.get("processingFees", []), payment_currency
            )

            # Build metadata (only supplementary info not in dedicated columns)
            payment_metadata = dict(document_metadata)
            if payment_data.get("externalCustomerId"):
                payment_metadata["external_customer_id"] = payment_data[
                    "externalCustomerId"
                ]
            if payment_data.get("refunds"):
                payment_metadata["refunds"] = payment_data["refunds"]
            if payment_data.get("giftCardId"):
                payment_metadata["gift_card_id"] = payment_data["giftCardId"]
            if payment_data.get("externalTransactionProperties"):
                payment_metadata["external_transaction_properties"] = payment_data[
                    "externalTransactionProperties"
                ]

            canonical_payment = CanonicalPayment(
                # Provenance
                provider=self.provider,
                external_id=payment_id,
                raw_event_id=raw_event_id,
                created_at=paid_on or created_at,
                # Entity scoping
                entity_id=self.entity_id,
                # Order reference
                order_external_id=order_external_id,
                # Payment amounts (dedicated columns)
                amount=Money(amount=amount_value, currency=payment_currency),
                refunded_amount=Money(amount=refunded_value, currency=payment_currency),
                net_amount=Money(amount=net_value, currency=payment_currency),
                status=payment_status,
                # Gateway info (dedicated columns)
                gateway=gateway,
                external_payment_id=payment_data.get("externalTransactionId"),
                # Payment method
                payment_method=payment_method,
                # Legacy field (kept for backward compat, mirrors external_payment_id)
                transaction_id=payment_data.get("externalTransactionId"),
                # Timing (dedicated column)
                paid_on=paid_on,
                # Processing fees
                fees=fees,
                # Only truly supplementary metadata
                metadata=payment_metadata,
            )

            canonical_payments.append(canonical_payment)

        # Return single payment or list of payments
        if len(canonical_payments) == 1:
            canonical = canonical_payments[0]
        else:
            canonical = cast(List[CanonicalBase], canonical_payments)

        return NormalizationResult.success_result(
            canonical=canonical,
            entity_type="transaction",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    def _normalize_processing_fees(
        self, fees_data: List[Dict[str, Any]], default_currency: str
    ) -> List[CanonicalPaymentFee]:
        """Normalize Squarespace processing fees into canonical models."""
        result = []

        for fee in fees_data:
            gross = fee.get("amount", {})
            refunded = fee.get("refundedAmount", {})
            net = fee.get("netAmount", {})
            fee_currency = gross.get("currency", default_currency)

            # Collect supplementary fee data into metadata
            fee_metadata: Dict[str, Any] = {}
            if fee.get("exchangeRate"):
                fee_metadata["exchange_rate"] = fee["exchangeRate"]
            if fee.get("amountGatewayCurrency"):
                fee_metadata["amount_gateway_currency"] = fee["amountGatewayCurrency"]
            if fee.get("refundedAmountGatewayCurrency"):
                fee_metadata["refunded_amount_gateway_currency"] = fee[
                    "refundedAmountGatewayCurrency"
                ]
            if fee.get("netAmountGatewayCurrency"):
                fee_metadata["net_amount_gateway_currency"] = fee[
                    "netAmountGatewayCurrency"
                ]
            if fee.get("feeRefunds"):
                fee_metadata["fee_refunds"] = fee["feeRefunds"]

            canonical_fee = CanonicalPaymentFee(
                external_fee_id=fee.get("id"),
                gross_fee=Money(
                    amount=Decimal(str(gross.get("value", "0"))), currency=fee_currency
                ),
                refunded_fee=Money(
                    amount=Decimal(str(refunded.get("value", "0"))),
                    currency=fee_currency,
                ),
                net_fee=Money(
                    amount=Decimal(str(net.get("value", "0"))), currency=fee_currency
                ),
                metadata=fee_metadata,
            )
            result.append(canonical_fee)

        return result

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    def _normalize_address(
        self, address_data: Optional[Dict[str, Any]]
    ) -> Optional[Address]:
        """Normalize a Squarespace address."""
        if not address_data:
            return None

        return Address(
            first_name=address_data.get("firstName"),
            last_name=address_data.get("lastName"),
            address_line_1=address_data.get("address1"),
            address_line_2=address_data.get("address2"),
            city=address_data.get("city"),
            state=address_data.get("state"),
            postal_code=address_data.get("postalCode"),
            country_code=address_data.get("countryCode"),
            phone=address_data.get("phone"),
        )

    def _normalize_money(
        self, money_data: Optional[Dict[str, Any]], default_currency: str = "GBP"
    ) -> Money:
        """Normalize a Squarespace money object."""
        if not money_data:
            return Money(amount=Decimal("0"), currency=default_currency)

        return Money(
            amount=Decimal(str(money_data.get("value", "0"))),
            currency=money_data.get("currency", default_currency),
        )

    @staticmethod
    def _camel_to_snake(name: str) -> str:
        """Convert camelCase to snake_case."""
        return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()
