"""Reconciliation service for cross-provider duplicate detection and invoice matching.

Provides two reconciliation activities:

1.  **Cross-Provider Duplicate Detection** — Identify the same economic event
    recorded in both Revolut and PayPal.  Suppresses double-counted PayPal
    entries via ``excluded_reason`` and enriches the authoritative Revolut
    transaction with PayPal metadata.

2.  **Invoice Payment Matching** — Auto-mark invoices as PAID when a
    corresponding financial transaction meets criteria (invoice number,
    amount, date proximity).
"""

import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_rows

logger = logging.getLogger(__name__)

# ─── Matching thresholds ────────────────────────────────────────────────────
AMOUNT_TOLERANCE = Decimal("0.01")
# Cross-provider date proximity
CROSS_PROVIDER_DATE_DAYS = 1


class ReconciliationService:
    """Service for cross-provider duplicate detection and invoice matching.

    Orchestrates cross-provider duplicate detection and invoice payment
    matching.  Does not write to reconciliation_matches — all information
    is stored on the financial_transactions themselves (excluded_reason,
    metadata enrichment) and on invoice status updates.
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
    # CROSS-PROVIDER DUPLICATE DETECTION & ENRICHMENT
    # =========================================================================

    async def detect_cross_provider_duplicates(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Detect cross-provider duplicates, enrich transactions, and set excluded_reason.

        A PayPal-via-Revolut card payment produces exactly three transactions:

          1. Revolut OUT  — the real cash movement (authoritative expense)
          2. PayPal  OUT  — merchant charge in the original currency (mirrors #1)
          3. PayPal  IN   — Revolut card funding PayPal to cover #2 (mirrors #2)

        #2 and #3 are net zero and should NOT be counted as separate expenses.
        This method:
          1. Pairs Revolut OUT ↔ PayPal OUT (same economic event)
          2. Enriches the Revolut transaction with PayPal invoice/payer metadata
          3. Pairs the offsetting PayPal IN ↔ PayPal OUT and marks them as
             ``cross_provider_internal`` (net zero)
          4. Sets ``excluded_reason`` on the suppressed PayPal transactions
          5. Auto-matches and updates invoice statuses from PayPal metadata
        """
        def _query():
            return self.client.table("financial_transactions") \
                .select("id, source, external_transaction_id, amount, currency_code, "
                        "direction, occurred_at, created_at, counterparty_name, description, "
                        "metadata, excluded_reason, transaction_type") \
                .eq("entity_id", str(entity_id)) \
                .order("occurred_at") \
                .execute()

        result = await asyncio.to_thread(_query)
        all_txns = extract_rows(result)

        revolut_txns = [t for t in all_txns if t.get("source") == "revolut"]
        paypal_txns  = [t for t in all_txns if t.get("source") == "paypal"]

        if not revolut_txns or not paypal_txns:
            return {
                "entity_id": str(entity_id),
                "duplicates_found": 0,
                "enriched": 0,
                "invoices_updated": 0,
                "excluded_transactions": 0,
                "message": "Need transactions from both providers to detect duplicates",
            }

        # Step 1: Revolut OUT ↔ PayPal OUT — same underlying economic event
        revolut_paypal_pairs = self._find_cross_provider_pairs(revolut_txns, paypal_txns)

        # Step 2: For each paired PayPal OUT, find the offsetting PayPal IN
        paypal_internal_pairs = self._find_paypal_internal_offset_pairs(
            paypal_txns, revolut_paypal_pairs
        )

        enriched_count = 0
        invoices_updated = 0
        excluded_count = 0
        invoice_updates: List[Dict[str, Any]] = []

        for r_txn, p_out_txn in revolut_paypal_pairs:
            # Enrich Revolut with PayPal metadata
            enrichment = self._build_enrichment_payload(p_out_txn)
            await self._enrich_transaction_metadata(r_txn["id"], enrichment)
            enriched_count += 1

            # Set excluded_reason on the PayPal OUT transaction
            if not p_out_txn.get("excluded_reason"):
                await self._set_excluded_reason(
                    p_out_txn["id"],
                    "cross_provider_duplicate: mirrors Revolut transaction, "
                    "Revolut is the authoritative cash movement"
                )
                excluded_count += 1

            # Invoice matching driven by PayPal metadata
            p_metadata = p_out_txn.get("metadata") or {}
            invoice_numbers = p_metadata.get("invoice_numbers", [])
            invoice_id_ref = p_metadata.get("invoice_id")
            if invoice_numbers or invoice_id_ref:
                inv_result = await self._match_and_update_invoices(
                    entity_id=entity_id,
                    invoice_numbers=invoice_numbers,
                    invoice_id_ref=invoice_id_ref,
                    transaction_amount=Decimal(str(r_txn.get("amount", 0))),
                    currency=r_txn.get("currency_code", "GBP"),
                )
                invoices_updated += inv_result["count"]
                invoice_updates.extend(inv_result["updated_invoices"])

        # Step 3: Mark PayPal IN/OUT pairs as internally cancelled (net zero)
        for p_out_txn, p_in_txn in paypal_internal_pairs:
            for txn, reason_suffix in [
                (p_out_txn, "merchant charge mirrors Revolut OUT"),
                (p_in_txn, "Revolut card funding mirrors the merchant charge"),
            ]:
                if not txn.get("excluded_reason"):
                    await self._set_excluded_reason(
                        txn["id"],
                        f"cross_provider_internal: net-zero pair, {reason_suffix}"
                    )
                    excluded_count += 1

        return {
            "entity_id": str(entity_id),
            "duplicates_found": len(revolut_paypal_pairs),
            "enriched": enriched_count,
            "invoices_updated": invoices_updated,
            "invoice_updates": invoice_updates,
            "excluded_transactions": excluded_count,
            "internal_pairs_cancelled": len(paypal_internal_pairs),
        }

    def _find_cross_provider_pairs(
        self,
        revolut_txns: List[Dict[str, Any]],
        paypal_txns: List[Dict[str, Any]],
    ) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """Find matching Revolut-PayPal transaction pairs.

        Two matching strategies are attempted in order for each Revolut txn:

        1. **Direct match** – same currency, matching amount (within tolerance),
           same direction, date proximity.

        2. **FX bill match** – the Revolut leg was settled in a different currency
           (e.g. GBP) but the original bill was in the PayPal transaction's
           currency (e.g. USD).

        Each transaction is used at most once.
        """
        pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        used_paypal: set = set()

        for r_txn in revolut_txns:
            r_amount = Decimal(str(r_txn.get("amount", 0)))
            r_date = self._parse_date(r_txn.get("occurred_at"))
            # For card payments, occurred_at = settlement date (may be 3-5 days
            # after the authorization captured in created_at).  Use created_at as
            # a fallback so we can still match against same-day PayPal records.
            r_created_date = self._parse_date(r_txn.get("created_at"))
            r_currency = r_txn.get("currency_code", "")

            r_meta = r_txn.get("metadata") or {}
            r_bill_amount: Optional[Decimal] = (
                Decimal(str(r_meta["bill_amount"]))
                if r_meta.get("bill_amount") is not None
                else None
            )
            r_bill_currency: Optional[str] = (
                str(r_meta["bill_currency"]).upper()
                if r_meta.get("bill_currency")
                else None
            )

            for p_txn in paypal_txns:
                if p_txn["id"] in used_paypal:
                    continue

                p_amount = Decimal(str(p_txn.get("amount", 0)))
                p_currency = p_txn.get("currency_code", "")
                p_date = self._parse_date(p_txn.get("occurred_at"))

                if r_txn.get("direction") != p_txn.get("direction"):
                    continue

                # Date proximity check: use whichever Revolut date (occurred_at
                # or created_at) is closest to the PayPal date.  This handles
                # card payments where occurred_at = settlement date but
                # created_at = authorization date (same day as PayPal).
                if p_date:
                    r_dates = [d for d in [r_date, r_created_date] if d is not None]
                    if r_dates:
                        if min(abs((rd - p_date).days) for rd in r_dates) > CROSS_PROVIDER_DATE_DAYS:
                            continue

                # Strategy 1: direct amount + currency match
                if r_currency == p_currency:
                    if abs(r_amount - p_amount) <= AMOUNT_TOLERANCE:
                        pairs.append((r_txn, p_txn))
                        used_paypal.add(p_txn["id"])
                        break

                # Strategy 2: FX bill match
                if (
                    r_bill_amount is not None
                    and r_bill_currency is not None
                    and r_bill_currency == p_currency
                    and abs(r_bill_amount - p_amount) <= AMOUNT_TOLERANCE
                ):
                    pairs.append((r_txn, p_txn))
                    used_paypal.add(p_txn["id"])
                    break

        return pairs

    def _find_paypal_internal_offset_pairs(
        self,
        paypal_txns: List[Dict[str, Any]],
        revolut_paypal_pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]],
    ) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """Find PayPal IN transactions that offset a matched PayPal OUT.

        When a Revolut card funds a PayPal purchase, PayPal records:
          - an OUT (merchant charge)
          - an IN (Revolut card funding the PayPal balance)

        Both are already captured by the Revolut OUT, so these two PayPal
        entries are net zero and should be excluded from P&L reporting.
        """
        internal_pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        paired_out_ids = {p_txn["id"] for _, p_txn in revolut_paypal_pairs}
        used_in_ids: set = set()

        paypal_outs = [t for t in paypal_txns if t["id"] in paired_out_ids]
        paypal_ins  = [t for t in paypal_txns if t.get("direction") == "in"]

        for p_out in paypal_outs:
            out_amount   = Decimal(str(p_out.get("amount", 0)))
            out_currency = p_out.get("currency_code", "")
            out_date     = self._parse_date(p_out.get("occurred_at"))

            for p_in in paypal_ins:
                if p_in["id"] in used_in_ids or p_in["id"] == p_out["id"]:
                    continue
                if p_in.get("currency_code", "") != out_currency:
                    continue
                if abs(Decimal(str(p_in.get("amount", 0))) - out_amount) > AMOUNT_TOLERANCE:
                    continue

                in_date = self._parse_date(p_in.get("occurred_at"))
                if out_date and in_date:
                    if abs((out_date - in_date).days) > CROSS_PROVIDER_DATE_DAYS:
                        continue

                internal_pairs.append((p_out, p_in))
                used_in_ids.add(p_in["id"])
                break

        return internal_pairs

    # =========================================================================
    # ENRICHMENT HELPERS
    # =========================================================================

    @staticmethod
    def _build_enrichment_payload(paypal_txn: Dict[str, Any]) -> Dict[str, Any]:
        """Build enrichment data from a PayPal transaction to merge into a Revolut transaction."""
        p_meta = paypal_txn.get("metadata") or {}
        enrichment: Dict[str, Any] = {
            "paypal_matched": True,
            "paypal_transaction_id": paypal_txn.get("external_transaction_id"),
        }

        for key in ("invoice_id", "invoice_numbers", "payer_email",
                     "payer_name", "payer_country", "cart_items", "shipping"):
            if p_meta.get(key):
                enrichment[key] = p_meta[key]

        if p_meta.get("paypal_invoice_id"):
            enrichment["paypal_internal_invoice_id"] = p_meta["paypal_invoice_id"]

        return enrichment

    async def _enrich_transaction_metadata(
        self,
        transaction_id: str,
        enrichment: Dict[str, Any],
    ) -> None:
        """Merge enrichment data into a transaction's metadata JSONB column."""
        def _fetch_metadata():
            return self.client.table("financial_transactions") \
                .select("metadata") \
                .eq("id", transaction_id) \
                .execute()

        result = await asyncio.to_thread(_fetch_metadata)
        if not result.data:
            return

        existing_metadata = result.data[0].get("metadata") or {}
        merged = {**existing_metadata, **enrichment}

        if merged == existing_metadata:
            return

        def _update(tid=transaction_id, meta=merged):
            return self.client.table("financial_transactions") \
                .update({"metadata": meta}) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)

    async def _set_excluded_reason(
        self,
        transaction_id: str,
        reason: str,
    ) -> None:
        """Set excluded_reason on a financial transaction and mark status as excluded."""
        def _update(tid=transaction_id, r=reason):
            return self.client.table("financial_transactions") \
                .update({
                    "excluded_reason": r,
                    "status": "excluded",
                }) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)
        logger.info("Excluded transaction %s: %s", transaction_id[:8], reason[:60])

    # =========================================================================
    # INVOICE PAYMENT MATCHING
    # =========================================================================

    async def reconcile_invoice_payments(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Auto-mark invoices as PAID when a matching financial transaction exists.

        Matching strategy (ordered by confidence):
        1. ``metadata.invoice_id`` exactly equals ``invoice.invoice_number``
           — primary match, works even when currencies/amounts differ (PayPal
           transactions are often settled in GBP but billed in USD).
        2. Invoice number appears in transaction description or metadata fields.
        3. Amount + date proximity for same-currency transactions (fallback).

        For PURCHASE invoices the payment is an outbound transaction; for SALE
        invoices it is inbound.  Both directions are searched.
        """
        open_invoices = await self._fetch_open_invoices(entity_id)
        if not open_invoices:
            return {
                "entity_id": str(entity_id),
                "invoices_checked": 0,
                "invoices_matched": 0,
                "invoices_updated": [],
                "message": "No open invoices to match",
            }

        all_txns = await self._fetch_matchable_transactions(entity_id)

        matched_count = 0
        updated_invoices: List[Dict[str, Any]] = []

        for invoice in open_invoices:
            inv_id = invoice["id"]
            inv_number = invoice.get("invoice_number", "")
            inv_gross = Decimal(str(invoice.get("gross_amount", 0)))
            inv_currency = invoice.get("currency", "GBP")
            inv_type = invoice.get("invoice_type", "PURCHASE")
            inv_date = self._parse_date(invoice.get("invoice_date"))
            inv_num_lower = inv_number.lower()

            matched_txn: Optional[Dict[str, Any]] = None

            for txn in all_txns:
                txn_meta = txn.get("metadata") or {}
                meta_inv_ref = str(txn_meta.get("invoice_id") or "").strip()

                # ── Primary match: exact invoice_number in metadata.invoice_id ──
                if meta_inv_ref and meta_inv_ref == inv_number:
                    # Currencies may differ (e.g. USD invoice paid via GBP PayPal).
                    # Accept if the billed amount matches the invoice gross, or if
                    # the billed currency + amount matches.
                    bill_amount = txn_meta.get("bill_amount")
                    bill_currency = str(txn_meta.get("bill_currency") or "").upper()

                    if bill_currency == inv_currency and bill_amount is not None:
                        bill_dec = Decimal(str(bill_amount))
                        if abs(bill_dec - inv_gross) <= inv_gross * Decimal("0.05"):
                            matched_txn = txn
                            break
                    else:
                        # Accept regardless of amount — invoice_id is a strong signal
                        matched_txn = txn
                        break

                # ── Secondary match: invoice number in description / metadata ──
                txn_desc = (txn.get("description") or "").lower()
                ref_in_meta = (
                    inv_num_lower in txn_desc
                    or inv_num_lower in meta_inv_ref.lower()
                    or inv_num_lower in str(txn_meta.get("invoice_numbers", [])).lower()
                )

                if not ref_in_meta:
                    continue

                # Only proceed if currencies match for secondary match
                txn_currency = (txn.get("currency_code") or "GBP").strip()
                if txn_currency != inv_currency:
                    continue

                txn_amount = Decimal(str(abs(txn.get("amount", 0))))
                date_ok = True
                txn_date = self._parse_date(txn.get("occurred_at"))
                if inv_date and txn_date:
                    date_ok = abs((txn_date - inv_date).days) <= 30

                if abs(txn_amount - inv_gross) <= inv_gross * Decimal("0.02") and date_ok:
                    matched_txn = txn
                    break

            if not matched_txn:
                continue

            txn_amount = Decimal(str(abs(matched_txn.get("amount", 0))))
            new_status = "PAID" if txn_amount >= inv_gross * Decimal("0.95") else "PARTIALLY_PAID"
            previous_status = invoice.get("status")

            await self._update_invoice_status(inv_id, new_status)

            matched_count += 1
            updated_invoices.append({
                "invoice_id": inv_id,
                "invoice_number": inv_number,
                "invoice_type": inv_type,
                "previous_status": previous_status,
                "new_status": new_status,
                "matched_transaction_id": matched_txn["id"],
            })

        return {
            "entity_id": str(entity_id),
            "invoices_checked": len(open_invoices),
            "invoices_matched": matched_count,
            "invoices_updated": updated_invoices,
        }

    async def _fetch_open_invoices(self, entity_id: UUID) -> List[Dict[str, Any]]:
        """Fetch invoices that are OPEN or PARTIALLY_PAID."""
        def _query():
            return self.client.table("invoices") \
                .select("id, invoice_number, gross_amount, net_amount, currency, "
                        "invoice_date, status") \
                .eq("entity_id", str(entity_id)) \
                .in_("status", ["OPEN", "PARTIALLY_PAID"]) \
                .execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def _fetch_matchable_transactions(
        self, entity_id: UUID
    ) -> List[Dict[str, Any]]:
        """Fetch financial transactions eligible for invoice matching.

        Both directions are returned:
        - SALE invoices are settled by inbound transactions (customer pays us)
        - PURCHASE invoices are settled by outbound transactions (we pay supplier)
        """
        def _query():
            return self.client.table("financial_transactions") \
                .select("id, amount, currency_code, description, metadata, "
                        "occurred_at, source, direction") \
                .eq("entity_id", str(entity_id)) \
                .is_("excluded_reason", "null") \
                .order("occurred_at", desc=True) \
                .limit(1000) \
                .execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def _update_invoice_status(self, invoice_id: str, new_status: str) -> None:
        """Update an invoice's status."""
        def _update():
            return self.client.table("invoices") \
                .update({"status": new_status}) \
                .eq("id", invoice_id) \
                .execute()

        await asyncio.to_thread(_update)

    # =========================================================================
    # INVOICE MATCHING (called from cross-provider detection)
    # =========================================================================

    async def _match_and_update_invoices(
        self,
        entity_id: UUID,
        invoice_numbers: List[str],
        invoice_id_ref: Optional[str],
        transaction_amount: Decimal,
        currency: str,
    ) -> Dict[str, Any]:
        """Match transactions to invoices by invoice_number and update status."""
        candidates = list(invoice_numbers)
        if invoice_id_ref and invoice_id_ref not in candidates:
            candidates.append(invoice_id_ref)

        if not candidates:
            return {"count": 0, "updated_invoices": []}

        def _query_invoices():
            return self.client.table("invoices") \
                .select("id, invoice_number, gross_amount, net_amount, currency, status") \
                .eq("entity_id", str(entity_id)) \
                .in_("invoice_number", candidates) \
                .in_("status", ["OPEN", "PARTIALLY_PAID"]) \
                .execute()

        result = await asyncio.to_thread(_query_invoices)
        invoices = result.data or []

        if not invoices:
            return {"count": 0, "updated_invoices": []}

        updated_count = 0
        updated_invoices: List[Dict[str, Any]] = []

        for invoice in invoices:
            invoice_id = invoice["id"]
            invoice_gross = Decimal(str(invoice.get("gross_amount", 0)))
            invoice_currency = invoice.get("currency", "GBP")
            previous_status = invoice.get("status")

            if invoice_currency != currency:
                continue

            new_status = "PAID" if transaction_amount >= invoice_gross else "PARTIALLY_PAID"

            await self._update_invoice_status(invoice_id, new_status)

            updated_count += 1
            updated_invoices.append({
                "invoice_id": invoice_id,
                "invoice_number": invoice.get("invoice_number"),
                "previous_status": previous_status,
                "new_status": new_status,
            })

        return {"count": updated_count, "updated_invoices": updated_invoices}

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
