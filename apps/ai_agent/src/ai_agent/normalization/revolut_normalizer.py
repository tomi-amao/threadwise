"""Revolut-specific normalizer for transforming raw API payloads.

Handles the specific structure of Revolut Business API responses
and transforms them into canonical financial models.

Key behaviours:
- FX (exchange) transactions produce **two** CanonicalFinancialTransaction
  rows — one per leg, each with a ``--leg-<ccy>`` suffix on the
  ``external_transaction_id`` so the ``UNIQUE (source, external_transaction_id)``
  constraint is satisfied.
- For non-FX transactions the ``reference`` field is folded into
  ``description`` (the DB no longer has a ``reference`` column).
- Expense categorisation data (MCC / merchant name) is stored in ``metadata``
  rather than dedicated columns.
"""

import logging
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple, Union
from uuid import UUID

from .models import (
    CanonicalBase,
    CanonicalBankAccount,
    CanonicalFinancialTransaction,
    ExpenseEnrichment,
    TxnDirection,
    TxnSource,
    TxnStatus,
    TxnType,
)
from .normalizer import FinancialNormalizer, NormalizationResult

logger = logging.getLogger(__name__)


class RevolutNormalizer(FinancialNormalizer):
    """Normalizer for Revolut Business API payloads.

    Supports:
    - Transactions (/api/1.0/transactions)
    - Accounts (/api/1.0/accounts)
    """

    provider = "revolut"
    supported_entity_types = ["bank_account", "financial_transaction", "expense"]

    # =========================================================================
    # TYPE MAPPINGS
    # =========================================================================

    TRANSACTION_TYPE_MAP: Dict[str, TxnType] = {
        "card_payment": TxnType.PAYMENT,
        "transfer": TxnType.TRANSFER,
        "exchange": TxnType.FX_CONVERSION,
        "card_refund": TxnType.REFUND,
        "atm": TxnType.OTHER,
        "fee": TxnType.FEE,
        "topup": TxnType.TRANSFER,
        "tax": TxnType.FEE,
        "refund": TxnType.REFUND,
        "chargeback": TxnType.OTHER,
        "payout": TxnType.PAYMENT,
        "charge": TxnType.FEE,
        "merchant_payment": TxnType.RESERVE_RELEASE,
        "merchant_reserve": TxnType.RESERVE_HOLD,
    }

    # MCC code ranges -> (account_code, expense_category)
    MCC_ACCOUNT_MAP: Dict[Tuple[int, int], Tuple[str, str]] = {
        # COGS-related
        (5000, 5099): ("5000", "product_purchase"),
        (5100, 5199): ("5100", "materials"),
        (5200, 5699): ("5000", "product_purchase"),
        # Marketing & Advertising
        (7311, 7311): ("6100", "marketing"),
        (7399, 7399): ("6100", "marketing"),
        (5961, 5969): ("6100", "marketing"),
        # Shipping & Delivery
        (4214, 4215): ("6200", "outbound_shipping"),
        (4511, 4511): ("6200", "outbound_shipping"),
        (4210, 4215): ("6200", "outbound_shipping"),
        # Software & Subscriptions
        (7372, 7372): ("6300", "software"),
        (5045, 5045): ("6300", "software"),
        (5734, 5734): ("6300", "software"),
        # Professional Services
        (8111, 8111): ("6600", "professional_services"),
        (8931, 8931): ("6600", "professional_services"),
        (8999, 8999): ("6600", "professional_services"),
        # Insurance
        (6300, 6300): ("6700", "insurance"),
        # Office Supplies
        (5943, 5943): ("6800", "office_supplies"),
        (5111, 5111): ("6800", "office_supplies"),
        (5112, 5112): ("6800", "office_supplies"),
        # Banking & Financial
        (6012, 6012): ("6900", "bank_charges"),
        (6011, 6011): ("6900", "bank_charges"),
    }

    # Known merchant name overrides (lowercase prefix match)
    MERCHANT_NAME_OVERRIDES: Dict[str, Tuple[str, str]] = {
        "google ads": ("6100", "marketing"),
        "meta ads": ("6100", "marketing"),
        "facebook": ("6100", "marketing"),
        "instagram": ("6100", "marketing"),
        "tiktok": ("6100", "marketing"),
        "mailchimp": ("6100", "marketing"),
        "klaviyo": ("6100", "marketing"),
        "royal mail": ("6200", "outbound_shipping"),
        "evri": ("6200", "outbound_shipping"),
        "hermes": ("6200", "outbound_shipping"),
        "dhl": ("6200", "outbound_shipping"),
        "ups": ("6200", "outbound_shipping"),
        "fedex": ("6200", "outbound_shipping"),
        "dpd": ("6200", "outbound_shipping"),
        "shopify": ("6300", "software"),
        "squarespace": ("6300", "software"),
        "notion": ("6300", "software"),
        "figma": ("6300", "software"),
        "canva": ("6300", "software"),
        "adobe": ("6300", "software"),
        "slack": ("6300", "software"),
        "zoom": ("6300", "software"),
        "google workspace": ("6300", "software"),
        "microsoft": ("6300", "software"),
        "xero": ("6300", "software"),
        "quickbooks": ("6300", "software"),
    }

    # =========================================================================
    # EXPENSE CATEGORIZATION
    # =========================================================================

    def _categorize_expense(
        self,
        payload: Dict[str, Any],
        txn_type: TxnType,
    ) -> Tuple[Optional[str], Optional[str]]:
        """Categorize a transaction into an expense category and account code.

        Priority:
        1. Merchant name overrides (highest confidence)
        2. MCC code mapping from merchant.category_code
        3. Default to miscellaneous for card_payment/fee types
        4. Return (None, None) for non-expense types (payouts, transfers, etc.)

        Returns:
            (account_code, expense_category) or (None, None)
        """
        # Only categorize expense-like transactions
        if txn_type not in (
            TxnType.PAYMENT,
            TxnType.FEE,
        ):
            return None, None

        merchant = payload.get("merchant") or {}
        merchant_name = merchant.get("name", "")
        mcc_code = merchant.get("category_code")

        # 1. Check merchant name overrides (case-insensitive prefix match)
        if merchant_name:
            name_lower = merchant_name.lower()
            for prefix, (acct, cat) in self.MERCHANT_NAME_OVERRIDES.items():
                if name_lower.startswith(prefix):
                    return acct, cat

        # 2. Try MCC code mapping
        if mcc_code is not None:
            try:
                mcc_int = int(mcc_code)
                for (lo, hi), (acct, cat) in self.MCC_ACCOUNT_MAP.items():
                    if lo <= mcc_int <= hi:
                        return acct, cat
            except (ValueError, TypeError):
                pass

        # 3. Default to miscellaneous expense
        return "6999", "miscellaneous"

    # =========================================================================
    # BANK ACCOUNT NORMALIZATION
    # =========================================================================

    def normalize_bank_account(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize a Revolut account payload.

        Revolut Account structure:
        - id, name, balance, currency, state, public
        - created_at, updated_at
        """
        warnings: List[str] = []

        try:
            created_at = self._parse_datetime(payload.get("created_at"))
            updated_at = self._parse_datetime(payload.get("updated_at"))

            balance_raw = payload.get("balance", 0)
            balance = Decimal(str(balance_raw))

            metadata: Dict[str, Any] = {}
            if payload.get("public") is not None:
                metadata["public"] = payload["public"]

            canonical = CanonicalBankAccount(
                provider=self.provider,
                external_id=external_id,
                raw_event_id=raw_event_id,
                created_at=created_at,
                updated_at=updated_at,
                entity_id=self.entity_id,
                source="revolut",
                external_account_id=external_id,
                name=payload.get("name"),
                currency=payload.get("currency", "GBP"),
                balance=balance,
                state=payload.get("state"),
                metadata=metadata,
            )

            return NormalizationResult.success_result(
                canonical=canonical,
                entity_type="bank_account",
                external_id=external_id,
                raw_event_id=raw_event_id,
                warnings=warnings if warnings else None,
            )

        except Exception as e:
            logger.exception(
                f"Error normalizing Revolut bank account {external_id}"
            )
            return NormalizationResult.failure_result(
                entity_type="bank_account",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Failed to normalize bank account: {str(e)}",
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
        """Normalize a Revolut transaction payload.

        Revolut Transaction structure:
        - id, type, state, reference, description
        - created_at, completed_at
        - legs[]: account_id, amount, currency, description, balance,
                  counterparty{}, fee, bill_amount, bill_currency
        - merchant{}: name, category_code, city, country (for card payments)

        FX/exchange transactions produce **two** canonical rows (one per leg).
        """
        warnings: List[str] = []

        try:
            legs = payload.get("legs", [])
            if not legs:
                return NormalizationResult.failure_result(
                    entity_type="financial_transaction",
                    external_id=external_id,
                    raw_event_id=raw_event_id,
                    error_message="Transaction has no legs",
                )

            revolut_type = payload.get("type", "").lower()
            txn_type = self.TRANSACTION_TYPE_MAP.get(revolut_type, TxnType.OTHER)

            # FX transactions: produce one row per leg
            if txn_type == TxnType.FX_CONVERSION and len(legs) >= 2:
                return self._normalize_fx_transaction(
                    external_id, payload, raw_event_id, legs, warnings
                )

            # Standard (non-FX) transaction: use primary leg
            return self._normalize_standard_transaction(
                external_id, payload, raw_event_id, legs[0], txn_type, warnings
            )

        except Exception as e:
            logger.exception(
                "Error normalizing Revolut transaction %s", external_id
            )
            return NormalizationResult.failure_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Failed to normalize transaction: {str(e)}",
            )

    # -------------------------------------------------------------------------
    # Standard (non-FX) transaction
    # -------------------------------------------------------------------------

    def _normalize_standard_transaction(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
        primary_leg: Dict[str, Any],
        txn_type: TxnType,
        warnings: List[str],
    ) -> NormalizationResult:
        """Build a single canonical row from the primary leg."""

        # Amount / currency
        amount_raw = primary_leg.get("amount", 0)
        amount_value = Decimal(str(abs(amount_raw)))
        currency = primary_leg.get("currency", "GBP")

        if amount_value == 0:
            return NormalizationResult.skip_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                skip_reason="Zero-amount transaction (failed auth/hold)",
            )

        direction = TxnDirection.IN if float(amount_raw) > 0 else TxnDirection.OUT

        # Base amount: if currency == GBP it's the same; otherwise derive
        base_currency = "GBP"
        if currency == base_currency:
            fx_rate = None
            base_amount = amount_value
        else:
            bill_amount = primary_leg.get("bill_amount")
            if bill_amount is not None and primary_leg.get("bill_currency", "").upper() == base_currency:
                base_amount = Decimal(str(abs(bill_amount)))
                fx_rate = amount_value / base_amount if base_amount else None
            else:
                # Best-effort: store same amount, flag for review
                base_amount = amount_value
                fx_rate = None
                warnings.append(
                    f"Could not derive GBP base_amount for {currency} transaction"
                )

        # Expense categorization -> metadata
        account_code, expense_category = self._categorize_expense(payload, txn_type)

        # Timestamps
        occurred_at = (
            self._parse_datetime(payload.get("completed_at"))
            or self._parse_datetime(payload.get("created_at"))
        )
        if not occurred_at:
            return NormalizationResult.failure_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message="Transaction has no timestamp",
            )

        created_at = self._parse_datetime(payload.get("created_at"))

        # Counterparty
        counterparty = self._get_nested(primary_leg, "counterparty") or {}
        counterparty_name = counterparty.get("name")
        if not counterparty_name:
            merchant = payload.get("merchant") or {}
            counterparty_name = merchant.get("name")

        # Description — fold reference into description
        description = (
            payload.get("description")
            or primary_leg.get("description")
            or payload.get("type", "")
        )
        reference = payload.get("reference")
        if reference:
            description = f"{description} | Ref: {reference}" if description else reference

        # Metadata
        metadata: Dict[str, Any] = {
            "state": payload.get("state"),
            "revolut_account_id": primary_leg.get("account_id"),
        }
        if account_code:
            metadata["account_code"] = account_code
        if expense_category:
            metadata["expense_category"] = expense_category
        if payload.get("merchant"):
            metadata["merchant"] = payload["merchant"]
        if counterparty:
            metadata["counterparty"] = counterparty
        if payload.get("card"):
            metadata["card"] = payload["card"]

        canonical = CanonicalFinancialTransaction(
            provider=self.provider,
            external_id=external_id,
            raw_event_id=raw_event_id,
            created_at=created_at,
            entity_id=self.entity_id,
            bank_account_id=None,  # Resolved during persistence
            source=TxnSource.REVOLUT,
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

    # -------------------------------------------------------------------------
    # FX (exchange) transaction — two legs
    # -------------------------------------------------------------------------

    def _normalize_fx_transaction(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
        legs: List[Dict[str, Any]],
        warnings: List[str],
    ) -> NormalizationResult:
        """Produce two canonical rows from an FX exchange payload.

        Leg 1 (negative amount) → OUT in its currency
        Leg 2 (positive amount) → IN in its currency

        Each leg gets ``external_transaction_id = <id>--leg-<ccy_lower>``
        so the UNIQUE constraint is satisfied.
        """
        occurred_at = (
            self._parse_datetime(payload.get("completed_at"))
            or self._parse_datetime(payload.get("created_at"))
        )
        if not occurred_at:
            return NormalizationResult.failure_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message="FX transaction has no timestamp",
            )

        created_at = self._parse_datetime(payload.get("created_at"))
        base_currency = "GBP"
        canonicals: List[CanonicalFinancialTransaction] = []

        # Identify the GBP leg for fx_rate derivation
        gbp_leg = next((l for l in legs if l.get("currency", "").upper() == "GBP"), None)
        gbp_abs = Decimal(str(abs(gbp_leg["amount"]))) if gbp_leg else None

        for leg in legs:
            amount_raw = leg.get("amount", 0)
            amount_value = Decimal(str(abs(amount_raw)))
            currency = leg.get("currency", "GBP").upper()

            if amount_value == 0:
                warnings.append(f"Skipping zero-amount FX leg ({currency})")
                continue

            direction = TxnDirection.IN if float(amount_raw) > 0 else TxnDirection.OUT
            leg_suffix = f"--leg-{currency.lower()}"
            ext_txn_id = f"{external_id}{leg_suffix}"

            # Derive base_amount and fx_rate
            if currency == base_currency:
                base_amount = amount_value
                fx_rate = Decimal("1")
            elif gbp_abs and gbp_abs > 0:
                base_amount = gbp_abs
                fx_rate = amount_value / gbp_abs
            else:
                base_amount = amount_value
                fx_rate = None
                warnings.append(
                    f"Could not derive GBP base_amount for FX leg {currency}"
                )

            # Fee on this leg (Revolut puts fee on the receiving leg)
            fee = leg.get("fee")

            metadata: Dict[str, Any] = {
                "state": payload.get("state"),
                "revolut_account_id": leg.get("account_id"),
                "fx_leg": True,
                "original_event_id": external_id,
            }
            if fee is not None:
                metadata["fee"] = fee

            description = leg.get("description") or f"FX {currency}"

            canonical = CanonicalFinancialTransaction(
                provider=self.provider,
                external_id=ext_txn_id,
                raw_event_id=raw_event_id,
                created_at=created_at,
                entity_id=self.entity_id,
                bank_account_id=None,
                source=TxnSource.REVOLUT,
                external_transaction_id=ext_txn_id,
                transaction_type=TxnType.FX_CONVERSION,
                direction=direction,
                occurred_at=occurred_at,
                description=description,
                counterparty_name="Revolut Internal",
                amount=amount_value,
                currency_code=currency,
                base_currency_code=base_currency,
                fx_rate=fx_rate,
                base_amount=base_amount,
                metadata=metadata,
            )
            canonicals.append(canonical)

        if not canonicals:
            return NormalizationResult.failure_result(
                entity_type="financial_transaction",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message="FX transaction produced no valid legs",
            )

        return NormalizationResult.success_result(
            canonical=canonicals,
            entity_type="financial_transaction",
            external_id=external_id,
            raw_event_id=raw_event_id,
            warnings=warnings if warnings else None,
        )

    # =========================================================================
    # EXPENSE NORMALIZATION
    # =========================================================================

    def normalize_expense(
        self,
        external_id: str,
        payload: Dict[str, Any],
        raw_event_id: UUID,
    ) -> NormalizationResult:
        """Normalize Revolut Expenses API payload into ExpenseEnrichment.

        The Expenses API provides richer categorization than the Transactions API.
        Instead of creating a new transaction, this enriches the existing transaction
        record (identified by transaction_id) with expense category and account code.

        This prevents overwriting transaction data while adding valuable categorization.

        Revolut Expenses API structure:
        - id: Expense UUID
        - transaction_id: Links to existing transaction
        - category: Expense category from Revolut
        - merchant: Merchant information

        Args:
            external_id: Revolut expense ID
            payload: Raw expense payload from Revolut API
            raw_event_id: UUID of the raw event record

        Returns:
            NormalizationResult with ExpenseEnrichment canonical
        """
        try:
            warnings: List[str] = []

            # Use transaction_id to locate the existing transaction
            transaction_id = payload.get("transaction_id")
            if not transaction_id:
                return NormalizationResult.failure_result(
                    entity_type="expense_enrichment",
                    external_id=external_id,
                    raw_event_id=raw_event_id,
                    error_message="Missing transaction_id - cannot enrich without link to transaction",
                )

            dedup_id = str(transaction_id)
            if external_id != dedup_id:
                warnings.append(
                    f"Enriching transaction {dedup_id} (expense_id={external_id})"
                )

            # Categorization from Revolut Expenses API
            # merchant is a plain string in the Expenses API (not a dict like in Transactions)
            merchant_raw = payload.get("merchant")
            if isinstance(merchant_raw, str):
                merchant_name = merchant_raw
                mcc_code: Optional[str] = None
            elif isinstance(merchant_raw, dict):
                merchant_name = merchant_raw.get("name", "")
                mcc_code = merchant_raw.get("category_code")
            else:
                merchant_name = ""
                mcc_code = None

            # Extract category from splits — use the split with the largest amount.
            # The Expenses API has no top-level 'category' field; splits are the
            # canonical source of categorization.
            splits = payload.get("splits") or []
            split_category_name: Optional[str] = None
            if splits and isinstance(splits, list):
                dominant_split = max(
                    (s for s in splits if isinstance(s, dict)),
                    key=lambda s: float(
                        (s.get("amount") or {}).get("amount", 0)
                    ),
                    default=None,
                )
                if dominant_split:
                    split_cat = dominant_split.get("category")
                    if isinstance(split_cat, dict):
                        split_category_name = split_cat.get("name")

            # Skip enrichment for generic/unhelpful categories
            _SKIP_CATEGORY_NAMES = {"general expenses", "general expense"}
            if split_category_name and split_category_name.lower() in _SKIP_CATEGORY_NAMES:
                logger.info(
                    f"Skipping expense enrichment for {external_id} "
                    f"- splits category '{split_category_name}' is not useful"
                )
                return NormalizationResult.skip_result(
                    entity_type="expense_enrichment",
                    external_id=dedup_id,
                    raw_event_id=raw_event_id,
                    skip_reason=f"splits category '{split_category_name}' is not useful for COA mapping",
                )

            # Use split category name; no top-level 'category' exists in this API
            revolut_category = split_category_name

            # Map Revolut category to our account codes
            # This is the primary benefit of using the Expenses API - better categorization
            account_code, expense_category = self._map_revolut_expense_category(
                revolut_category, merchant_name, mcc_code
            )

            # Skip enrichment if mapping failed (fell back to miscellaneous)
            if account_code == "6999":
                logger.info(
                    f"Skipping expense enrichment for {external_id} "
                    f"- category '{revolut_category}' mapped to miscellaneous (6999)"
                )
                return NormalizationResult.skip_result(
                    entity_type="expense_enrichment",
                    external_id=dedup_id,
                    raw_event_id=raw_event_id,
                    skip_reason="Category mapped to miscellaneous (6999) - not useful for COA mapping",
                )

            # Create enrichment data (only category/account fields)
            enrichment = ExpenseEnrichment(
                entity_id=self.entity_id,
                source=TxnSource.REVOLUT,
                external_transaction_id=dedup_id,
                expense_category=expense_category,
                account_code=account_code,
                raw_event_id=raw_event_id,
                warnings=warnings,
            )

            return NormalizationResult.success_result(
                canonical=enrichment,
                entity_type="expense_enrichment",
                external_id=dedup_id,
                raw_event_id=raw_event_id,
                warnings=warnings if warnings else None,
            )

        except Exception as e:
            logger.exception(
                f"Error normalizing Revolut expense {external_id}"
            )
            return NormalizationResult.failure_result(
                entity_type="expense_enrichment",
                external_id=external_id,
                raw_event_id=raw_event_id,
                error_message=f"Failed to normalize expense: {str(e)}",
            )

    def _map_revolut_expense_category(
        self,
        revolut_category: Optional[str],
        merchant_name: str,
        mcc_code: Optional[str],
    ) -> tuple[str, str]:
        """Map Revolut expense category to account code.

        Priority:
        1. Merchant name overrides
        2. Revolut category mapping
        3. MCC code fallback
        4. Default to miscellaneous

        Args:
            revolut_category: Category from Revolut Expenses API
            merchant_name: Merchant name
            mcc_code: MCC code if available

        Returns:
            (account_code, expense_category)
        """
        # 1. Check merchant name overrides (highest confidence)
        if merchant_name:
            name_lower = merchant_name.lower()
            for prefix, (acct, cat) in self.MERCHANT_NAME_OVERRIDES.items():
                if name_lower.startswith(prefix):
                    return acct, cat

        # 2. Map Revolut categories to account codes
        # Based on Revolut's expense categories (names come from splits[].category.name)
        # The normalizer lowercases and replaces spaces/& with _ before matching.
        category_map = {
            "marketing": ("6100", "marketing"),
            "advertising": ("6100", "marketing"),
            "shipping": ("6200", "outbound_shipping"),
            "postage_&_shipping": ("6200", "outbound_shipping"),
            "software": ("6300", "software"),
            "subscriptions": ("6300", "software"),
            "saas": ("6300", "software"),
            "rent": ("6400", "rent"),
            "utilities": ("6400", "utilities"),
            "salaries": ("6500", "payroll"),
            "contractors": ("6500", "contractors"),
            "legal": ("6600", "professional_services"),
            "accounting": ("6600", "professional_services"),
            "professional_services": ("6600", "professional_services"),
            "insurance": ("6700", "insurance"),
            "office_supplies": ("6800", "office_supplies"),
            "office": ("6800", "office_supplies"),
            "printing_&_stationery": ("6800", "office_supplies"),
            "stationery": ("6800", "office_supplies"),
            "travel": ("6800", "travel"),
            "meals": ("6800", "meals"),
            "food_&_drink": ("6800", "meals"),
            "groceries": ("6800", "meals"),
            "entertainment": ("6800", "entertainment"),
            "bank_fees": ("6900", "bank_charges"),
            "bank_charges": ("6900", "bank_charges"),
            "materials": ("5100", "materials"),
            "inventory": ("5000", "product_purchase"),
            "accounts_payable": ("2000", "accounts_payable"),
        }

        if revolut_category:
            cat_lower = revolut_category.lower().replace(" ", "_")
            if cat_lower in category_map:
                return category_map[cat_lower]

        # 3. Try MCC code as fallback
        if mcc_code:
            try:
                mcc_int = int(mcc_code)
                for (lo, hi), (acct, cat) in self.MCC_ACCOUNT_MAP.items():
                    if lo <= mcc_int <= hi:
                        return acct, cat
            except (ValueError, TypeError):
                pass

        # 4. Default to miscellaneous
        return "6999", "miscellaneous"
