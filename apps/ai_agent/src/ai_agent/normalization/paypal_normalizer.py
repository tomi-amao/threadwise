"""PayPal-specific normalizer for transforming raw API payloads.

Handles the specific structure of PayPal Transaction Search API responses
and transforms them into canonical financial models.

Key behaviours:
- ``reference`` is folded into ``description`` (the DB no longer has a
  ``reference`` column).
- FX fields (``currency_code``, ``base_currency_code``, ``fx_rate``,
  ``base_amount``) are populated from PayPal's amount structures.
"""

import logging
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from .models import (
    CanonicalBankAccount,
    CanonicalFinancialTransaction,
    TxnDirection,
    TxnSource,
    TxnStatus,
    TxnType,
)
from .normalizer import FinancialNormalizer, NormalizationResult

logger = logging.getLogger(__name__)


class PayPalNormalizer(FinancialNormalizer):
    """Normalizer for PayPal Transaction Search API payloads.

    Supports:
    - Financial transactions (/v1/reporting/transactions)

    Does NOT support bank_account (PayPal has no equivalent endpoint
    in the Transaction Search API).
    """

    provider = "paypal"
    supported_entity_types = ["financial_transaction"]

    # =========================================================================
    # TYPE MAPPINGS
    # =========================================================================

    # PayPal transaction event codes -> canonical types
    # See: https://developer.paypal.com/docs/transaction-search/transaction-event-codes/
    TRANSACTION_TYPE_MAP: Dict[str, TxnType] = {
        "T0000": TxnType.PAYMENT,
        "T0001": TxnType.PAYMENT,
        "T0002": TxnType.PAYMENT,
        "T0003": TxnType.PAYMENT,
        "T0400": TxnType.REFUND,
        "T0700": TxnType.TRANSFER,
        "T0803": TxnType.OTHER,       # chargeback
        "T1106": TxnType.FX_CONVERSION,
        "T1107": TxnType.FX_CONVERSION,
        "T0006": TxnType.FEE,
    }

    # =========================================================================
    # BANK ACCOUNT NORMALIZATION (not supported)
    # =========================================================================

    def normalize_bank_account(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """PayPal Transaction Search API does not provide bank accounts.

        Always returns a failure result.
        """
        return NormalizationResult.failure_result(
            entity_type="bank_account",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message="PayPal normalizer does not support bank accounts",
        )

    # =========================================================================
    # EXPENSE NORMALIZATION (not supported)
    # =========================================================================

    def normalize_expense(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """PayPal Transaction Search API does not provide separate expenses.

        Always returns a failure result. Expenses appear as regular
        transactions in PayPal's API.
        """
        return NormalizationResult.failure_result(
            entity_type="expense",
            external_id=external_id,
            raw_event_id=raw_event_id,
            error_message="PayPal normalizer does not support separate expenses",
        )

    # =========================================================================
    # FINANCIAL TRANSACTION NORMALIZATION
    # =========================================================================

    def normalize_financial_transaction(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a PayPal transaction_details item.

        PayPal Transaction Search item structure:
        - transaction_info: transaction_id, transaction_event_code,
          transaction_initiation_date, transaction_amount, fee_amount,
          transaction_status, transaction_subject, transaction_note,
          ending_balance
        - payer_info: account_id, email_address, payer_name
        - cart_info, store_info, auction_info, incentive_info
        """
        warnings: List[str] = []

        try:
            txn_info = payload.get("transaction_info", {})
            payer_info = payload.get("payer_info", {})

            # -----------------------------------------------------------------
            # Amount and currency
            # -----------------------------------------------------------------
            txn_amount = txn_info.get("transaction_amount", {})
            amount_str = txn_amount.get("value", "0")
            currency = txn_amount.get("currency_code", "GBP")

            amount_decimal = Decimal(str(amount_str))
            amount_value = abs(amount_decimal)

            if amount_value == 0:
                return NormalizationResult.skip_result(
                    entity_type="financial_transaction",
                    external_id=external_id,
                    raw_event_id=raw_event_id,
                    skip_reason="Zero-amount transaction",
                )

            # -----------------------------------------------------------------
            # Direction (negative = OUT, positive = IN)
            # -----------------------------------------------------------------
            direction = (
                TxnDirection.IN
                if amount_decimal > 0
                else TxnDirection.OUT
            )

            # -----------------------------------------------------------------
            # Transaction type from event code
            # -----------------------------------------------------------------
            event_code = txn_info.get("transaction_event_code", "")
            txn_type = self.TRANSACTION_TYPE_MAP.get(
                event_code, TxnType.OTHER
            )

            # -----------------------------------------------------------------
            # Timestamps
            # -----------------------------------------------------------------
            occurred_at = (
                self._parse_datetime(
                    txn_info.get("transaction_initiation_date")
                )
                or self._parse_datetime(
                    txn_info.get("transaction_updated_date")
                )
            )
            if not occurred_at:
                return NormalizationResult.failure_result(
                    entity_type="financial_transaction",
                    external_id=external_id,
                    raw_event_id=raw_event_id,
                    error_message="Transaction has no timestamp",
                )

            created_at = self._parse_datetime(
                txn_info.get("transaction_initiation_date")
            )

            # -----------------------------------------------------------------
            # Counterparty name
            # -----------------------------------------------------------------
            payer_name = payer_info.get("payer_name", {})
            counterparty_name = payer_name.get("alternate_full_name")
            if not counterparty_name:
                given = payer_name.get("given_name", "")
                surname = payer_name.get("surname", "")
                full = f"{given} {surname}".strip()
                counterparty_name = full if full else None

            # -----------------------------------------------------------------
            # Description — fold reference (transaction_id) into description
            # -----------------------------------------------------------------
            description = (
                txn_info.get("transaction_subject")
                or txn_info.get("transaction_note")
                or event_code
            )
            reference = txn_info.get("transaction_id")
            if reference:
                description = (
                    f"{description} | Ref: {reference}" if description else reference
                )

            # -----------------------------------------------------------------
            # Base amount / FX rate
            # -----------------------------------------------------------------
            base_currency = "GBP"
            if currency == base_currency:
                fx_rate = None
                base_amount = amount_value
            else:
                # PayPal may not surface a converted GBP amount here;
                # best-effort: mark for review
                base_amount = amount_value
                fx_rate = None
                warnings.append(
                    f"Could not derive GBP base_amount for {currency} PayPal transaction"
                )

            # -----------------------------------------------------------------
            # Metadata (provider-specific extras)
            # -----------------------------------------------------------------
            metadata: Dict[str, Any] = {
                "transaction_event_code": event_code,
                "transaction_status": txn_info.get("transaction_status"),
            }

            fee_amount = txn_info.get("fee_amount")
            if fee_amount:
                metadata["fee_amount"] = fee_amount

            if payer_info:
                metadata["payer_info"] = payer_info

            ending_balance = txn_info.get("ending_balance")
            if ending_balance:
                metadata["ending_balance"] = ending_balance

            # -----------------------------------------------------------------
            # Build canonical model
            # -----------------------------------------------------------------
            canonical = CanonicalFinancialTransaction(
                provider=self.provider,
                external_id=external_id,
                raw_event_id=raw_event_id,
                created_at=created_at,
                entity_id=self.entity_id,
                bank_account_id=None,  # Resolved during persistence
                source=TxnSource.PAYPAL,
                external_transaction_id=external_id,
                transaction_type=txn_type,
                direction=direction,
                occurred_at=occurred_at,
                description=description,
                counterparty_name=counterparty_name,
                amount=amount_value,
                currency_code=currency,
                base_currency_code=base_currency,
                fx_rate=fx_rate,
                base_amount=base_amount,
                metadata=metadata,
            )

            return NormalizationResult.success_result(
                canonical=canonical,
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                warnings=warnings if warnings else None,
            )

        except Exception as e:
            logger.exception(
                "Error normalizing PayPal transaction %s", external_id
            )
            return NormalizationResult.failure_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Failed to normalize transaction: {str(e)}",
            )
