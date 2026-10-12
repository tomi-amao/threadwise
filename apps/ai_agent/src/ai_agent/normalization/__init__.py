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

from .models import (
    # Base
    CanonicalBase,
    ProcessingResult,
    ProcessingStatus,
    # Commercial Domain
    CanonicalCustomer,
    CanonicalOrder,
    CanonicalLineItem,
    CanonicalPayment,
    CanonicalPaymentFee,
    # Inventory Domain
    CanonicalProduct,
    CanonicalProductVariant,
    CanonicalInventoryItem,
    CanonicalInventoryAdjustment,
    CanonicalInventoryMovement,
    InventoryMovementType,
    # Financial Domain
    CanonicalBankAccount,
    CanonicalFinancialTransaction,
    FinancialTransactionType,
    TransactionDirection,
    TxnSource,
    TxnDirection,
    TxnStatus,
    TxnType,
)

from .normalizer import (
    BaseNormalizer,
    FinancialNormalizer,
    NormalizationError,
    NormalizationResult,
)

from .squarespace_normalizer import SquarespaceNormalizer
from .revolut_normalizer import RevolutNormalizer
from .paypal_normalizer import PayPalNormalizer

from .persistence import (
    PersistenceService,
    PersistenceError,
    persistence_service,
)

from .service import (
    NormalizationService,
    normalization_service,
)

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
