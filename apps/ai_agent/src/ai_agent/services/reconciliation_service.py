"""Reconciliation service for matching payments with bank transactions.

Provides:
- Clearing account balance computation from journal line items
- Automated matching of financial transactions (payouts) against payments
- Cross-provider duplicate detection (same transaction in Revolut and PayPal)
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_rows

logger = logging.getLogger(__name__)

# Matching thresholds
AMOUNT_TOLERANCE = Decimal("0.01")
DATE_PROXIMITY_DAYS = 5
CROSS_PROVIDER_DATE_DAYS = 1
MIN_CONFIDENCE_SCORE = Decimal("0.5")


class ReconciliationService:
    """Service for reconciling payments with bank transactions.

    Implements clearing balance computation and automated matching between
    Squarespace payments and Revolut/PayPal financial transactions.
    """

    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    # =========================================================================
    # CLEARING BALANCE
    # =========================================================================

    async def compute_clearing_balance(
        self,
        entity_id: UUID,
        currency: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Compute the Payment Gateway Clearing account balance.

        The clearing balance is derived from journal line items on the
        clearing account (code 1200). A positive balance means money is
        expected from payment gateways but has not yet settled.

        Args:
            entity_id: The entity to compute for
            currency: Optional currency filter

        Returns:
            Dict with balance details per currency
        """
        def _query():
            # Get the clearing account ID (account_number 1200)
            account_result = self.client.table("chart_of_accounts") \
                .select("id") \
                .eq("account_number", "1200") \
                .execute()

            if not account_result.data:
                return None, []

            account_id = account_result.data[0]["id"]

            # Sum debits and credits from posted journals
            query = self.client.table("journal_line_items") \
                .select("debit, credit, currency, journals!inner(status, entity_id)") \
                .eq("account_id", account_id) \
                .eq("journals.status", "posted") \
                .eq("journals.entity_id", str(entity_id))

            if currency:
                query = query.eq("currency", currency)

            return account_id, query.execute().data or []

        account_id, rows = await asyncio.to_thread(_query)

        if account_id is None:
            return {
                "entity_id": str(entity_id),
                "error": "Clearing account (1200) not found. Run seed_chart_of_accounts first.",
                "balances": {},
            }

        # Aggregate by currency
        balances: Dict[str, Dict[str, Decimal]] = {}
        for row in rows:
            cur = row.get("currency", "GBP")
            if cur not in balances:
                balances[cur] = {"total_debit": Decimal("0"), "total_credit": Decimal("0")}
            balances[cur]["total_debit"] += Decimal(str(row.get("debit", 0)))
            balances[cur]["total_credit"] += Decimal(str(row.get("credit", 0)))

        result_balances = {}
        for cur, totals in balances.items():
            net = totals["total_debit"] - totals["total_credit"]
            result_balances[cur] = {
                "total_debit": float(totals["total_debit"]),
                "total_credit": float(totals["total_credit"]),
                "net_balance": float(net),
            }

        return {
            "entity_id": str(entity_id),
            "account_id": str(account_id),
            "balances": result_balances,
        }

    # =========================================================================
    # RECONCILIATION
    # =========================================================================

    async def run_reconciliation(
        self,
        entity_id: UUID,
        currency: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run automated reconciliation matching.

        Matches financial transactions (payouts from Revolut/PayPal) against
        unmatched Squarespace payments.

        Process:
        1. Fetch unmatched payout transactions
        2. Fetch unmatched payments
        3. Match by amount proximity + date proximity + reference
        4. Insert reconciliation_matches entries

        Args:
            entity_id: Entity to reconcile
            currency: Optional currency filter

        Returns:
            Summary of reconciliation results
        """
        # Step 1: Fetch unmatched payout transactions
        unmatched_txns = await self._fetch_unmatched_transactions(entity_id, currency)

        # Step 2: Fetch unmatched payments (sum by batch/date)
        unmatched_payments = await self._fetch_unmatched_payments(entity_id, currency)

        if not unmatched_txns or not unmatched_payments:
            return {
                "entity_id": str(entity_id),
                "status": "completed",
                "matches_created": 0,
                "unmatched_transactions": len(unmatched_txns),
                "unmatched_payments": len(unmatched_payments),
                "message": "No items to match" if not unmatched_txns and not unmatched_payments
                    else "One side has no unmatched items",
            }

        # Step 3: Match
        matches = self._find_matches(unmatched_txns, unmatched_payments)

        # Step 4: Persist matches
        created = 0
        for match in matches:
            success = await self._insert_match(entity_id, match)
            if success:
                created += 1

        return {
            "entity_id": str(entity_id),
            "status": "completed",
            "matches_created": created,
            "unmatched_transactions": len(unmatched_txns) - created,
            "unmatched_payments": len(unmatched_payments) - created,
        }

    async def _fetch_unmatched_transactions(
        self,
        entity_id: UUID,
        currency: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch payout transactions not yet matched."""
        def _query():
            # Get IDs already matched
            matched_result = self.client.table("reconciliation_matches") \
                .select("financial_transaction_id") \
                .eq("entity_id", str(entity_id)) \
                .in_("status", ["matched", "partial"]) \
                .execute()

            matched_ids = [
                r["financial_transaction_id"]
                for r in (matched_result.data or [])
                if r.get("financial_transaction_id")
            ]

            query = self.client.table("financial_transactions") \
                .select("*") \
                .eq("entity_id", str(entity_id)) \
                .eq("transaction_type", "payment") \
                .eq("direction", "in")

            if currency:
                query = query.eq("currency_code", currency)

            if matched_ids:
                # Exclude already matched
                query = query.not_.in_("id", matched_ids)

            return query.order("occurred_at").execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def _fetch_unmatched_payments(
        self,
        entity_id: UUID,
        currency: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch payments not yet matched to bank transactions."""
        def _query():
            matched_result = self.client.table("reconciliation_matches") \
                .select("payment_id") \
                .eq("entity_id", str(entity_id)) \
                .in_("status", ["matched", "partial"]) \
                .execute()

            matched_ids = [
                r["payment_id"]
                for r in (matched_result.data or [])
                if r.get("payment_id")
            ]

            query = self.client.table("payments") \
                .select("*") \
                .eq("entity_id", str(entity_id)) \
                .eq("status", "paid")

            if currency:
                query = query.eq("currency", currency)

            if matched_ids:
                query = query.not_.in_("id", matched_ids)

            return query.order("paid_on").execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    def _find_matches(
        self,
        transactions: List[Dict[str, Any]],
        payments: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Find matching pairs between transactions and payments.

        Matching criteria:
        - Amount proximity (within tolerance)
        - Date proximity (within DATE_PROXIMITY_DAYS)
        - Optional reference matching (boosts confidence)
        """
        matches = []
        used_payment_indices: set = set()

        for txn in transactions:
            txn_amount = Decimal(str(txn.get("amount", 0)))
            txn_date = self._parse_date(txn.get("occurred_at"))
            txn_desc = (txn.get("description") or "").lower().strip()

            best_match = None
            best_score = Decimal("0")

            for i, pmt in enumerate(payments):
                if i in used_payment_indices:
                    continue

                pmt_amount = Decimal(str(pmt.get("net_amount", pmt.get("amount", 0))))
                pmt_date = self._parse_date(pmt.get("paid_on"))

                # Amount check
                amount_diff = abs(txn_amount - pmt_amount)
                if amount_diff > txn_amount * Decimal("0.05"):
                    continue

                # Date check
                if txn_date and pmt_date:
                    date_diff = abs((txn_date - pmt_date).days)
                    if date_diff > DATE_PROXIMITY_DAYS:
                        continue
                else:
                    date_diff = DATE_PROXIMITY_DAYS

                # Compute confidence score
                score = Decimal("0")

                # Amount match component (0-0.5)
                if amount_diff <= AMOUNT_TOLERANCE:
                    score += Decimal("0.5")
                else:
                    ratio = Decimal("1") - (amount_diff / txn_amount)
                    score += max(Decimal("0"), ratio * Decimal("0.5"))

                # Date proximity component (0-0.3)
                date_score = Decimal("1") - (Decimal(str(date_diff)) / Decimal(str(DATE_PROXIMITY_DAYS)))
                score += max(Decimal("0"), date_score * Decimal("0.3"))

                # Reference match component (0-0.2)
                pmt_ref = (pmt.get("external_payment_id") or "").lower().strip()
                if txn_desc and pmt_ref and (pmt_ref in txn_desc):
                    score += Decimal("0.2")

                if score > best_score and score >= MIN_CONFIDENCE_SCORE:
                    best_score = score
                    best_match = {
                        "payment_index": i,
                        "payment_id": pmt["id"],
                        "financial_transaction_id": txn["id"],
                        "clearing_amount": float(txn_amount),
                        "currency": txn.get("currency_code", "GBP"),
                        "confidence_score": float(best_score),
                        "match_type": "auto_amount_date",
                        "status": "matched" if best_score >= Decimal("0.8") else "partial",
                    }

            if best_match:
                used_payment_indices.add(best_match.pop("payment_index"))
                matches.append(best_match)

        return matches

    async def _insert_match(
        self,
        entity_id: UUID,
        match: Dict[str, Any],
    ) -> bool:
        """Insert a reconciliation match record."""
        data = {
            "entity_id": str(entity_id),
            "clearing_amount": match["clearing_amount"],
            "currency": match["currency"],
            "payment_id": match["payment_id"],
            "financial_transaction_id": match["financial_transaction_id"],
            "status": match["status"],
            "matched_at": datetime.now(timezone.utc).isoformat(),
            "match_type": match["match_type"],
            "confidence_score": match["confidence_score"],
        }

        try:
            result = await asyncio.to_thread(
                lambda: self.client.table("reconciliation_matches")
                .insert(data)
                .execute()
            )
            return bool(result.data)
        except Exception as e:
            logger.error(f"Failed to insert reconciliation match: {e}")
            return False

    # =========================================================================
    # CROSS-PROVIDER DUPLICATE DETECTION
    # =========================================================================

    async def detect_cross_provider_duplicates(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Detect duplicate transactions across Revolut and PayPal.

        Finds transactions that appear in both providers by matching:
        - Absolute amount equality (within tolerance)
        - occurred_at within 1 day
        - Optional description similarity

        Returns tagged duplicates in the result (no longer links via
        related_transaction_id, which has been removed from the schema).

        Args:
            entity_id: Entity to check

        Returns:
            Summary of duplicates found
        """
        # Fetch all financial transactions for entity
        def _query():
            return self.client.table("financial_transactions") \
                .select("id, source, external_transaction_id, amount, currency_code, "
                        "direction, occurred_at, counterparty_name, description") \
                .eq("entity_id", str(entity_id)) \
                .order("occurred_at") \
                .execute()

        result = await asyncio.to_thread(_query)
        all_txns = extract_rows(result)

        # Separate by source
        revolut_txns = [t for t in all_txns if t.get("source") == "revolut"]
        paypal_txns = [t for t in all_txns if t.get("source") == "paypal"]

        if not revolut_txns or not paypal_txns:
            return {
                "entity_id": str(entity_id),
                "duplicates_found": 0,
                "linked": 0,
                "message": "Need transactions from both providers to detect duplicates",
            }

        duplicates = []
        used_paypal: set = set()

        for r_txn in revolut_txns:
            r_amount = Decimal(str(r_txn.get("amount", 0)))
            r_date = self._parse_date(r_txn.get("occurred_at"))

            for p_txn in paypal_txns:
                if p_txn["id"] in used_paypal:
                    continue

                p_amount = Decimal(str(p_txn.get("amount", 0)))
                p_date = self._parse_date(p_txn.get("occurred_at"))

                # Amount match
                if abs(r_amount - p_amount) > AMOUNT_TOLERANCE:
                    continue

                # Date proximity
                if r_date and p_date:
                    if abs((r_date - p_date).days) > CROSS_PROVIDER_DATE_DAYS:
                        continue

                # Direction should match
                if r_txn.get("direction") != p_txn.get("direction"):
                    continue

                # Currency should match
                if r_txn.get("currency_code") != p_txn.get("currency_code"):
                    continue

                duplicates.append((r_txn["id"], p_txn["id"]))
                used_paypal.add(p_txn["id"])
                break

        # Report duplicates (no longer linking via related_transaction_id)
        return {
            "entity_id": str(entity_id),
            "duplicates_found": len(duplicates),
            "duplicate_pairs": [(r, p) for r, p in duplicates],
        }

    # =========================================================================
    # RECONCILIATION QUERIES
    # =========================================================================

    async def get_reconciliation_matches(
        self,
        entity_id: UUID,
        status_filter: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Get reconciliation matches for an entity.

        Args:
            entity_id: Entity to query
            status_filter: Optional status filter (matched, unmatched, partial, disputed)
            limit: Max results

        Returns:
            List of reconciliation match records
        """
        def _query():
            query = self.client.table("reconciliation_matches") \
                .select("*, payments(id, amount, currency, status, gateway, paid_on), "
                        "financial_transactions(id, amount, currency_code, source, "
                        "occurred_at, counterparty_name)") \
                .eq("entity_id", str(entity_id))

            if status_filter:
                query = query.eq("status", status_filter)

            return query.order("matched_at", desc=True).limit(limit).execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    # =========================================================================
    # HELPERS
    # =========================================================================

    @staticmethod
    def _parse_date(value: Any) -> Optional[datetime]:
        """Parse a date string into a datetime object."""
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None


# Global service instance
reconciliation_service = ReconciliationService()
