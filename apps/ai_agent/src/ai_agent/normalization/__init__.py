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
    # Inventory Domain
    CanonicalProduct,
    CanonicalProductVariant,
    CanonicalInventoryItem,
    CanonicalInventoryAdjustment,
)

from .normalizer import (
    BaseNormalizer,
    NormalizationError,
    NormalizationResult,
)

from .squarespace_normalizer import SquarespaceNormalizer

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
    "CanonicalProduct",
    "CanonicalProductVariant",
    "CanonicalInventoryItem",
    "CanonicalInventoryAdjustment",
    # Normalizer
    "BaseNormalizer",
    "NormalizationError",
    "NormalizationResult",
    "SquarespaceNormalizer",
    # Persistence
    "PersistenceService",
    "PersistenceError",
    "persistence_service",
    # Service
    "NormalizationService",
    "normalization_service",
]
