"""Persistence layer for canonical domain models.

Responsible for:
- Idempotent upserts to canonical tables
- Proper ordering of parent/child records
- Linking raw events to canonical records
- Managing processing state

The persistence layer MUST:
- Be idempotent (same input = same database state)
- Maintain referential integrity
- Update processing state on completion/failure
- Never modify raw event data
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from .models import (
    CanonicalCustomer,
    CanonicalInventoryItem,
    CanonicalLineItem,
    CanonicalOrder,
    CanonicalPayment,
    CanonicalPaymentFee,
    CanonicalProduct,
    ProcessingStatus,
)
from .normalizer import NormalizationResult
from .utils import extract_id as _extract_id
from .utils import extract_rows

logger = logging.getLogger(__name__)


class PersistenceError(Exception):
    """Raised when persistence operations fail."""

    def __init__(
        self,
        message: str,
        entity_type: str,
        external_id: str,
        raw_event_id: Optional[UUID] = None,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.entity_type = entity_type
        self.external_id = external_id
        self.raw_event_id = raw_event_id
        self.details = details or {}


class PersistenceService:
    """Service for persisting canonical models to the database.

    Implements the canonical write pattern:
    1. Lock identity (idempotency anchor)
    2. Upsert parent records first
    3. Handle child records with replace-all strategy
    4. Link raw event to canonical rows
    5. Mark processing state
    """

    def __init__(self):
        """Initialize the persistence service."""
        self._client = None

    @property
    def client(self):
        """Lazy load Supabase client."""
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    # =========================================================================
    # MAIN PERSISTENCE ENTRY POINT
    # =========================================================================

    async def persist(
        self, result: NormalizationResult
    ) -> Tuple[bool, Optional[UUID], Optional[str]]:
        """Persist a normalization result to the database.

        Routes to the appropriate persistence method based on entity type.

        Args:
            result: NormalizationResult from the normalizer

        Returns:
            Tuple of (success, canonical_id, error_message)
        """
        # Validate raw_event_id exists
        if result.raw_event_id is None:
            return (False, None, "raw_event_id is required for persistence")

        raw_event_id = result.raw_event_id

        if not result.success:
            # Mark raw event as failed
            await self._update_processing_state(
                raw_event_id,
                ProcessingStatus.FAILED,
                error_message=result.error_message,
                error_details=result.error_details,
            )
            return (False, None, result.error_message)

        if result.canonical is None:
            return (False, None, "No canonical model to persist")

        try:
            # Route to appropriate persistence method
            canonical = result.canonical

            # Handle lists of canonical objects (e.g., multiple payments from one transaction)
            if isinstance(canonical, list):
                canonical_ids = []
                for item in canonical:
                    if isinstance(item, CanonicalCustomer):
                        canonical_id = await self.persist_customer(item)
                    elif isinstance(item, CanonicalOrder):
                        canonical_id = await self.persist_order(item)
                    elif isinstance(item, CanonicalProduct):
                        canonical_id = await self.persist_product(item)
                    elif isinstance(item, CanonicalInventoryItem):
                        canonical_id = await self.persist_inventory_item(item)
                    elif isinstance(item, CanonicalPayment):
                        canonical_id = await self.persist_payment(item)
                    else:
                        raise PersistenceError(
                            f"Unknown canonical model type in list: {type(item).__name__}",
                            entity_type=result.entity_type,
                            external_id=result.external_id,
                            raw_event_id=raw_event_id,
                        )
                    canonical_ids.append(canonical_id)

                # Return the first ID for tracking (all are linked to same raw_event_id)
                canonical_id = canonical_ids[0] if canonical_ids else None
            elif isinstance(canonical, CanonicalCustomer):
                canonical_id = await self.persist_customer(canonical)
            elif isinstance(canonical, CanonicalOrder):
                canonical_id = await self.persist_order(canonical)
            elif isinstance(canonical, CanonicalProduct):
                canonical_id = await self.persist_product(canonical)
            elif isinstance(canonical, CanonicalInventoryItem):
                canonical_id = await self.persist_inventory_item(canonical)
            elif isinstance(canonical, CanonicalPayment):
                canonical_id = await self.persist_payment(canonical)
            else:
                raise PersistenceError(
                    f"Unknown canonical model type: {type(canonical).__name__}",
                    entity_type=result.entity_type,
                    external_id=result.external_id,
                    raw_event_id=raw_event_id,
                )

            # Update processing state
            status = (
                ProcessingStatus.NEEDS_REVIEW
                if result.needs_review
                else ProcessingStatus.COMPLETED
            )
            await self._update_processing_state(
                raw_event_id, status, canonical_id=canonical_id
            )

            # Log to processing log
            await self._log_processing(
                raw_event_id=raw_event_id,
                entity_type=result.entity_type,
                external_id=result.external_id,
                status=status,
                canonical_id=canonical_id,
                canonical_table=self._get_table_name(result.entity_type),
                needs_review=result.needs_review,
                review_reason=result.review_reason,
            )

            return (True, canonical_id, None)

        except PersistenceError as e:
            logger.error(f"Persistence error: {e}")
            await self._update_processing_state(
                raw_event_id,
                ProcessingStatus.FAILED,
                error_message=str(e),
                error_details=e.details,
            )
            return (False, None, str(e))

        except Exception as e:
            logger.exception(
                f"Unexpected persistence error for {result.entity_type}/{result.external_id}"
            )
            await self._update_processing_state(
                result.raw_event_id,
                ProcessingStatus.FAILED,
                error_message=f"Unexpected error: {str(e)}",
                error_details={"exception_type": type(e).__name__},
            )
            return (False, None, str(e))

    # =========================================================================
    # CUSTOMER PERSISTENCE
    # =========================================================================

    async def persist_customer(self, customer: CanonicalCustomer) -> UUID:
        """Persist a canonical customer.

        Uses upsert on natural key (provider, external_id, entity_id).
        """
        data = {
            "entity_id": str(customer.entity_id),
            "provider": customer.provider,
            "external_id": customer.external_id,
            "raw_event_id": str(customer.raw_event_id),
            "email": customer.email,
            "first_name": customer.first_name,
            "last_name": customer.last_name,
            "phone": customer.phone,
            "default_address": (
                customer.default_address.model_dump()
                if customer.default_address
                else None
            ),
            "metadata": customer.metadata,
            "created_at": (
                customer.created_at.isoformat() if customer.created_at else None
            ),
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("customers")
            .upsert(data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert customer",
                entity_type="profile",
                external_id=customer.external_id,
                raw_event_id=customer.raw_event_id,
            )

        return _extract_id(result)

    # =========================================================================
    # ORDER PERSISTENCE
    # =========================================================================

    async def persist_order(self, order: CanonicalOrder) -> UUID:
        """Persist a canonical order with line items.

        Process:
        1. Upsert customer if customer_external_id exists
        2. Upsert order
        3. Replace-all line items
        """
        customer_id = None

        # Step 1: Link to customer if exists
        if order.customer_external_id:
            customer_id = await self._get_customer_id(
                order.entity_id, order.provider, order.customer_external_id
            )

        # Step 2: Upsert order
        order_data = {
            "entity_id": str(order.entity_id),
            "customer_id": str(customer_id) if customer_id else None,
            "provider": order.provider,
            "external_id": order.external_id,
            "raw_event_id": str(order.raw_event_id),
            "order_number": order.order_number,
            "status": order.status.value,
            "fulfillment_status": order.fulfillment_status.value,
            "currency": order.currency,
            "customer_external_id": order.customer_external_id,
            "customer_email": order.customer_email,
            # Totals
            "subtotal_amount": float(order.subtotal.amount),
            "discount_total_amount": float(order.discount_total.amount),
            "shipping_total_amount": float(order.shipping_total.amount),
            "tax_total_amount": float(order.tax_total.amount),
            "grand_total_amount": float(order.grand_total.amount),
            "refunded_total_amount": (
                float(order.refunded_total.amount) if order.refunded_total else 0
            ),
            # Addresses
            "shipping_address": (
                order.shipping_address.model_dump() if order.shipping_address else None
            ),
            "billing_address": (
                order.billing_address.model_dump() if order.billing_address else None
            ),
            # Provider-specific
            "metadata": order.metadata,
            # Timestamps (source system dates)
            "created_at": (order.created_at.isoformat() if order.created_at else None),
            "updated_at": (order.updated_at.isoformat() if order.updated_at else None),
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("orders")
            .upsert(order_data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert order",
                entity_type="order",
                external_id=order.external_id,
                raw_event_id=order.raw_event_id,
            )

        order_id = _extract_id(result)

        # Step 3: Replace-all line items
        await self._replace_line_items(
            order_id,
            order.line_items,
            order.raw_event_id,
            entity_id=order.entity_id,
            provider=order.provider,
            order_created_at=order.created_at,
        )

        return order_id

    async def _replace_line_items(
        self,
        order_id: UUID,
        line_items: List[CanonicalLineItem],
        raw_event_id: UUID,
        entity_id: UUID,
        provider: str,
        order_created_at: Optional[datetime] = None,
    ) -> None:
        """Replace all line items for an order.

        This is the recommended approach for idempotent child record handling.
        Resolves product_id from products table via product_external_id.
        Line items inherit created_at from the parent order.
        """
        # Delete existing line items
        await asyncio.to_thread(
            lambda: self.client.table("order_line_items")
            .delete()
            .eq("order_id", str(order_id))
            .execute()
        )

        # Insert new line items
        if not line_items:
            return

        # Batch-resolve product_ids for all line items with product_external_id
        product_id_map = await self._resolve_product_ids(
            entity_id, provider, line_items
        )

        created_at_iso = order_created_at.isoformat() if order_created_at else None

        items_data = [
            {
                "order_id": str(order_id),
                "raw_event_id": str(raw_event_id),
                "external_id": item.external_id,
                "product_id": (
                    str(product_id_map[item.product_external_id])
                    if item.product_external_id
                    and item.product_external_id in product_id_map
                    else None
                ),
                "product_external_id": item.product_external_id,
                "variant_external_id": item.variant_external_id,
                "sku": item.sku,
                "product_name": item.product_name,
                "variant_name": item.variant_name,
                "quantity": item.quantity,
                "unit_price_amount": float(item.unit_price.amount),
                "total_price_amount": float(item.total_price.amount),
                "discount_amount": (
                    float(item.discount_amount.amount) if item.discount_amount else None
                ),
                "tax_amount": (
                    float(item.tax_amount.amount) if item.tax_amount else None
                ),
                "created_at": created_at_iso,
                "metadata": item.metadata,
            }
            for item in line_items
        ]

        await asyncio.to_thread(
            lambda: self.client.table("order_line_items").insert(items_data).execute()
        )

    async def _resolve_product_ids(
        self,
        entity_id: UUID,
        provider: str,
        line_items: List[CanonicalLineItem],
    ) -> Dict[str, UUID]:
        """Batch-resolve product UUIDs from product_external_ids.

        Returns a mapping of product_external_id -> product UUID.
        """
        # Collect unique non-null product_external_ids
        ext_ids = list(
            {
                item.product_external_id
                for item in line_items
                if item.product_external_id
            }
        )

        if not ext_ids:
            return {}

        result = await asyncio.to_thread(
            lambda: self.client.table("products")
            .select("id, external_id")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .in_("external_id", ext_ids)
            .execute()
        )

        return {row["external_id"]: UUID(row["id"]) for row in (result.data or [])}

    async def _get_customer_id(
        self, entity_id: UUID, provider: str, customer_external_id: str
    ) -> Optional[UUID]:
        """Get customer ID by natural key."""
        result = await asyncio.to_thread(
            lambda: self.client.table("customers")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .eq("external_id", customer_external_id)
            .execute()
        )

        if result.data:
            return _extract_id(result)
        return None

    # =========================================================================
    # PRODUCT PERSISTENCE
    # =========================================================================

    async def persist_product(self, product: CanonicalProduct) -> UUID:
        """Persist a canonical product with variants."""

        logger.info(
            f"Persisting product {product.external_id} with {len(product.variants)} variants"
        )
        data = {
            "entity_id": str(product.entity_id),
            "provider": product.provider,
            "external_id": product.external_id,
            "raw_event_id": str(product.raw_event_id),
            "name": product.name,
            "description": product.description,
            "product_type": product.product_type,
            "status": product.status,
            "variants": [
                {
                    **v.model_dump(mode="json"),
                    "price": v.price.model_dump(mode="json") if v.price else None,
                    "compare_at_price": (
                        v.compare_at_price.model_dump(mode="json")
                        if v.compare_at_price
                        else None
                    ),
                }
                for v in product.variants
            ],
            "tags": product.tags,
            "metadata": product.metadata,
            "created_at": (
                product.created_at.isoformat() if product.created_at else None
            ),
            "updated_at": (
                product.updated_at.isoformat() if product.updated_at else None
            ),
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("products")
            .upsert(data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert product",
                entity_type="product",
                external_id=product.external_id,
                raw_event_id=product.raw_event_id,
            )

        return _extract_id(result)

    # =========================================================================
    # INVENTORY PERSISTENCE
    # =========================================================================

    async def persist_inventory_item(self, item: CanonicalInventoryItem) -> UUID:
        """Persist a canonical inventory item."""
        # Try to find linked product
        product_id = await self._get_product_id_by_variant(
            item.entity_id, item.provider, item.variant_external_id
        )

        data = {
            "entity_id": str(item.entity_id),
            "product_id": str(product_id) if product_id else None,
            "provider": item.provider,
            "external_id": item.external_id,
            "raw_event_id": str(item.raw_event_id),
            "product_external_id": item.product_external_id,
            "variant_external_id": item.variant_external_id,
            "sku": item.sku,
            "quantity": item.quantity,
            "is_unlimited": item.is_unlimited,
            "metadata": item.metadata,
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_items")
            .upsert(data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert inventory item",
                entity_type="inventory_item",
                external_id=item.external_id,
                raw_event_id=item.raw_event_id,
            )

        return _extract_id(result)

    async def _get_product_id_by_variant(
        self, entity_id: UUID, provider: str, variant_external_id: str
    ) -> Optional[UUID]:
        """Get product ID that contains a specific variant."""
        # This searches the variants JSONB array
        result = await asyncio.to_thread(
            lambda: self.client.table("products")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .contains("variants", json.dumps([{"external_id": variant_external_id}]))
            .execute()
        )

        if result.data:
            return _extract_id(result)
        return None

    # =========================================================================
    # PAYMENT PERSISTENCE
    # =========================================================================

    async def persist_payment(self, payment: CanonicalPayment) -> UUID:
        """Persist a canonical payment with processing fees.

        Process:
        1. Resolve order FK if order_external_id exists
        2. Upsert payment with dedicated columns
        3. Replace-all processing fees for this payment
        """
        # Step 1: Link to order if exists
        order_id = None
        if payment.order_external_id:
            order_id = await self._get_order_id(
                payment.entity_id, payment.provider, payment.order_external_id
            )

        # Step 2: Upsert payment
        data = {
            "entity_id": str(payment.entity_id),
            "order_id": str(order_id) if order_id else None,
            "provider": payment.provider,
            "external_id": payment.external_id,
            "raw_event_id": str(payment.raw_event_id),
            "order_external_id": payment.order_external_id,
            # Dedicated financial columns
            "amount": float(payment.amount.amount),
            "refunded_amount": (
                float(payment.refunded_amount.amount) if payment.refunded_amount else 0
            ),
            "net_amount": (
                float(payment.net_amount.amount)
                if payment.net_amount
                else float(payment.amount.amount)
            ),
            "currency": payment.amount.currency,
            "status": payment.status.value,
            # Gateway info
            "gateway": payment.gateway,
            "external_payment_id": payment.external_payment_id,
            # Payment method
            "payment_method": payment.payment_method,
            "transaction_id": payment.transaction_id,
            # Timing
            "paid_on": (payment.paid_on.isoformat() if payment.paid_on else None),
            "created_at": (
                payment.created_at.isoformat() if payment.created_at else None
            ),
            # Only supplementary data in metadata
            "metadata": payment.metadata,
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("payments")
            .upsert(data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert payment",
                entity_type="payment",
                external_id=payment.external_id,
                raw_event_id=payment.raw_event_id,
            )

        payment_id = _extract_id(result)

        # Step 3: Persist processing fees
        if payment.fees:
            await self._replace_payment_fees(payment_id, payment.fees)

        return payment_id

    async def _replace_payment_fees(
        self,
        payment_id: UUID,
        fees: List[CanonicalPaymentFee],
    ) -> None:
        """Replace all processing fees for a payment.

        Uses delete-then-insert for idempotent child record handling.
        """
        # Delete existing fees
        await asyncio.to_thread(
            lambda: self.client.table("payment_fees")
            .delete()
            .eq("payment_id", str(payment_id))
            .execute()
        )

        if not fees:
            return

        fees_data = [
            {
                "payment_id": str(payment_id),
                "external_fee_id": fee.external_fee_id,
                "gross_fee": float(fee.gross_fee.amount),
                "refunded_fee": float(fee.refunded_fee.amount),
                "net_fee": float(fee.net_fee.amount),
                "currency": fee.gross_fee.currency,
                "metadata": fee.metadata,
            }
            for fee in fees
        ]

        await asyncio.to_thread(
            lambda: self.client.table("payment_fees").insert(fees_data).execute()
        )

    async def _get_order_id(
        self, entity_id: UUID, provider: str, order_external_id: str
    ) -> Optional[UUID]:
        """Get order ID by natural key."""
        result = await asyncio.to_thread(
            lambda: self.client.table("orders")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .eq("external_id", order_external_id)
            .execute()
        )

        if result.data:
            return _extract_id(result)
        return None

    # =========================================================================
    # PROCESSING STATE MANAGEMENT
    # =========================================================================

    async def _update_processing_state(
        self,
        raw_event_id: UUID,
        status: ProcessingStatus,
        canonical_id: Optional[UUID] = None,
        error_message: Optional[str] = None,
        error_details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Update processing state on the raw event."""
        data: Dict[str, Any] = {
            "processing_status": status.value,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }

        if error_message:
            data["processing_error"] = error_message
        if error_details:
            data["processing_error_details"] = error_details

        await asyncio.to_thread(
            lambda: self.client.table("external_raw_events")
            .update(data)
            .eq("id", str(raw_event_id))
            .execute()
        )

    async def _log_processing(
        self,
        raw_event_id: UUID,
        entity_type: str,
        external_id: str,
        status: ProcessingStatus,
        canonical_id: Optional[UUID] = None,
        canonical_table: Optional[str] = None,
        error_message: Optional[str] = None,
        error_details: Optional[Dict[str, Any]] = None,
        needs_review: bool = False,
        review_reason: Optional[str] = None,
    ) -> None:
        """Log the processing result."""
        data = {
            "raw_event_id": str(raw_event_id),
            "entity_type": entity_type,
            "external_id": external_id,
            "status": status.value,
            "canonical_id": str(canonical_id) if canonical_id else None,
            "canonical_table": canonical_table,
            "error_message": error_message,
            "error_details": error_details,
            "needs_review": needs_review,
            "review_reason": review_reason,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }

        await asyncio.to_thread(
            lambda: self.client.table("normalization_processing_log")
            .insert(data)
            .execute()
        )

    def _get_table_name(self, entity_type: str) -> str:
        """Map entity type to table name."""
        mapping = {
            "order": "orders",
            "profile": "customers",
            "product": "products",
            "inventory_item": "inventory_items",
            "payment": "payments",
            "transaction": "payments",
        }
        return mapping.get(entity_type, entity_type)

    # =========================================================================
    # BATCH OPERATIONS
    # =========================================================================

    async def get_pending_events(
        self, limit: int = 100, entity_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get pending raw events for processing."""

        def _query():
            query = (
                self.client.table("external_raw_events")
                .select("*")
                .eq("processing_status", "pending")
            )

            if entity_type:
                query = query.eq("entity_type", entity_type)

            return query.order("fetched_at").limit(limit).execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def mark_processing(self, raw_event_id: UUID) -> None:
        """Mark a raw event as currently processing."""
        await self._update_processing_state(raw_event_id, ProcessingStatus.PROCESSING)


# Global service instance
persistence_service = PersistenceService()
