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
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple, cast
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from .models import (
    CanonicalBankAccount,
    CanonicalCustomer,
    CanonicalFinancialTransaction,
    CanonicalInventoryItem,
    CanonicalInventoryMovement,
    CanonicalLineItem,
    CanonicalOrder,
    CanonicalProduct,
    CanonicalPayment,
    CanonicalPaymentFee,
    ExpenseEnrichment,
    FulfillmentStatus,
    InventoryMovementType,
    ProcessingStatus,
)
from .normalizer import NormalizationResult
from .utils import extract_id as _extract_id, extract_rows

logger = logging.getLogger(__name__)


class PersistenceError(Exception):
    """Raised when persistence operations fail."""
    
    def __init__(
        self,
        message: str,
        entity_type: str,
        external_id: str,
        raw_event_id: Optional[UUID] = None,
        details: Optional[Dict[str, Any]] = None
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
        self,
        result: NormalizationResult
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
                error_details=result.error_details
            )
            return (False, None, result.error_message)
        
        # Handle intentionally-skipped events (e.g., "General Expenses" category)
        if result.skipped:
            await self._update_processing_state(
                raw_event_id,
                ProcessingStatus.COMPLETED,
                error_message=None,
                error_details=None
            )
            return (True, None, f"skipped: {result.skip_reason}")
        
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
                    elif isinstance(item, CanonicalBankAccount):
                        canonical_id = await self.persist_bank_account(item)
                    elif isinstance(item, CanonicalFinancialTransaction):
                        canonical_id = await self.persist_financial_transaction(item)
                    elif isinstance(item, ExpenseEnrichment):
                        canonical_id = await self.enrich_financial_transaction(
                            source=item.source,
                            external_transaction_id=item.external_transaction_id,
                            entity_id=item.entity_id,
                            expense_category=item.expense_category,
                            account_code=item.account_code,
                        )
                    else:
                        raise PersistenceError(
                            f"Unknown canonical model type in list: {type(item).__name__}",
                            entity_type=result.entity_type,
                            external_id=result.external_id,
                            raw_event_id=raw_event_id
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
            elif isinstance(canonical, CanonicalBankAccount):
                canonical_id = await self.persist_bank_account(canonical)
            elif isinstance(canonical, CanonicalFinancialTransaction):
                canonical_id = await self.persist_financial_transaction(canonical)
            elif isinstance(canonical, ExpenseEnrichment):
                canonical_id = await self.enrich_financial_transaction(
                    source=canonical.source,
                    external_transaction_id=canonical.external_transaction_id,
                    entity_id=canonical.entity_id,
                    expense_category=canonical.expense_category,
                    account_code=canonical.account_code,
                )
            else:
                raise PersistenceError(
                    f"Unknown canonical model type: {type(canonical).__name__}",
                    entity_type=result.entity_type,
                    external_id=result.external_id,
                    raw_event_id=raw_event_id
                )
            
            # Update processing state
            status = ProcessingStatus.NEEDS_REVIEW if result.needs_review else ProcessingStatus.COMPLETED
            await self._update_processing_state(
                raw_event_id,
                status,
                canonical_id=canonical_id
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
                review_reason=result.review_reason
            )
            
            return (True, canonical_id, None)
            
        except PersistenceError as e:
            logger.error(f"Persistence error: {e}")
            await self._update_processing_state(
                raw_event_id,
                ProcessingStatus.FAILED,
                error_message=str(e),
                error_details=e.details
            )
            return (False, None, str(e))
            
        except Exception as e:
            logger.exception(f"Unexpected persistence error for {result.entity_type}/{result.external_id}")
            await self._update_processing_state(
                result.raw_event_id,
                ProcessingStatus.FAILED,
                error_message=f"Unexpected error: {str(e)}",
                error_details={"exception_type": type(e).__name__}
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
                if customer.default_address else None
            ),
            "metadata": customer.metadata,
            "created_at": (
                customer.created_at.isoformat() 
                if customer.created_at else None
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
                raw_event_id=customer.raw_event_id
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
                order.entity_id,
                order.provider,
                order.customer_external_id
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
                float(order.refunded_total.amount) 
                if order.refunded_total else 0
            ),
            # Addresses
            "shipping_address": (
                order.shipping_address.model_dump() 
                if order.shipping_address else None
            ),
            "billing_address": (
                order.billing_address.model_dump() 
                if order.billing_address else None
            ),
            # Provider-specific
            "metadata": order.metadata,
            # Timestamps (source system dates)
            "created_at": (
                order.created_at.isoformat() 
                if order.created_at else None
            ),
            "updated_at": (
                order.updated_at.isoformat() 
                if order.updated_at else None
            ),
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
                raw_event_id=order.raw_event_id
            )
        
        order_id = _extract_id(result)
        
        # Step 3: Replace-all line items
        await self._replace_line_items(
            order_id, order.line_items, order.raw_event_id,
            entity_id=order.entity_id, provider=order.provider,
            order_created_at=order.created_at,
        )
        
        # Step 4: Record inventory movements if order is fulfilled
        if order.fulfillment_status == FulfillmentStatus.FULFILLED:
            try:
                await self.record_sale_movements_for_order(
                    order_id=order_id,
                    entity_id=order.entity_id,
                    provider=order.provider,
                    line_items=order.line_items,
                )
            except Exception as e:
                logger.warning(
                    "Failed to record SALE inventory movements for order %s: %s",
                    order_id, e,
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
                    float(item.discount_amount.amount) 
                    if item.discount_amount else None
                ),
                "tax_amount": (
                    float(item.tax_amount.amount) 
                    if item.tax_amount else None
                ),
                "created_at": created_at_iso,
                "metadata": item.metadata,
            }
            for item in line_items
        ]
        
        await asyncio.to_thread(
            lambda: self.client.table("order_line_items")
            .insert(items_data)
            .execute()
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
        ext_ids = list({
            item.product_external_id
            for item in line_items
            if item.product_external_id
        })
        
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
        
        return {
            row["external_id"]: UUID(row["id"])
            for row in (result.data or [])
        }
    
    async def _get_customer_id(
        self,
        entity_id: UUID,
        provider: str,
        customer_external_id: str
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

    async def _reconcile_invoice_product(
        self, product: CanonicalProduct
    ) -> Optional[UUID]:
        """Try to find an existing invoice-created product that matches this incoming product.

        Matching strategy (in priority order):
        1. SKU match: if any variant has a SKU, look for an invoice product with a
           matching SKU in its variants JSONB.
        2. Name match: fuzzy match on product name against invoice-created products
           for the same entity.

        Returns the UUID of the matched invoice product, or None if no match found.
        """
        if product.provider == "invoice":
            # Don't reconcile invoice products against themselves
            return None

        entity_id = str(product.entity_id)

        # Strategy 1: SKU-based matching
        for variant in product.variants:
            if variant.sku:
                try:
                    result = await asyncio.to_thread(
                        lambda sku=variant.sku: self.client.table("products")
                        .select("id")
                        .eq("entity_id", entity_id)
                        .eq("provider", "invoice")
                        .contains("variants", [{"sku": sku}])
                        .limit(1)
                        .execute()
                    )
                    if result.data:
                        logger.info(
                            f"Reconciled product by SKU '{variant.sku}' → "
                            f"invoice product {result.data[0]['id']}"
                        )
                        return UUID(result.data[0]["id"])
                except Exception as exc:
                    logger.debug(f"SKU reconciliation query failed: {exc}")

        # Strategy 2: Name-based matching (case-insensitive, trimmed)
        # Use ilike for fuzzy matching - the invoice product name is derived from
        # the line item description which often matches the real product name
        clean_name = product.name.strip()
        if clean_name:
            try:
                result = await asyncio.to_thread(
                    lambda: self.client.table("products")
                    .select("id, name")
                    .eq("entity_id", entity_id)
                    .eq("provider", "invoice")
                    .ilike("name", f"%{clean_name}%")
                    .limit(1)
                    .execute()
                )
                if result.data:
                    logger.info(
                        f"Reconciled product by name '{clean_name}' → "
                        f"invoice product {result.data[0]['id']} "
                        f"('{result.data[0]['name']}')"
                    )
                    return UUID(result.data[0]["id"])
            except Exception as exc:
                logger.debug(f"Name reconciliation query failed: {exc}")

        return None

    async def persist_product(self, product: CanonicalProduct) -> UUID:
        """Persist a canonical product with variants.

        Includes enrichment/reconciliation: if a bare-bones product was
        previously created from an invoice (provider='invoice'), and this
        incoming product from an e-commerce provider matches by name, the
        existing record is updated (enriched) with the richer data and
        re-assigned to the new provider. This prevents duplicates when
        invoice-created products are later synced from Squarespace etc.
        """

        logger.info(
            f"Persisting product {product.external_id} with "
            f"{len(product.variants)} variants"
        )

        # --- Enrichment: reconcile with invoice-created products ---
        enriched_existing = await self._reconcile_invoice_product(product)

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
                    **v.model_dump(mode='json'),
                    "price": v.price.model_dump(mode='json') if v.price else None,
                    "compare_at_price": (
                        v.compare_at_price.model_dump(mode='json') 
                        if v.compare_at_price else None
                    ),
                }
                for v in product.variants
            ],
            "tags": product.tags,
            "metadata": product.metadata,
            "created_at": (
                product.created_at.isoformat() 
                if product.created_at else None
            ),
            "updated_at": (
                product.updated_at.isoformat() 
                if product.updated_at else None
            ),
        }

        if enriched_existing:
            # Update the existing invoice-created product in-place,
            # promoting it to the real provider
            result = await asyncio.to_thread(
                lambda: self.client.table("products")
                .update(data)
                .eq("id", str(enriched_existing))
                .execute()
            )
            if result.data:
                logger.info(
                    f"Enriched invoice product {enriched_existing} → "
                    f"provider={product.provider}, external_id={product.external_id}"
                )
                return enriched_existing
        
        # Standard upsert for new or already-provider-linked products
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
                raw_event_id=product.raw_event_id
            )
        
        return _extract_id(result)
    
    # =========================================================================
    # INVENTORY PERSISTENCE
    # =========================================================================
    
    async def persist_inventory_item(
        self,
        item: CanonicalInventoryItem
    ) -> UUID:
        """Persist a canonical inventory item."""
        # Try to find linked product (also retrieves its created_at)
        product_id, product_created_at = await self._get_product_id_by_variant(
            item.entity_id,
            item.provider,
            item.variant_external_id
        )
        
        data = {
            "entity_id": str(item.entity_id),
            "product_id": str(product_id) if product_id else None,
            "provider": item.provider,
            "raw_event_id": str(item.raw_event_id),
            "variant_external_id": item.variant_external_id,
            "sku": item.sku,
            "is_unlimited": item.is_unlimited,
            "description": item.description,
            "category": item.category,
            "unit_cost": float(item.unit_cost) if item.unit_cost else 0,
            "asset_account_id": str(item.asset_account_id) if item.asset_account_id else None,
            "cogs_account_id": str(item.cogs_account_id) if item.cogs_account_id else None,
            # Inherit created_at from linked product so it reflects source system date
            "created_at": (
                product_created_at.isoformat()
                if product_created_at else None
            ),
        }
        
        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_items")
            .upsert(data, on_conflict="provider,variant_external_id,entity_id")
            .execute()
        )
        
        if not result.data:
            raise PersistenceError(
                "Failed to upsert inventory item",
                entity_type="inventory_item",
                external_id=item.external_id,
                raw_event_id=item.raw_event_id
            )
        
        return _extract_id(result)
    
    async def _get_product_id_by_variant(
        self,
        entity_id: UUID,
        provider: str,
        variant_external_id: str
    ) -> Tuple[Optional[UUID], Optional[datetime]]:
        """Get product ID and created_at for the product containing a specific variant."""
        # This searches the variants JSONB array
        result = await asyncio.to_thread(
            lambda: self.client.table("products")
            .select("id, created_at")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .contains("variants", json.dumps([{"external_id": variant_external_id}]))
            .execute()
        )
        
        if result.data:
            row = result.data[0]
            product_id = UUID(row["id"])
            raw_ts = row.get("created_at")
            product_created_at = (
                datetime.fromisoformat(raw_ts) if raw_ts else None
            )
            return product_id, product_created_at
        return None, None
    
    # =========================================================================
    # INVENTORY MOVEMENT PERSISTENCE
    # =========================================================================

    async def record_inventory_movement(
        self,
        movement: CanonicalInventoryMovement,
    ) -> UUID:
        """Record a single inventory movement in the ledger.

        Resolves inventory_item_id from (entity_id, provider, variant_external_id)
        if not already set on the movement.

        Returns the UUID of the created movement row.
        """
        inventory_item_id = movement.inventory_item_id

        if not inventory_item_id:
            inventory_item_id = await self._get_inventory_item_id(
                movement.entity_id,
                movement.provider,
                movement.variant_external_id,
            )

        if not inventory_item_id:
            logger.warning(
                "No inventory_item found for variant %s — skipping movement",
                movement.variant_external_id,
            )
            return None  # type: ignore[return-value]

        data = {
            "inventory_item_id": str(inventory_item_id),
            "transaction_type": movement.transaction_type.value,
            "reference_id": str(movement.reference_id) if movement.reference_id else None,
            "reference_table": movement.reference_table,
            "quantity": float(movement.quantity),
            "unit_cost": float(movement.unit_cost),
            "notes": movement.notes,
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_movements")
            .insert(data)
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to insert inventory movement",
                entity_type="inventory_movement",
                external_id=movement.variant_external_id,
            )

        return _extract_id(result)

    async def record_sale_movements_for_order(
        self,
        order_id: UUID,
        entity_id: UUID,
        provider: str,
        line_items: List[CanonicalLineItem],
    ) -> List[UUID]:
        """Record SALE inventory movements for a fulfilled order's line items.

        Creates one negative movement per line item that has a matching
        inventory_item (resolved via variant_external_id).

        Idempotent: skips if movements already exist for a given
        (order_line_item.id, 'SALE') pair.

        Args:
            order_id: The DB order UUID (used to look up persisted line items)
            entity_id: Entity UUID for scoping
            provider: Provider name
            line_items: Canonical line items from the order

        Returns:
            List of created movement UUIDs
        """
        # Fetch the persisted order_line_items to get their DB ids
        persisted_items = await asyncio.to_thread(
            lambda: self.client.table("order_line_items")
            .select("id, variant_external_id, quantity, unit_price_amount")
            .eq("order_id", str(order_id))
            .execute()
        )

        if not persisted_items.data:
            return []

        movement_ids: List[UUID] = []

        for row in persisted_items.data:
            variant_ext_id = row.get("variant_external_id")
            if not variant_ext_id:
                continue

            line_item_id = UUID(row["id"])

            # Idempotency: check if a SALE movement already exists for this line item
            existing = await asyncio.to_thread(
                lambda lid=str(line_item_id): self.client.table("inventory_movements")
                .select("id")
                .eq("reference_id", lid)
                .eq("transaction_type", "SALE")
                .limit(1)
                .execute()
            )
            if existing.data:
                continue

            inventory_item_id = await self._get_inventory_item_id(
                entity_id, provider, variant_ext_id
            )
            if not inventory_item_id:
                continue

            # Fetch unit_cost from inventory_item for COGS
            inv_item = await asyncio.to_thread(
                lambda iid=str(inventory_item_id): self.client.table("inventory_items")
                .select("unit_cost")
                .eq("id", iid)
                .limit(1)
                .execute()
            )
            unit_cost = float((inv_item.data[0] if inv_item.data else {}).get("unit_cost", 0))

            qty = row.get("quantity", 1)
            data = {
                "inventory_item_id": str(inventory_item_id),
                "transaction_type": "SALE",
                "reference_id": str(line_item_id),
                "reference_table": "order_line_items",
                "quantity": -abs(qty),  # Stock OUT → negative
                "unit_cost": unit_cost,
                "notes": f"Order fulfilled (order_id={order_id})",
            }

            result = await asyncio.to_thread(
                lambda d=data: self.client.table("inventory_movements")
                .insert(d)
                .execute()
            )
            if result.data:
                movement_ids.append(_extract_id(result))

        return movement_ids

    async def record_purchase_movement_for_invoice_line(
        self,
        invoice_line_item_id: UUID,
        entity_id: UUID,
        sku: Optional[str],
        description: str,
        quantity: float,
        unit_cost: float,
        category: Optional[str] = None,
    ) -> Optional[UUID]:
        """Record a PURCHASE inventory movement from an invoice line item.

        Tries to match the invoice line item to an inventory_item by SKU.
        If no match, the movement is skipped (item may not be tracked).

        Idempotent: skips if a PURCHASE movement already exists for this line item.

        Returns the movement UUID or None if skipped.
        """
        import re as _re

        # Derive a stable, URL-safe slug from description when no explicit SKU
        if not sku:
            slug = _re.sub(r"[^a-z0-9]+", "-", description[:100].lower()).strip("-")[:80]
            sku = slug or f"item-{str(invoice_line_item_id)[:8]}"

        # Idempotency check
        existing = await asyncio.to_thread(
            lambda: self.client.table("inventory_movements")
            .select("id")
            .eq("reference_id", str(invoice_line_item_id))
            .eq("transaction_type", "PURCHASE")
            .limit(1)
            .execute()
        )
        if existing.data:
            return UUID(existing.data[0]["id"])

        # Resolve inventory_item by SKU + entity_id; create one if it doesn't exist yet
        inv_result = await asyncio.to_thread(
            lambda: self.client.table("inventory_items")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("sku", sku)
            .limit(1)
            .execute()
        )
        if not inv_result.data:
            logger.info(
                "No inventory_item found for SKU %s — creating one from invoice line", sku
            )
            upsert_data = {
                "entity_id": str(entity_id),
                "provider": "manual",
                "variant_external_id": sku,
                "sku": sku,
                "description": description[:255],
                "unit_cost": unit_cost,
                "category": category,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            upsert_result = await asyncio.to_thread(
                lambda d=upsert_data: self.client.table("inventory_items")
                .upsert(d, on_conflict="entity_id,provider,variant_external_id")
                .execute()
            )
            if not upsert_result.data:
                logger.warning("Failed to upsert inventory_item for SKU %s — skipping movement", sku)
                return None
            inventory_item_id = upsert_result.data[0]["id"]
        else:
            inventory_item_id = inv_result.data[0]["id"]

        data = {
            "inventory_item_id": inventory_item_id,
            "transaction_type": "PURCHASE",
            "reference_id": str(invoice_line_item_id),
            "reference_table": "invoice_line_items",
            "quantity": abs(quantity),  # Stock IN → positive
            "unit_cost": unit_cost,
            "notes": f"Purchase invoice line: {description[:120]}",
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_movements")
            .insert(data)
            .execute()
        )
        if not result.data:
            return None

        return _extract_id(result)

    async def get_stock_level(
        self,
        inventory_item_id: UUID,
    ) -> Decimal:
        """Get current stock level for an inventory item by summing movements."""
        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_stock_levels")
            .select("current_quantity")
            .eq("inventory_item_id", str(inventory_item_id))
            .limit(1)
            .execute()
        )
        if result.data:
            return Decimal(str(result.data[0]["current_quantity"]))
        return Decimal("0")

    async def _get_inventory_item_id(
        self,
        entity_id: UUID,
        provider: str,
        variant_external_id: str,
    ) -> Optional[UUID]:
        """Get inventory_item UUID by natural key."""
        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_items")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("provider", provider)
            .eq("variant_external_id", variant_external_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return UUID(result.data[0]["id"])
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
                payment.entity_id,
                payment.provider,
                payment.order_external_id
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
                float(payment.refunded_amount.amount)
                if payment.refunded_amount else 0
            ),
            "net_amount": (
                float(payment.net_amount.amount)
                if payment.net_amount else float(payment.amount.amount)
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
            "paid_on": (
                payment.paid_on.isoformat()
                if payment.paid_on else None
            ),
            "created_at": (
                payment.created_at.isoformat()
                if payment.created_at else None
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
                raw_event_id=payment.raw_event_id
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
            lambda: self.client.table("payment_fees")
            .insert(fees_data)
            .execute()
        )
    
    async def _get_order_id(
        self,
        entity_id: UUID,
        provider: str,
        order_external_id: str
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
    # BANK ACCOUNT PERSISTENCE
    # =========================================================================

    async def persist_bank_account(self, account: CanonicalBankAccount) -> UUID:
        """Persist a canonical bank account.

        Uses upsert on natural key (source, external_account_id, entity_id).
        """
        data = {
            "entity_id": str(account.entity_id),
            "source": account.source,
            "external_account_id": account.external_account_id,
            "name": account.name,
            "currency": account.currency,
            "balance": float(account.balance),
            "state": account.state,
            "raw_event_id": str(account.raw_event_id),
            "metadata": account.metadata,
            "created_at": (
                account.created_at.isoformat()
                if account.created_at else None
            ),
            "updated_at": (
                account.updated_at.isoformat()
                if account.updated_at else None
            ),
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("bank_accounts")
            .upsert(data, on_conflict="source,external_account_id,entity_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert bank account",
                entity_type="bank_account",
                external_id=account.external_account_id,
                raw_event_id=account.raw_event_id,
            )

        return _extract_id(result)

    # =========================================================================
    # FINANCIAL TRANSACTION PERSISTENCE
    # =========================================================================

    async def persist_financial_transaction(
        self, txn: CanonicalFinancialTransaction
    ) -> UUID:
        """Persist a canonical financial transaction.

        Uses upsert on natural key (source, external_transaction_id).
        Optionally resolves bank_account_id from metadata.revolut_account_id.
        """
        # Try to resolve bank_account_id from metadata
        bank_account_id = None
        if txn.bank_account_id:
            bank_account_id = str(txn.bank_account_id)
        else:
            revolut_account_id = (txn.metadata or {}).get("revolut_account_id")
            if revolut_account_id:
                resolved = await self._get_bank_account_id(
                    txn.entity_id, txn.source.value if hasattr(txn.source, 'value') else txn.source, revolut_account_id
                )
                if resolved:
                    bank_account_id = str(resolved)

        data = {
            "entity_id": str(txn.entity_id),
            "bank_account_id": bank_account_id,
            "source": txn.source.value if hasattr(txn.source, 'value') else txn.source,
            "external_transaction_id": txn.external_transaction_id,
            "transaction_type": txn.transaction_type.value,
            "amount": float(txn.amount),
            "currency_code": txn.currency_code,
            "base_currency_code": txn.base_currency_code,
            "fx_rate": float(txn.fx_rate) if txn.fx_rate is not None else None,
            "base_amount": float(txn.base_amount) if txn.base_amount is not None else None,
            "direction": txn.direction.value,
            "occurred_at": txn.occurred_at.isoformat(),
            "description": txn.description,
            "counterparty_name": txn.counterparty_name,
            "status": txn.status.value if hasattr(txn, 'status') and txn.status else "pending",
            "raw_event_id": str(txn.raw_event_id),
            "metadata": txn.metadata,
            "created_at": (
                txn.created_at.isoformat()
                if txn.created_at else None
            ),
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("financial_transactions")
            .upsert(data, on_conflict="source,external_transaction_id")
            .execute()
        )

        if not result.data:
            raise PersistenceError(
                "Failed to upsert financial transaction",
                entity_type="financial_transaction",
                external_id=txn.external_transaction_id,
                raw_event_id=txn.raw_event_id,
            )

        return _extract_id(result)

    async def enrich_financial_transaction(
        self,
        source: Any,
        external_transaction_id: str,
        entity_id: UUID,
        expense_category: Optional[str] = None,
        account_code: Optional[str] = None,
    ) -> Optional[UUID]:
        """Enrich an existing financial transaction with expense categorization.

        Merges expense_category and account_code into the transaction's metadata
        JSONB column (these are no longer top-level columns).

        Args:
            source: Transaction source (TxnSource enum or string)
            external_transaction_id: External transaction ID
            entity_id: Entity UUID
            expense_category: Expense category to set
            account_code: Account code to set

        Returns:
            Transaction UUID if found and updated, None otherwise
        """
        source_value = source.value if hasattr(source, 'value') else source

        # Find the existing transaction
        find_result = await asyncio.to_thread(
            lambda: self.client.table("financial_transactions")
            .select("id, metadata")
            .eq("source", source_value)
            .eq("external_transaction_id", external_transaction_id)
            .eq("entity_id", str(entity_id))
            .execute()
        )

        if not find_result.data:
            logger.warning(
                "No existing transaction found to enrich: "
                "source=%s, external_id=%s",
                source_value, external_transaction_id,
            )
            return None

        row = cast(Dict[str, Any], find_result.data[0])
        transaction_id: str = row["id"]
        existing_metadata: Dict[str, Any] = row.get("metadata") or {}

        # Merge enrichment data into metadata
        updated_metadata: Dict[str, Any] = {**existing_metadata}
        if expense_category is not None:
            updated_metadata["expense_category"] = expense_category
        if account_code is not None:
            updated_metadata["account_code"] = account_code

        if updated_metadata == existing_metadata:
            logger.info("No new enrichment data for transaction %s", transaction_id)
            return UUID(transaction_id)

        update_result = await asyncio.to_thread(
            lambda: self.client.table("financial_transactions")
            .update({"metadata": updated_metadata})
            .eq("id", transaction_id)
            .execute()
        )

        if not update_result.data:
            raise PersistenceError(
                "Failed to enrich financial transaction",
                entity_type="financial_transaction",
                external_id=external_transaction_id,
            )

        logger.info(
            "Enriched transaction %s metadata with expense data: "
            "category=%s, code=%s",
            transaction_id, expense_category, account_code,
        )

        return UUID(transaction_id)

    async def _get_bank_account_id(
        self,
        entity_id: UUID,
        source: str,
        external_account_id: str,
    ) -> Optional[UUID]:
        """Get bank_account UUID by natural key."""
        result = await asyncio.to_thread(
            lambda: self.client.table("bank_accounts")
            .select("id")
            .eq("entity_id", str(entity_id))
            .eq("source", source)
            .eq("external_account_id", external_account_id)
            .execute()
        )

        if result.data:
            return _extract_id(result)
        return None

    async def _get_chart_of_accounts_id(
        self,
        account_number: str,
    ) -> Optional[UUID]:
        """Get chart_of_accounts UUID by account_number."""
        result = await asyncio.to_thread(
            lambda: self.client.table("chart_of_accounts")
            .select("id")
            .eq("account_number", account_number)
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
        error_details: Optional[Dict[str, Any]] = None
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
        review_reason: Optional[str] = None
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
            "inventory_movement": "inventory_movements",
            "payment": "payments",
            "transaction": "payments",
            "bank_account": "bank_accounts",
            "financial_transaction": "financial_transactions",
        }
        return mapping.get(entity_type, entity_type)
    
    # =========================================================================
    # BATCH OPERATIONS
    # =========================================================================
    
    async def get_pending_events(
        self,
        limit: int = 100,
        entity_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get pending raw events for processing."""
        def _query():
            query = self.client.table("external_raw_events") \
                .select("*") \
                .eq("processing_status", "pending")
            
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
