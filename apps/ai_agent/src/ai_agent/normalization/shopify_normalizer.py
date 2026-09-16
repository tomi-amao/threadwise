"""Shopify-specific normalizer for transforming raw payloads.

Handles the specific structure of Shopify Admin REST API responses
and transforms them into canonical models.
"""

import logging
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


class ShopifyNormalizer(BaseNormalizer):
    """Normalizer for Shopify Admin REST API payloads.

    Supports:
    - Orders (admin/api/.../orders.json)
    - Products (admin/api/.../products.json)
    - Customers (admin/api/.../customers.json)
    - Inventory levels (admin/api/.../inventory_levels.json)
    """

    provider = "shopify"
    supported_entity_types = ["order", "product", "customer", "inventory_item", "payment_transaction", "order_transaction"]

    # =========================================================================
    # STATUS MAPPINGS
    # =========================================================================

    ORDER_STATUS_MAP = {
        "pending": OrderStatus.PENDING,
        "open": OrderStatus.CONFIRMED,
        "closed": OrderStatus.DELIVERED,
        "cancelled": OrderStatus.CANCELLED,
    }

    FULFILLMENT_STATUS_MAP: Dict[Optional[str], FulfillmentStatus] = {
        None: FulfillmentStatus.UNFULFILLED,
        "partial": FulfillmentStatus.PARTIAL,
        "fulfilled": FulfillmentStatus.FULFILLED,
        "restocked": FulfillmentStatus.UNFULFILLED,
    }

    PAYMENT_STATUS_MAP = {
        "paid": PaymentStatus.CAPTURED,
        "partially_paid": PaymentStatus.AUTHORIZED,
        "refunded": PaymentStatus.REFUNDED,
        "partially_refunded": PaymentStatus.CAPTURED,
        "pending": PaymentStatus.PENDING,
        "voided": PaymentStatus.FAILED,
        "authorized": PaymentStatus.AUTHORIZED,
    }

    # =========================================================================
    # ORDER NORMALIZATION
    # =========================================================================

    def normalize_order(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify order payload.

        Shopify Order structure:
        - id, name (order number e.g. #1001)
        - email, customer{}
        - financial_status, fulfillment_status
        - line_items[], shipping_lines[]
        - subtotal_price, total_tax, total_shipping_price_set, total_price
        - billing_address{}, shipping_address{}
        - created_at, updated_at, closed_at, cancelled_at
        - currency
        - transactions[] (when requested with fields)
        """
        warnings: List[str] = []

        created_at = self._parse_datetime(payload.get("created_at"))
        updated_at = self._parse_datetime(payload.get("updated_at"))
        currency = payload.get("currency", "GBP")

        # Statuses
        financial_status = payload.get("financial_status", "pending")
        shopify_fulfillment = payload.get("fulfillment_status")  # can be None
        fulfillment_status = self.FULFILLMENT_STATUS_MAP.get(
            shopify_fulfillment, FulfillmentStatus.UNFULFILLED
        )
        order_status = self.ORDER_STATUS_MAP.get(
            payload.get("cancel_reason") and "cancelled" or payload.get("status", "open"),
            OrderStatus.CONFIRMED,
        )
        # Override with fulfillment-derived status when not cancelled
        if not payload.get("cancelled_at"):
            order_status = self.ORDER_STATUS_MAP.get(
                payload.get("status", "open"), OrderStatus.CONFIRMED
            )
        else:
            order_status = OrderStatus.CANCELLED

        if financial_status in ("refunded", "partially_refunded"):
            order_status = OrderStatus.REFUNDED

        # Line items
        line_items = self._normalize_line_items(payload.get("line_items", []), currency)

        # Addresses
        shipping_address = self._normalize_address(payload.get("shipping_address"))
        billing_address = self._normalize_address(payload.get("billing_address"))

        # Totals — Shopify stores price as string decimals
        subtotal = Money(
            amount=Decimal(str(payload.get("subtotal_price", "0"))),
            currency=currency,
        )
        tax_total = Money(
            amount=Decimal(str(payload.get("total_tax", "0"))),
            currency=currency,
        )
        grand_total = Money(
            amount=Decimal(str(payload.get("total_price", "0"))),
            currency=currency,
        )
        # Shopify exposes discounts as total_discounts
        discount_total = Money(
            amount=Decimal(str(payload.get("total_discounts", "0"))),
            currency=currency,
        )
        # Shipping total from shipping_lines sum
        shipping_amount = sum(
            Decimal(str(line.get("price", "0")))
            for line in payload.get("shipping_lines", [])
        )
        shipping_total = Money(amount=shipping_amount, currency=currency)

        # Refund total from refunds array
        refunded_amount = Decimal("0")
        for refund in payload.get("refunds", []):
            for transaction in refund.get("transactions", []):
                if transaction.get("kind") in ("refund", "void"):
                    refunded_amount += Decimal(str(transaction.get("amount", "0")))
        refunded_total = Money(amount=refunded_amount, currency=currency)

        # Customer references
        customer_data = payload.get("customer") or {}
        customer_external_id = str(customer_data.get("id")) if customer_data.get("id") else None
        customer_email = payload.get("email") or customer_data.get("email")

        # Metadata
        metadata: Dict[str, Any] = {}
        if payload.get("tags"):
            metadata["tags"] = payload["tags"]
        if payload.get("note"):
            metadata["note"] = payload["note"]
        if payload.get("source_name"):
            metadata["source_name"] = payload["source_name"]
        if payload.get("fulfillments"):
            metadata["fulfillments"] = [
                {"id": f.get("id"), "status": f.get("status"), "tracking_number": f.get("tracking_number")}
                for f in payload["fulfillments"]
            ]

        canonical_order = CanonicalOrder(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            updated_at=updated_at,
            entity_id=self.entity_id,
            customer_external_id=customer_external_id,
            customer_email=customer_email,
            order_number=payload.get("name", external_id),
            currency=currency,
            status=order_status,
            fulfillment_status=fulfillment_status,
            line_items=line_items,
            subtotal=subtotal,
            discount_total=discount_total,
            shipping_total=shipping_total,
            tax_total=tax_total,
            grand_total=grand_total,
            refunded_total=refunded_total,
            shipping_address=shipping_address,
            billing_address=billing_address,
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
        self,
        line_items: List[Dict[str, Any]],
        default_currency: str,
    ) -> List[CanonicalLineItem]:
        """Normalize Shopify line items."""
        result = []
        for item in line_items:
            quantity = item.get("quantity", 1)
            unit_price = Money(
                amount=Decimal(str(item.get("price", "0"))),
                currency=default_currency,
            )
            total_price = Money(
                amount=unit_price.amount * quantity,
                currency=default_currency,
            )
            item_metadata: Dict[str, Any] = {}
            if item.get("variant_title"):
                item_metadata["variant_title"] = item["variant_title"]
            if item.get("properties"):
                item_metadata["properties"] = item["properties"]

            canonical_item = CanonicalLineItem(
                external_id=str(item.get("id", "")),
                product_external_id=str(item.get("product_id")) if item.get("product_id") else None,
                variant_external_id=str(item.get("variant_id")) if item.get("variant_id") else None,
                sku=item.get("sku"),
                product_name=item.get("title", "Unknown Product"),
                quantity=quantity,
                unit_price=unit_price,
                total_price=total_price,
                metadata=item_metadata,
            )
            result.append(canonical_item)
        return result

    # =========================================================================
    # CUSTOMER NORMALIZATION
    # =========================================================================

    def normalize_profile(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Shopify has no profile entity — customers are normalised separately."""
        return NormalizationResult.skip_result(
            entity_type="profile",
            external_id=external_id,
            raw_event_id=raw_event_id,
            skip_reason="Shopify does not use profile entities; use customer instead",
        )

    def normalize_customer(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify customer payload.

        Shopify Customer structure:
        - id, email, first_name, last_name, phone
        - addresses[], default_address{}
        - orders_count, total_spent
        - created_at, updated_at
        """
        created_at = self._parse_datetime(payload.get("created_at"))

        default_address = self._normalize_address(payload.get("default_address"))

        metadata: Dict[str, Any] = {}
        if payload.get("orders_count") is not None:
            metadata["orders_count"] = payload["orders_count"]
        if payload.get("total_spent") is not None:
            metadata["total_spent"] = payload["total_spent"]
        if payload.get("tags"):
            metadata["tags"] = payload["tags"]
        if payload.get("accepts_marketing") is not None:
            metadata["accepts_marketing"] = payload["accepts_marketing"]

        canonical_customer = CanonicalCustomer(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            entity_id=self.entity_id,
            email=payload.get("email"),
            first_name=payload.get("first_name"),
            last_name=payload.get("last_name"),
            default_address=default_address,
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_customer,
            entity_type="customer",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )

    # =========================================================================
    # PRODUCT NORMALIZATION
    # =========================================================================

    def normalize_product(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify product payload.

        Shopify Product structure:
        - id, title, body_html, vendor, product_type
        - status (active, archived, draft)
        - variants[], images[], options[]
        - tags, created_at, updated_at
        """
        created_at = self._parse_datetime(payload.get("created_at"))
        updated_at = self._parse_datetime(payload.get("updated_at"))

        variants = self._normalize_variants(payload.get("variants", []))

        # Tags come as a comma-separated string in Shopify
        raw_tags = payload.get("tags", "")
        tags = [t.strip() for t in raw_tags.split(",")] if raw_tags else []

        metadata: Dict[str, Any] = {}
        if payload.get("vendor"):
            metadata["vendor"] = payload["vendor"]
        if payload.get("images"):
            metadata["images"] = [img.get("src") for img in payload["images"] if img.get("src")]
        if payload.get("options"):
            metadata["options"] = payload["options"]

        canonical_product = CanonicalProduct(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            updated_at=updated_at,
            entity_id=self.entity_id,
            name=payload.get("title", "Unknown Product"),
            description=payload.get("body_html"),
            product_type=payload.get("product_type"),
            status=payload.get("status", "active"),
            variants=variants,
            tags=tags,
            metadata=metadata,
        )

        return NormalizationResult.success_result(
            canonical=canonical_product,
            entity_type="product",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )

    def _normalize_variants(
        self,
        variants: List[Dict[str, Any]],
    ) -> List[CanonicalProductVariant]:
        """Normalize Shopify product variants."""
        result = []
        for variant in variants:
            price = Money(
                amount=Decimal(str(variant.get("price", "0"))),
                currency="GBP",  # Shopify variants don't carry currency; resolved at order time
            )
            compare_at = None
            if variant.get("compare_at_price"):
                compare_at = Money(
                    amount=Decimal(str(variant["compare_at_price"])),
                    currency="GBP",
                )

            unit_cost: Optional[Decimal] = None
            raw_inventory_cost = variant.get("inventory_item_cost")
            if raw_inventory_cost not in (None, ""):
                try:
                    parsed_cost = Decimal(str(raw_inventory_cost))
                    if parsed_cost > 0:
                        unit_cost = parsed_cost
                except Exception:
                    logger.debug(
                        "Skipping invalid Shopify variant inventory_item_cost",
                        exc_info=True,
                    )

            canonical_variant = CanonicalProductVariant(
                external_id=str(variant.get("id", "")),
                sku=variant.get("sku"),
                price=price,
                compare_at_price=compare_at,
                on_sale=bool(
                    compare_at and compare_at.amount > price.amount
                ),
                quantity=variant.get("inventory_quantity", 0) or 0,
                is_unlimited=variant.get("inventory_management") is None,
                inventory_item_id=str(variant["inventory_item_id"]) if variant.get("inventory_item_id") else None,
                unit_cost=unit_cost,
                attributes={
                    k: str(variant.get(f"option{i}", ""))
                    for i, k in enumerate(["option1", "option2", "option3"], start=1)
                    if variant.get(f"option{i}")
                },
            )
            result.append(canonical_variant)
        return result

    # =========================================================================
    # INVENTORY NORMALIZATION
    # =========================================================================

    def normalize_inventory_item(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify inventory level payload.

        Shopify inventory level structure (from inventory_levels.json):
        - inventory_item_id, location_id
        - available (integer quantity, can be null)
        - updated_at
        """
        # external_id is "{inventory_item_id}_{location_id}" (set by adapter)
        inventory_item_id = str(payload.get("inventory_item_id", external_id))
        available = payload.get("available")

        unit_cost = Decimal("0")
        raw_inventory_cost = payload.get("inventory_item_cost")
        if raw_inventory_cost not in (None, ""):
            try:
                parsed_cost = Decimal(str(raw_inventory_cost))
                if parsed_cost > 0:
                    unit_cost = parsed_cost
            except Exception:
                logger.debug(
                    "Skipping invalid Shopify inventory_item_cost on inventory level",
                    exc_info=True,
                )

        canonical_item = CanonicalInventoryItem(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            entity_id=self.entity_id,
            variant_external_id=inventory_item_id,
            available_quantity=int(available) if available is not None else None,
            location_external_id=str(payload["location_id"]) if payload.get("location_id") else None,
            # available=None means unlimited/untracked in Shopify
            is_unlimited=available is None,
            unit_cost=unit_cost,
        )

        return NormalizationResult.success_result(
            canonical=canonical_item,
            entity_type="inventory_item",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )

    # =========================================================================
    # PAYMENT TRANSACTION NORMALIZATION
    # =========================================================================

    def normalize_payment_transaction(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify balance transaction payload.

        Source: GET /admin/api/{version}/shopify_payments/balance/transactions.json
        Only available for stores using Shopify Payments.

        Relevant fields:
        - id, type (charge|refund|adjustment|payout|dispute|credit|debit|...)
        - amount, fee, net, currency
        - source_order_id  — links back to the order
        - source_id        — the underlying charge/refund ID
        - source_type      — 'charge', 'refund', 'dispute', 'transfer'
        - payout_id, payout_status
        - processed_at
        """
        txn_type = payload.get("type", "")

        # Only normalize order-linked transaction types.
        # Payouts are bank transfers; adjustments/reserves have no linked order.
        if txn_type not in ("charge", "refund"):
            return NormalizationResult.skip_result(
                entity_type="payment_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                skip_reason=f"Skipping balance transaction of type '{txn_type}'",
            )

        currency = payload.get("currency", "GBP")

        # Shopify amounts are signed strings — use abs() so Money is always positive
        amount = Decimal(str(abs(float(payload.get("amount", "0")))))
        fee_amount = Decimal(str(abs(float(payload.get("fee", "0")))))
        net_amount = Decimal(str(abs(float(payload.get("net", "0")))))

        status = PaymentStatus.REFUNDED if txn_type == "refund" else PaymentStatus.CAPTURED
        processed_at = self._parse_datetime(payload.get("processed_at"))

        source_order_id = payload.get("source_order_id")

        fees: List[CanonicalPaymentFee] = []
        if fee_amount > Decimal("0"):
            fees = [
                CanonicalPaymentFee(
                    external_fee_id=f"{external_id}_fee",
                    gross_fee=Money(amount=fee_amount, currency=currency),
                    net_fee=Money(amount=fee_amount, currency=currency),
                    refunded_fee=Money(amount=Decimal("0"), currency=currency),
                )
            ]

        canonical_payment = CanonicalPayment(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            entity_id=self.entity_id,
            created_at=processed_at,
            order_external_id=str(source_order_id) if source_order_id else None,
            amount=Money(amount=amount, currency=currency),
            net_amount=Money(amount=net_amount, currency=currency),
            status=status,
            gateway="shopify_payments",
            external_payment_id=str(payload["source_id"]) if payload.get("source_id") else None,
            paid_on=processed_at,
            fees=fees,
            metadata={
                "type": txn_type,
                "payout_id": payload.get("payout_id"),
                "payout_status": payload.get("payout_status"),
                "source_type": payload.get("source_type"),
            },
        )

        return NormalizationResult.success_result(
            canonical=canonical_payment,
            entity_type="payment_transaction",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )

    # =========================================================================
    # ORDER TRANSACTION NORMALIZATION (non-Shopify Payments gateways)
    # =========================================================================

    def normalize_order_transaction(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Shopify order transaction from the Order Transactions API.

        Source: GET /admin/api/{version}/orders/{order_id}/transactions.json
        Works for all gateways: paypal, manual, shopify_payments, etc.

        Only sale/capture/refund transactions with status=success are stored
        (filtered at the adapter layer).

        Relevant fields:
        - id, order_id, kind (sale|capture|refund)
        - gateway (paypal|manual|shopify_payments|...)
        - status (success|failure|pending|error)
        - amount, currency
        - processed_at
        - authorization — external gateway transaction reference (e.g. PayPal txn ID)
        """
        kind = payload.get("kind", "")
        gateway = payload.get("gateway", "unknown")
        currency = payload.get("currency", "GBP")
        amount = Decimal(str(abs(float(payload.get("amount", "0")))))
        processed_at = self._parse_datetime(payload.get("processed_at"))
        order_id = str(payload.get("order_id") or payload.get("_order_id", ""))

        status = PaymentStatus.REFUNDED if kind == "refund" else PaymentStatus.CAPTURED

        # ---- FX / base-currency conversion --------------------------------
        # _total_price_set is injected by shopify_sync_order_transactions from
        # the order's raw payload. Structure:
        #   {shop_money: {amount, currency_code},
        #    presentment_money: {amount, currency_code}}
        base_amount: Optional[Decimal] = None
        fx_rate: Optional[Decimal] = None

        price_set = payload.get("_total_price_set")
        if currency == "GBP":
            base_amount = amount
        elif price_set:
            try:
                shop_val = Decimal(str(price_set["shop_money"]["amount"]))
                pres_val = Decimal(str(price_set["presentment_money"]["amount"]))
                if pres_val > 0:
                    fx_rate = shop_val / pres_val
                    base_amount = (amount * fx_rate).quantize(Decimal("0.01"))
            except (KeyError, TypeError, ValueError):
                logger.warning(
                    f"Could not compute FX rate for order_transaction {external_id}: "
                    f"price_set={price_set}"
                )

        # ---- PayPal fee extraction -----------------------------------------
        # Path: receipt.purchase_units[0].payments.captures[0].seller_receivable_breakdown
        net_amount = amount
        fees: List[CanonicalPaymentFee] = []
        try:
            capture = (
                payload
                .get("receipt", {})
                .get("purchase_units", [{}])[0]
                .get("payments", {})
                .get("captures", [{}])[0]
            )
            breakdown = capture.get("seller_receivable_breakdown", {})
            if breakdown:
                fee_val = breakdown.get("paypal_fee", {}).get("value")
                net_val = breakdown.get("net_amount", {}).get("value")
                fee_currency = breakdown.get("paypal_fee", {}).get("currency_code", currency)
                if fee_val:
                    fee_amount = Decimal(str(abs(float(fee_val))))
                    net_amount = Decimal(str(abs(float(net_val)))) if net_val else amount - fee_amount
                    base_fee: Optional[Decimal] = None
                    if fee_currency == "GBP":
                        base_fee = fee_amount
                    elif fx_rate is not None:
                        base_fee = (fee_amount * fx_rate).quantize(Decimal("0.01"))
                    fees = [
                        CanonicalPaymentFee(
                            external_fee_id=f"{external_id}_fee",
                            gross_fee=Money(amount=fee_amount, currency=fee_currency),
                            net_fee=Money(amount=fee_amount, currency=fee_currency),
                            refunded_fee=Money(amount=Decimal("0"), currency=fee_currency),
                            base_fee_amount=base_fee,
                        )
                    ]
        except (IndexError, KeyError, TypeError, ValueError):
            pass  # Receipt structure absent or unexpected — fees stay empty

        canonical_payment = CanonicalPayment(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            entity_id=self.entity_id,
            created_at=processed_at,
            order_external_id=order_id if order_id else None,
            amount=Money(amount=amount, currency=currency),
            net_amount=Money(amount=net_amount, currency=currency),
            base_amount=base_amount,
            fx_rate=fx_rate,
            status=status,
            gateway=gateway,
            external_payment_id=payload.get("authorization"),
            paid_on=processed_at,
            fees=fees,
            metadata={
                "kind": kind,
                "gateway": gateway,
                "payment_details": payload.get("payment_details"),
            },
        )

        return NormalizationResult.success_result(
            canonical=canonical_payment,
            entity_type="order_transaction",
            external_id=external_id,
            raw_event_id=raw_event_id,
        )

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    def _normalize_address(
        self, address_data: Optional[Dict[str, Any]]
    ) -> Optional[Address]:
        """Normalize a Shopify address."""
        if not address_data:
            return None
        return Address(
            first_name=address_data.get("first_name"),
            last_name=address_data.get("last_name"),
            address_line_1=address_data.get("address1"),
            address_line_2=address_data.get("address2"),
            city=address_data.get("city"),
            state=address_data.get("province"),
            postal_code=address_data.get("zip"),
            country_code=address_data.get("country_code"),
            phone=address_data.get("phone"),
        )
