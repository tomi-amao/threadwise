"""Canonical domain models for normalized commerce data.

These models represent the canonical, provider-agnostic structure
that all external data is normalized into. They are designed to be:
- Immutable once created
- Hashable for caching
- Serializable for storage
"""

from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, ConfigDict


def _utcnow() -> datetime:
    """Return timezone-aware UTC now (replaces deprecated datetime.utcnow)."""
    return datetime.now(timezone.utc)


# =============================================================================
# ENUMS
# =============================================================================


class ProcessingStatus(str, Enum):
    """Status of raw event processing."""
    
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    NEEDS_REVIEW = "needs_review"


class OrderStatus(str, Enum):
    """Canonical order statuses."""
    
    PENDING = "pending"
    CONFIRMED = "confirmed"
    PROCESSING = "processing"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"


class FulfillmentStatus(str, Enum):
    """Canonical fulfillment statuses."""
    
    UNFULFILLED = "unfulfilled"
    PARTIAL = "partial"
    FULFILLED = "fulfilled"


class PaymentStatus(str, Enum):
    """Canonical payment statuses."""
    
    PENDING = "pending"
    AUTHORIZED = "authorized"
    CAPTURED = "captured"
    REFUNDED = "refunded"
    FAILED = "failed"


class InventoryAdjustmentReason(str, Enum):
    """Reasons for inventory adjustments."""

    SALE = "sale"
    RETURN = "return"
    RESTOCK = "restock"
    DAMAGE = "damage"
    SHRINKAGE = "shrinkage"
    ADJUSTMENT = "adjustment"
    INITIAL = "initial"


class FinancialTransactionType(str, Enum):
    """Types of financial transactions from bank/payment sources.

    .. deprecated:: Use TxnType instead. Kept for backward compatibility
        with commerce normalizers that haven't been migrated yet.
    """

    PAYOUT = "payout"
    FEE = "fee"
    REFUND = "refund"
    TRANSFER = "transfer"
    FX = "fx"
    CHARGEBACK = "chargeback"
    ADJUSTMENT = "adjustment"
    EXPENSE = "expense"


class TxnSource(str, Enum):
    """Source system for a financial transaction."""

    REVOLUT = "revolut"
    PAYPAL = "paypal"
    STRIPE = "stripe"
    BARCLAYS = "barclays"
    HSBC = "hsbc"
    MANUAL = "manual"
    OTHER = "other"


class TxnDirection(str, Enum):
    """Direction of a financial transaction."""

    IN = "in"
    OUT = "out"


class TxnStatus(str, Enum):
    """Processing status of a financial transaction."""

    PENDING = "pending"
    JOURNALISED = "journalised"
    RECONCILED = "reconciled"
    EXCLUDED = "excluded"
    NEEDS_REVIEW = "needs_review"


class TxnType(str, Enum):
    """Canonical transaction types."""

    PAYMENT = "payment"
    REFUND = "refund"
    FEE = "fee"
    TRANSFER = "transfer"
    FX_CONVERSION = "fx_conversion"
    INTEREST = "interest"
    RESERVE_HOLD = "reserve_hold"
    RESERVE_RELEASE = "reserve_release"
    OTHER = "other"


# Backward-compatible alias
TransactionDirection = TxnDirection


# =============================================================================
# BASE MODELS
# =============================================================================


class CanonicalBase(BaseModel):
    """Base class for all canonical models.
    
    Provides common fields for tracking provenance and auditing.
    """
    
    model_config = ConfigDict(
        frozen=True,  # Immutable
        extra="forbid",  # Strict validation
    )
    
    # Provenance tracking
    provider: str = Field(description="Source provider (e.g., 'squarespace', 'stripe')")
    external_id: str = Field(description="Original ID from the provider")
    raw_event_id: UUID = Field(description="Reference to external_raw_events.id")
    
    # Timestamps
    created_at: Optional[datetime] = Field(default=None, description="When created in source system")
    updated_at: Optional[datetime] = Field(default=None, description="When last updated in source system")


class ProcessingResult(BaseModel):
    """Result of processing a raw event."""
    
    model_config = ConfigDict(frozen=True)
    
    raw_event_id: UUID
    status: ProcessingStatus
    entity_type: str
    canonical_id: Optional[UUID] = None
    error_message: Optional[str] = None
    error_details: Optional[Dict[str, Any]] = None
    processed_at: datetime = Field(default_factory=_utcnow)


class Address(BaseModel):
    """Canonical address model."""
    
    model_config = ConfigDict(frozen=True)
    
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    address_line_1: Optional[str] = None
    address_line_2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    country_code: Optional[str] = None
    phone: Optional[str] = None


class Money(BaseModel):
    """Canonical money model with precise decimal handling."""
    
    model_config = ConfigDict(frozen=True)
    
    amount: Decimal = Field(description="Amount as decimal")
    currency: str = Field(min_length=3, max_length=3, description="ISO 4217 currency code")
    
    @field_validator("amount", mode="before")
    @classmethod
    def parse_amount(cls, v: Any) -> Decimal:
        """Parse amount from various formats."""
        if isinstance(v, Decimal):
            return v
        if isinstance(v, (int, float)):
            return Decimal(str(v))
        if isinstance(v, str):
            return Decimal(v)
        if isinstance(v, dict):
            # Handle Squarespace format: {"value": "50.00", "currency": "GBP"}
            return Decimal(str(v.get("value", "0")))
        return Decimal("0")


# =============================================================================
# COMMERCIAL DOMAIN
# =============================================================================


class CanonicalCustomer(CanonicalBase):
    """Canonical customer model.
    
    Represents a customer across all commerce platforms.
    Only contains fields universal to every provider.
    Provider-specific data lives in metadata.
    """
    
    # Required for identity resolution
    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")
    
    # Customer details
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    
    # Address
    default_address: Optional[Address] = None
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class CanonicalLineItem(BaseModel):
    """Canonical order line item model.
    
    Represents a single product in an order.
    """
    
    model_config = ConfigDict(frozen=True)
    
    # Identity
    external_id: str = Field(description="Line item ID from provider")
    
    # Product reference
    product_external_id: Optional[str] = None
    variant_external_id: Optional[str] = None
    sku: Optional[str] = None
    
    # Description
    product_name: str
    variant_name: Optional[str] = None
    
    # Quantities and pricing
    quantity: int = Field(ge=0)
    unit_price: Money
    total_price: Money
    discount_amount: Optional[Money] = None
    tax_amount: Optional[Money] = None
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class CanonicalOrder(CanonicalBase):
    """Canonical order model.
    
    Represents an order across all commerce platforms.
    Only contains fields universal to every provider.
    Provider-specific data lives in metadata.
    """
    
    # Required for identity resolution
    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")
    
    # Customer reference
    customer_external_id: Optional[str] = None
    customer_email: Optional[str] = None
    
    # Order details
    order_number: str
    currency: str = Field(min_length=3, max_length=3, description="ISO 4217 currency code")
    
    # Status
    status: OrderStatus = OrderStatus.PENDING
    fulfillment_status: FulfillmentStatus = FulfillmentStatus.UNFULFILLED
    
    # Line items
    line_items: List[CanonicalLineItem] = Field(default_factory=list)
    
    # Totals (all in the order's currency)
    subtotal: Money
    discount_total: Money
    shipping_total: Money
    tax_total: Money
    grand_total: Money
    refunded_total: Optional[Money] = None
    
    # Addresses
    shipping_address: Optional[Address] = None
    billing_address: Optional[Address] = None
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class CanonicalPaymentFee(BaseModel):
    """Canonical payment processing fee model.
    
    Represents a processing fee charged by a payment gateway.
    """
    
    model_config = ConfigDict(frozen=True)
    
    external_fee_id: Optional[str] = None
    gross_fee: Money
    refunded_fee: Money
    net_fee: Money
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class CanonicalPayment(CanonicalBase):
    """Canonical payment model.
    
    Represents a payment transaction.
    Only contains fields universal to every provider.
    Provider-specific data lives in metadata.
    """
    
    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")
    
    # Order reference
    order_external_id: Optional[str] = None
    
    # Payment details
    amount: Money
    refunded_amount: Optional[Money] = None
    net_amount: Optional[Money] = None
    status: PaymentStatus = PaymentStatus.PENDING
    
    # Payment gateway
    gateway: Optional[str] = Field(default=None, description="Payment gateway/processor (e.g. STRIPE, SQUARE)")
    external_payment_id: Optional[str] = Field(default=None, description="Payment transaction ID from the gateway")
    
    # Payment method
    payment_method: Optional[str] = None
    
    # Transaction IDs (legacy, kept for backward compatibility)
    transaction_id: Optional[str] = None
    
    # Timing
    paid_on: Optional[datetime] = Field(default=None, description="When the payment was actually made")
    
    # Processing fees
    fees: List[CanonicalPaymentFee] = Field(default_factory=list, description="Processing fees for this payment")
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


# =============================================================================
# INVENTORY DOMAIN
# =============================================================================


class CanonicalProductVariant(BaseModel):
    """Canonical product variant model.
    
    Only contains fields universal to every provider.
    """
    
    model_config = ConfigDict(frozen=True)
    
    external_id: str
    sku: Optional[str] = None
    name: Optional[str] = None
    
    # Pricing
    price: Optional[Money] = None
    compare_at_price: Optional[Money] = None
    on_sale: bool = False
    
    # Inventory
    quantity: int = 0
    is_unlimited: bool = False
    
    # Attributes (size, color, etc.)
    attributes: Dict[str, str] = Field(default_factory=dict)


class CanonicalProduct(CanonicalBase):
    """Canonical product model.
    
    Represents a product catalog entry.
    Only contains fields universal to every provider.
    Provider-specific data lives in metadata.
    """
    
    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")
    
    # Product details
    name: str
    description: Optional[str] = None
    product_type: Optional[str] = None
    status: str = Field(default="active", description="Product lifecycle: active, archived, draft")
    
    # Variants
    variants: List[CanonicalProductVariant] = Field(default_factory=list)
    
    # Tags
    tags: List[str] = Field(default_factory=list)
    
    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class InventoryMovementType(str, Enum):
    """Types of inventory movements."""

    INITIAL = "INITIAL"        # Opening / migration balance
    SALE = "SALE"              # Stock out from a fulfilled order
    PURCHASE = "PURCHASE"      # Stock in from a purchase invoice
    RETURN = "RETURN"          # Stock in from a customer return
    ADJUSTMENT = "ADJUSTMENT"  # Manual or provider-sync adjustment


class CanonicalInventoryItem(CanonicalBase):
    """Canonical inventory item model.
    
    Represents inventory for a specific product variant.
    Only contains fields universal to every provider.
    
    Stock quantity is tracked via the inventory_movements ledger,
    not stored directly on this record.
    """
    
    # Entity scoping
    entity_id: UUID
    
    # Product reference
    variant_external_id: str
    sku: Optional[str] = None
    
    # Flags
    is_unlimited: bool = False
    
    # Item details
    description: Optional[str] = None
    category: Optional[str] = None
    unit_cost: Decimal = Decimal("0")
    
    # GL account references
    asset_account_id: Optional[UUID] = None
    cogs_account_id: Optional[UUID] = None


class CanonicalInventoryMovement(BaseModel):
    """Canonical inventory movement model.
    
    Represents a single stock movement in the inventory ledger.
    Positive quantity = stock IN; negative = stock OUT.
    """
    
    model_config = ConfigDict(frozen=True)
    
    # Which inventory item
    inventory_item_id: Optional[UUID] = None  # Resolved at persistence time
    
    # Identifiers to resolve inventory_item_id if not known
    entity_id: UUID
    provider: str
    variant_external_id: str
    
    # Movement details
    transaction_type: InventoryMovementType
    quantity: Decimal  # positive = IN, negative = OUT
    unit_cost: Decimal = Decimal("0")
    
    # Reference to source record
    reference_id: Optional[UUID] = None
    reference_table: Optional[str] = None  # 'order_line_items', 'invoice_line_items'
    
    notes: Optional[str] = None


class CanonicalInventoryAdjustment(BaseModel):
    """Canonical inventory adjustment model.
    
    Represents a change in inventory levels.
    """
    
    model_config = ConfigDict(frozen=True)
    
    # Identity
    provider: str
    raw_event_id: UUID
    entity_id: UUID
    
    # Item reference
    variant_external_id: str
    sku: Optional[str] = None
    
    # Adjustment details
    quantity_change: int
    quantity_after: int
    reason: InventoryAdjustmentReason
    
    # Source reference (order ID, etc.)
    source_type: Optional[str] = None
    source_external_id: Optional[str] = None

    # Timestamp
    adjusted_at: datetime = Field(default_factory=_utcnow)


# =============================================================================
# FINANCIAL DOMAIN
# =============================================================================


class CanonicalBankAccount(CanonicalBase):
    """Canonical bank account model.

    Represents a bank account from Revolut, PayPal, or other financial sources.
    """

    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")

    # Account identity
    source: str = Field(description="Source provider (e.g., 'revolut', 'paypal')")
    external_account_id: str = Field(description="Account ID from the provider")

    # Account details
    name: Optional[str] = None
    currency: str = Field(min_length=3, max_length=3, description="ISO 4217 currency code")
    balance: Decimal = Field(default=Decimal("0"), description="Current balance")
    state: Optional[str] = Field(default=None, description="Account state (e.g., 'active')")

    # Provider-specific extras
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class CanonicalFinancialTransaction(CanonicalBase):
    """Canonical financial transaction model.

    Represents a bank-side transaction from Revolut, PayPal, or other sources.
    Distinct from CanonicalPayment which is commerce-side (Squarespace).

    Key conventions:
    - ``amount`` is always positive; ``direction`` carries the sign.
    - ``base_amount`` is always in the entity's base currency (GBP).
    - For FX transactions, each leg becomes its own row with a
      ``--leg-<ccy>`` suffix on ``external_transaction_id``.
    """

    entity_id: UUID = Field(description="Parent entity ID for multi-tenant scoping")

    # Account reference
    bank_account_id: Optional[UUID] = Field(default=None, description="FK to bank_accounts")

    # Transaction identity
    source: TxnSource = Field(description="Source system (revolut, paypal, etc.)")
    external_transaction_id: str = Field(description="Provider's own ID (unique per source)")

    # Transaction details
    transaction_type: TxnType
    direction: TxnDirection
    occurred_at: datetime

    # Descriptive fields
    description: Optional[str] = None
    counterparty_name: Optional[str] = None

    # Money
    amount: Decimal = Field(description="Always positive; direction carries the sign")
    currency_code: str = Field(min_length=3, max_length=3, description="ISO 4217")
    base_currency_code: str = Field(default="GBP", min_length=3, max_length=3)
    fx_rate: Optional[Decimal] = Field(default=None, description="NULL if same currency")
    base_amount: Decimal = Field(description="Amount in base currency")

    # Processing state
    status: TxnStatus = Field(default=TxnStatus.PENDING)
    journalised_at: Optional[datetime] = None
    reconciled_at: Optional[datetime] = None
    excluded_reason: Optional[str] = None

    # Provider-specific extras (merchant info, expense_category, etc.)
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Provider-specific fields")


class ExpenseEnrichment(BaseModel):
    """Enrichment data for existing financial transactions from expense APIs.

    When an expense record arrives separately from the transaction record
    (e.g., Revolut Expenses API vs Transactions API), this model merges
    enrichment data into the transaction's ``metadata`` JSONB column.
    """
    model_config = ConfigDict(frozen=True)

    # Identity fields to locate existing transaction
    entity_id: UUID = Field(description="Parent entity ID")
    source: TxnSource = Field(description="Source provider")
    external_transaction_id: str = Field(
        description="Transaction ID from provider (same as existing transaction)"
    )

    # Enrichment data (merged into metadata)
    expense_category: Optional[str] = Field(
        default=None,
        description="Expense category from provider's expense API"
    )
    account_code: Optional[str] = Field(
        default=None,
        description="Chart of accounts code derived from expense category"
    )

    # Metadata
    raw_event_id: UUID = Field(description="Raw event that triggered this enrichment")
    warnings: List[str] = Field(default_factory=list)
