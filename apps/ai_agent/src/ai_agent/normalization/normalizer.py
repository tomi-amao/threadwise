"""Base normalizer interface for transforming raw payloads to canonical models.

The normalizer layer is responsible for:
- Provider-specific input handling
- Provider-agnostic output models
- Business rule validation
- NO database writes (that's the persistence layer's job)
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Generic, List, Optional, Type, TypeVar, Union
from uuid import UUID

from .models import (
    CanonicalBase,
    CanonicalCustomer,
    CanonicalOrder,
    CanonicalProduct,
    CanonicalInventoryItem,
    ProcessingStatus,
)

logger = logging.getLogger(__name__)

# Type variable for canonical models
T = TypeVar("T", bound=CanonicalBase)


class NormalizationError(Exception):
    """Raised when normalization fails."""
    
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


@dataclass
class NormalizationResult:
    """Result of a normalization operation.
    
    Contains the canonical model(s) and any warnings or errors.
    """
    
    # The normalized canonical object(s)
    canonical: Optional[Union[CanonicalBase, List[CanonicalBase]]] = None
    
    # Status
    success: bool = False
    status: ProcessingStatus = ProcessingStatus.PENDING
    
    # Metadata
    entity_type: str = ""
    external_id: str = ""
    raw_event_id: Optional[UUID] = None
    
    # Error handling
    error_message: Optional[str] = None
    error_details: Optional[Dict[str, Any]] = None
    
    # Warnings (non-fatal issues)
    warnings: List[str] = field(default_factory=list)
    
    # Additional context
    needs_review: bool = False
    review_reason: Optional[str] = None
    
    # Timing
    processed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    @classmethod
    def success_result(
        cls,
        canonical: Union[CanonicalBase, List[CanonicalBase]],
        entity_type: str,
        external_id: str,
        raw_event_id: UUID,
        warnings: Optional[List[str]] = None
    ) -> "NormalizationResult":
        """Create a successful result."""
        return cls(
            canonical=canonical,
            success=True,
            status=ProcessingStatus.COMPLETED,
            entity_type=entity_type,
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings or [],
        )
    
    @classmethod
    def failure_result(
        cls,
        entity_type: str,
        external_id: str,
        raw_event_id: UUID,
        error_message: str,
        error_details: Optional[Dict[str, Any]] = None
    ) -> "NormalizationResult":
        """Create a failure result."""
        return cls(
            success=False,
            status=ProcessingStatus.FAILED,
            entity_type=entity_type,
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message=error_message,
            error_details=error_details,
        )
    
    @classmethod
    def needs_review_result(
        cls,
        canonical: Optional[Union[CanonicalBase, List[CanonicalBase]]],
        entity_type: str,
        external_id: str,
        raw_event_id: UUID,
        review_reason: str,
        warnings: Optional[List[str]] = None
    ) -> "NormalizationResult":
        """Create a needs-review result."""
        return cls(
            canonical=canonical,
            success=True,  # Normalization succeeded, but needs human review
            status=ProcessingStatus.NEEDS_REVIEW,
            entity_type=entity_type,
            external_id=external_id,
            raw_event_id=raw_event_id,
            needs_review=True,
            review_reason=review_reason,
            warnings=warnings or [],
        )


class BaseNormalizer(ABC):
    """Abstract base class for provider-specific normalizers.
    
    Each provider (Squarespace, Stripe, Shopify, etc.) should have
    its own normalizer that converts raw payloads to canonical models.
    
    The normalizer MUST:
    - Handle all entity types for the provider
    - Output typed canonical objects
    - NOT perform any database writes
    - Be deterministic (same input = same output)
    """
    
    # Provider name (e.g., 'squarespace', 'stripe')
    provider: str = ""
    
    # Supported entity types
    supported_entity_types: List[str] = []
    
    def __init__(self, entity_id: UUID):
        """Initialize normalizer with entity context.
        
        Args:
            entity_id: The entity ID for multi-tenant scoping
        """
        self.entity_id = entity_id
    
    def normalize(
        self,
        entity_type: str,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a raw payload to canonical model(s).
        
        This is the main entry point. It routes to the appropriate
        type-specific normalizer method.
        
        Args:
            entity_type: Type of entity (order, product, etc.)
            external_id: External ID from the provider
            payload: Raw JSON payload from the provider
            raw_event_id: ID of the raw event record
            
        Returns:
            NormalizationResult with canonical model(s) or error
        """
        if entity_type not in self.supported_entity_types:
            return NormalizationResult.failure_result(
                entity_type=entity_type,
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Unsupported entity type: {entity_type}",
                error_details={"supported_types": self.supported_entity_types}
            )
        
        try:
            # Route to type-specific normalizer
            method_name = f"normalize_{entity_type}"
            normalizer_method = getattr(self, method_name, None)
            
            if normalizer_method is None:
                return NormalizationResult.failure_result(
                    entity_type=entity_type,
                    external_id=external_id,
                    raw_event_id=raw_event_id,
                    error_message=f"No normalizer method for entity type: {entity_type}"
                )
            
            return normalizer_method(external_id, payload, raw_event_id)
            
        except NormalizationError as e:
            logger.error(
                f"Normalization error for {self.provider}/{entity_type}/{external_id}: {e}"
            )
            return NormalizationResult.failure_result(
                entity_type=e.entity_type,
                external_id=e.external_id,
                raw_event_id=raw_event_id,
                error_message=str(e),
                error_details=e.details
            )
        except Exception as e:
            logger.exception(
                f"Unexpected error normalizing {self.provider}/{entity_type}/{external_id}"
            )
            return NormalizationResult.failure_result(
                entity_type=entity_type,
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Unexpected error: {str(e)}",
                error_details={"exception_type": type(e).__name__}
            )
    
    # =========================================================================
    # ABSTRACT METHODS - Must be implemented by subclasses
    # =========================================================================
    
    @abstractmethod
    def normalize_order(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize an order payload."""
        pass
    
    @abstractmethod
    def normalize_product(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a product payload."""
        pass
    
    @abstractmethod
    def normalize_profile(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize a customer/profile payload."""
        pass
    
    @abstractmethod
    def normalize_inventory_item(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID
    ) -> NormalizationResult:
        """Normalize an inventory item payload."""
        pass
    
    # =========================================================================
    # HELPER METHODS
    # =========================================================================
    
    def _parse_datetime(self, value: Optional[str]) -> Optional[datetime]:
        """Parse a datetime string from various formats."""
        if not value:
            return None
        
        try:
            # Handle ISO format with Z suffix
            if value.endswith("Z"):
                value = value[:-1] + "+00:00"
            return datetime.fromisoformat(value)
        except (ValueError, TypeError):
            logger.warning(f"Could not parse datetime: {value}")
            return None
    
    def _get_nested(
        self,
        data: Dict[str, Any],
        *keys: str,
        default: Any = None
    ) -> Any:
        """Safely get nested dictionary values."""
        current = data
        for key in keys:
            if not isinstance(current, dict):
                return default
            current = current.get(key, default)
            if current is None:
                return default
        return current
