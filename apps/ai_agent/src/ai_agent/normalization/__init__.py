"""Data Normalization & Persistence System.

Transforms raw third-party commerce payloads into canonical,
provider-agnostic domain models for accounting, inventory, and analytics workflows.

Core Principles:
- Determinism: Same input always produces same database state
- Idempotency: Running the same operation multiple times produces the same result
- Auditability: Full audit trail from raw payload to normalized data
- Reprocessability: Any payload can be reprocessed safely at any time
- Immutability: Raw payloads are never modified
"""

from .models import (  # Base; Commercial Domain; Inventory Domain; Financial Domain
    CanonicalBankAccount,
    CanonicalBase,
    CanonicalCustomer,
    CanonicalFinancialTransaction,
    CanonicalInventoryAdjustment,
    CanonicalInventoryItem,
    CanonicalInventoryMovement,
    CanonicalLineItem,
    CanonicalOrder,
    CanonicalPayment,
    CanonicalPaymentFee,
    CanonicalProduct,
    CanonicalProductVariant,
    FinancialTransactionType,
    InventoryMovementType,
    ProcessingResult,
    ProcessingStatus,
    TransactionDirection,
    TxnDirection,
    TxnSource,
    TxnStatus,
    TxnType,
)
from .normalizer import (
    BaseNormalizer,
    FinancialNormalizer,
    NormalizationError,
    NormalizationResult,
)
from .paypal_normalizer import PayPalNormalizer
from .persistence import (
    PersistenceError,
    PersistenceService,
    persistence_service,
)
from .revolut_normalizer import RevolutNormalizer
from .service import (
    NormalizationService,
    normalization_service,
)
from .squarespace_normalizer import SquarespaceNormalizer

__all__ = [
    # Models
    "CanonicalBase",
    "ProcessingResult",
    "ProcessingStatus",
    "CanonicalCustomer",
    "CanonicalOrder",
    "CanonicalLineItem",
    "CanonicalPayment",
    "CanonicalPaymentFee",
    "CanonicalProduct",
    "CanonicalProductVariant",
    "CanonicalInventoryItem",
    "CanonicalInventoryAdjustment",
    "CanonicalInventoryMovement",
    "InventoryMovementType",
    "CanonicalBankAccount",
    "CanonicalFinancialTransaction",
    "FinancialTransactionType",
    "TransactionDirection",
    "TxnSource",
    "TxnDirection",
    "TxnStatus",
    "TxnType",
    # Normalizer
    "BaseNormalizer",
    "FinancialNormalizer",
    "NormalizationError",
    "NormalizationResult",
    "SquarespaceNormalizer",
    "RevolutNormalizer",
    "PayPalNormalizer",
    # Persistence
    "PersistenceService",
    "PersistenceError",
    "persistence_service",
    # Service
    "NormalizationService",
    "normalization_service",
]
