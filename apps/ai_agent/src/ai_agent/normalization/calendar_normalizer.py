"""Base normalizer for calendar-source providers (currently Zoho Calendar only).

Sibling to FinancialNormalizer in normalizer.py: these normalizers produce
CanonicalCalendarEvent rather than commerce or financial entities, so the
commerce-specific abstract methods are stubbed with "not supported" returns.
"""

from abc import abstractmethod
from typing import Any, Dict, List
from uuid import UUID

from .normalizer import BaseNormalizer, NormalizationResult


class CalendarNormalizer(BaseNormalizer):
    """Base class for calendar-source normalizers."""

    supported_entity_types: List[str] = ["calendar_event"]

    # =========================================================================
    # COMMERCE STUBS (not applicable for calendar normalizers)
    # =========================================================================

    def normalize_order(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        return NormalizationResult.failure_result(
            entity_type="order",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message=f"{self.provider} normalizer does not support orders",
        )

    def normalize_product(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        return NormalizationResult.failure_result(
            entity_type="product",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message=f"{self.provider} normalizer does not support products",
        )

    def normalize_profile(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        return NormalizationResult.failure_result(
            entity_type="profile",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message=f"{self.provider} normalizer does not support profiles",
        )

    def normalize_inventory_item(
        self, external_id: str, payload: Dict[str, Any], raw_event_id: UUID
    ) -> NormalizationResult:
        return NormalizationResult.failure_result(
            entity_type="inventory_item",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message=f"{self.provider} normalizer does not support inventory items",
        )

    # =========================================================================
    # CALENDAR ABSTRACT METHOD - Must be implemented by subclasses
    # =========================================================================

    @abstractmethod
    def normalize_calendar_event(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a calendar event payload."""
        pass
