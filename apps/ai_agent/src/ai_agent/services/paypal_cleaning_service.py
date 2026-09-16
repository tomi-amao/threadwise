"""PayPal transaction cleaning pipeline.

Runs after all financial data has been loaded (normalised and persisted) and
before journal entries are created.  Groups PayPal transactions by invoice_id
(or by identical ``created_at`` timestamp when invoice_id is absent), classifies
each group into one of several patterns, and applies the appropriate updates:

* **Pattern A** — Currency conversion group (T0200 present, personal funds)
* **Pattern B** — Personal funds (no Revolut match, no conversion)
* **Pattern C** — Revolut-matched same-currency
* **Pattern D** — Revolut-matched with FX conversion
* **Pattern E** — Standalone sale (incoming)
* **Pattern F** — Standalone expense (outgoing)
* **Pattern G** — T2101 held-funds pair
* **Pattern H** — T1501 anomalous internal transactions

Additionally handles:
* T0600 withdrawals (kept as transfer; same-period income pairs flagged with
  ``t0600_personal_candidate`` metadata for human review — see Phase 2.5)
* T1107 chargeback credit refunds paired with T0600 (net-zero pair → exclude both)
* T1105 passthrough funding (personal funding noise → exclude)
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_rows

logger = logging.getLogger(__name__)

# ─── Matching thresholds ────────────────────────────────────────────────────
AMOUNT_TOLERANCE = Decimal("0.01")
# Maximum seconds between Revolut created_at and PayPal created_at for a match.
# Kept tight to avoid false positives.
REVOLUT_MATCH_WINDOW_SECONDS = 86_400  # 24 hours


def _dec(value: Any) -> Decimal:
    """Safely coerce a value to Decimal."""
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _event_code(txn: Dict[str, Any]) -> str:
    """Extract transaction_event_code from metadata."""
    meta = txn.get("metadata") or {}
    return str(meta.get("transaction_event_code", ""))


def _invoice_id(txn: Dict[str, Any]) -> Optional[str]:
    """Extract invoice_id from metadata."""
    meta = txn.get("metadata") or {}
    val = meta.get("invoice_id")
    return str(val) if val else None


def _passthrough_type(txn: Dict[str, Any]) -> Optional[str]:
    """Extract passthrough_type from metadata."""
    meta = txn.get("metadata") or {}
    val = meta.get("passthrough_type")
    return str(val) if val else None


def _parse_dt(value: Any) -> Optional[datetime]:
    """Parse an ISO timestamp string into a datetime."""
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    s = str(value)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S.%f%z"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


class PayPalCleaningService:
    """Service that cleans PayPal transactions prior to journaling."""

    def __init__(self) -> None:
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    # =====================================================================
    # PUBLIC API
    # =====================================================================

    async def clean_paypal_transactions(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Run the full PayPal cleaning pipeline for an entity.

        Returns a summary dict with counts per pattern applied.
        """
        paypal_txns = await self._fetch_paypal_transactions(entity_id)
        revolut_txns = await self._fetch_revolut_transactions(entity_id)

        if not paypal_txns:
            return self._empty_summary(entity_id)

        summary: Dict[str, int] = defaultdict(int)
        processed_ids: Set[str] = set()

        # ── Phase 0: Unconditional exclusions (T1501, T1105 passthrough) ──
        processed_ids |= await self._exclude_t1501(paypal_txns, summary)
        processed_ids |= await self._exclude_t1105_passthrough(paypal_txns, summary)

        # ── Phase 1: T2101 held-funds pairs (Pattern G) ──────────────────
        processed_ids |= await self._handle_t2101_pairs(paypal_txns, summary)

        # ── Phase 2: T1107 + T0600 chargeback-refund pairs ───────────────
        processed_ids |= await self._handle_t1107_t0600_pairs(paypal_txns, summary)

        # ── Phase 2.5: Flag T0600 personal income-withdrawal pairs ───────
        # Does NOT add to processed_ids — transactions still flow through
        # normal cleaning; the metadata flag surfaces them for human review.
        await self._flag_t0600_income_pairs(paypal_txns, summary)

        # ── Phase 3: Group remaining PayPal txns ─────────────────────────
        remaining = [t for t in paypal_txns if t["id"] not in processed_ids]
        groups = self._group_transactions(remaining)

        for _key, group in groups.items():
            group_ids = {t["id"] for t in group}
            if group_ids & processed_ids:
                # Some members already handled — skip overlap
                group = [t for t in group if t["id"] not in processed_ids]
                if not group:
                    continue

            newly_processed = await self._classify_and_process_group(
                group, revolut_txns, summary
            )
            processed_ids |= newly_processed

        return self._build_summary(entity_id, summary)

    # =====================================================================
    # PHASE 0 — UNCONDITIONAL EXCLUSIONS
    # =====================================================================

    async def _exclude_t1501(
        self,
        paypal_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Pattern H — Exclude all T1501 anomalous internal transactions."""
        t1501 = [t for t in paypal_txns if _event_code(t) == "T1501"]
        ids: Set[str] = set()
        for txn in t1501:
            if not txn.get("excluded_reason"):
                await self._set_excluded(
                    txn["id"],
                    reason="T1501 anomalous internal transaction",
                    description=f"[Excluded] T1501 anomalous hold — {txn.get('description', '')}",
                )
            ids.add(txn["id"])
            summary["pattern_h_t1501"] += 1
        return ids

    async def _exclude_t1105_passthrough(
        self,
        paypal_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Exclude T1105 passthrough-funding (personal funding noise).

        These are small personal-funding top-ups that pair with the actual
        expense transaction.  They have ``passthrough_type = personal_funding``
        and are always ``direction = in``.
        """
        t1105 = [
            t for t in paypal_txns
            if _event_code(t) == "T1105"
            and _passthrough_type(t) == "personal_funding"
        ]
        ids: Set[str] = set()
        for txn in t1105:
            if not txn.get("excluded_reason"):
                await self._set_excluded(
                    txn["id"],
                    reason="T1105 passthrough personal funding noise",
                    description=f"[Excluded] T1105 personal funding — {txn.get('description', '')}",
                )
            ids.add(txn["id"])
            summary["excluded_t1105_passthrough"] += 1
        return ids

    # =====================================================================
    # PHASE 1 — T2101 HELD-FUNDS PAIRS (Pattern G)
    # =====================================================================

    async def _handle_t2101_pairs(
        self,
        paypal_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Pattern G — Exclude T2101 held-funds OUT; keep the paired T2102 IN."""
        t2101_outs = [
            t for t in paypal_txns
            if _event_code(t) == "T2101" and t.get("direction") == "out"
        ]
        t2102_ins = [
            t for t in paypal_txns
            if _event_code(t) == "T2102" and t.get("direction") == "in"
        ]

        ids: Set[str] = set()
        used_t2102: Set[str] = set()

        for t_out in t2101_outs:
            out_amount = _dec(t_out.get("amount"))
            for t_in in t2102_ins:
                if t_in["id"] in used_t2102:
                    continue
                if abs(_dec(t_in.get("amount")) - out_amount) <= AMOUNT_TOLERANCE:
                    # Exclude the T2101 out
                    if not t_out.get("excluded_reason"):
                        await self._set_excluded(
                            t_out["id"],
                            reason="Held funds — not a real outflow",
                            description=f"[Excluded] T2101 held funds — {t_out.get('description', '')}",
                        )
                    ids.add(t_out["id"])
                    ids.add(t_in["id"])  # mark as processed (kept active)
                    used_t2102.add(t_in["id"])
                    summary["pattern_g_t2101"] += 1
                    break

        return ids

    # =====================================================================
    # PHASE 2 — T1107 + T0600 CHARGEBACK-REFUND PAIRS
    # =====================================================================

    # Fee tolerance for T0600 personal withdrawal detection.
    # PayPal deducts its fees before releasing funds; the withdrawal is
    # therefore slightly less than the gross income received.
    _T0600_FEE_TOLERANCE_PCT: Decimal = Decimal("0.15")  # 15% covers PayPal fees + multi-day batches
    _T0600_INCOME_WINDOW_DAYS: int = 5  # days before T0600 to search for matching income

    async def _handle_t1107_t0600_pairs(
        self,
        paypal_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Handle T1107 (chargeback credit) paired with T0600 (withdrawal).

        When a merchant refunds via chargeback:
        - T1107 IN  = credit back into PayPal balance
        - T0600 OUT = withdrawal of those same funds

        These form a net-zero pair and both should be excluded.
        Matched by same invoice_id and same amount.
        """
        t1107s = [t for t in paypal_txns if _event_code(t) == "T1107"]
        t0600s = [t for t in paypal_txns if _event_code(t) == "T0600"]

        ids: Set[str] = set()
        used_t0600: Set[str] = set()

        for refund in t1107s:
            ref_inv = _invoice_id(refund)
            ref_amount = _dec(refund.get("amount"))
            ref_date = _parse_dt(refund.get("created_at"))

            for withdrawal in t0600s:
                if withdrawal["id"] in used_t0600:
                    continue
                w_inv = _invoice_id(withdrawal)
                w_amount = _dec(withdrawal.get("amount"))
                w_date = _parse_dt(withdrawal.get("created_at"))

                # Match by invoice_id + amount, or by created_at + amount
                inv_match = ref_inv and w_inv and ref_inv == w_inv
                date_match = (
                    ref_date and w_date
                    and abs((ref_date - w_date).total_seconds()) < 60
                )
                amount_match = abs(ref_amount - w_amount) <= AMOUNT_TOLERANCE
                currency_match = (
                    refund.get("currency_code") == withdrawal.get("currency_code")
                )

                if amount_match and currency_match and (inv_match or date_match):
                    # Exclude both as net-zero chargeback pair
                    for txn, label in [
                        (refund, "T1107 chargeback credit"),
                        (withdrawal, "T0600 chargeback withdrawal"),
                    ]:
                        if not txn.get("excluded_reason"):
                            await self._set_excluded(
                                txn["id"],
                                reason=f"Net-zero chargeback pair: {label}",
                                description=f"[Excluded] {label} — {txn.get('description', '')}",
                            )
                    ids.add(refund["id"])
                    ids.add(withdrawal["id"])
                    used_t0600.add(withdrawal["id"])
                    summary["excluded_chargeback_pair"] += 1
                    break

        return ids

    # =====================================================================
    # PHASE 2.5 — T0600 PERSONAL INCOME-WITHDRAWAL PAIR DETECTION
    # =====================================================================

    async def _flag_t0600_income_pairs(
        self,
        paypal_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> None:
        """Detect T0600 withdrawals that likely represent personal income being swept to bank.

        When a personal PayPal account receives income (e.g. content-creation
        fees) and the owner immediately withdraws via T0600 to their personal
        bank, both the inbound payment and the T0600 should be excluded from
        the business books.  This cannot be automated without knowing which
        counterparties are personal, so this method flags the candidates with
        ``t0600_personal_candidate`` metadata for human review.

        Detection rule:
        - For each T0600 OUT, sum all IN payments within
          ``_T0600_INCOME_WINDOW_DAYS`` days before the withdrawal date.
        - If sum(income) ≈ T0600 amount (within ``_T0600_FEE_TOLERANCE_PCT``),
          flag both sides as candidates.
        """
        t0600_outs = [
            t for t in paypal_txns
            if _event_code(t) == "T0600" and t.get("direction") == "out"
        ]
        income_ins = [t for t in paypal_txns if t.get("direction") == "in"]

        for withdrawal in t0600_outs:
            w_date = _parse_dt(
                withdrawal.get("occurred_at") or withdrawal.get("created_at")
            )
            w_amount = _dec(withdrawal.get("amount"))

            if not w_date or w_amount == 0:
                continue

            window_start = w_date - timedelta(days=self._T0600_INCOME_WINDOW_DAYS)
            # Allow a 1-day grace window after the withdrawal (same-day or next-day)
            window_end = w_date + timedelta(days=1)

            window_income = [
                i for i in income_ins
                if (
                    _parse_dt(
                        i.get("occurred_at") or i.get("created_at")
                    ) or datetime.min.replace(tzinfo=timezone.utc)
                ) >= window_start
                and (
                    _parse_dt(
                        i.get("occurred_at") or i.get("created_at")
                    ) or datetime.max.replace(tzinfo=timezone.utc)
                ) <= window_end
            ]

            if not window_income:
                continue

            total_income = sum(_dec(i.get("amount")) for i in window_income)
            diff = abs(total_income - w_amount)
            tolerance = w_amount * self._T0600_FEE_TOLERANCE_PCT

            if diff > tolerance:
                continue

            # Candidate pair found — flag for human review
            income_ids = [i["id"] for i in window_income]
            income_summary = "; ".join(
                f"{i.get('counterparty_name') or 'unknown'} "
                f"{i.get('currency_code', 'GBP')}{i.get('amount')}"
                for i in window_income
            )

            await self._enrich_transaction_metadata(
                withdrawal["id"],
                {
                    "t0600_personal_candidate": True,
                    "review_reason": (
                        f"T0600 {w_amount} matches sum of {len(window_income)} "
                        f"income transaction(s) in prior {self._T0600_INCOME_WINDOW_DAYS}d "
                        f"(total {total_income}): {income_summary}"
                    ),
                    "paired_income_ids": income_ids,
                },
            )

            for income in window_income:
                await self._enrich_transaction_metadata(
                    income["id"],
                    {
                        "t0600_personal_candidate": True,
                        "review_reason": (
                            f"Income may be a personal PayPal receipt swept via "
                            f"T0600 {withdrawal['id'][:8]} on "
                            f"{w_date.strftime('%Y-%m-%d')}"
                        ),
                        "paired_t0600_id": withdrawal["id"],
                    },
                )

            logger.warning(
                "T0600 personal candidate: withdrawal %s (%s) matched %d income "
                "transaction(s) totalling %s — manual review required",
                withdrawal["id"][:8],
                w_amount,
                len(window_income),
                total_income,
            )
            summary["t0600_personal_candidates"] += 1

    # =====================================================================
    # PHASE 3 — GROUP CLASSIFICATION
    # =====================================================================

    def _group_transactions(
        self,
        txns: List[Dict[str, Any]],
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Group transactions by invoice_id, falling back to created_at."""
        groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for txn in txns:
            inv = _invoice_id(txn)
            if inv:
                groups[f"inv:{inv}"].append(txn)
            else:
                # Fall back to created_at timestamp (second precision)
                ts = txn.get("created_at", "")
                # Normalise to second precision for grouping
                dt = _parse_dt(ts)
                if dt:
                    key = f"ts:{dt.strftime('%Y-%m-%d %H:%M:%S')}"
                else:
                    key = f"ts:{ts}"
                groups[key].append(txn)

        return dict(groups)

    async def _classify_and_process_group(
        self,
        group: List[Dict[str, Any]],
        revolut_txns: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Classify a group and apply the appropriate cleaning."""
        processed: Set[str] = set()

        codes = {_event_code(t) for t in group}
        has_t0200 = "T0200" in codes

        # ── Standalone (single transaction) ──────────────────────────────
        if len(group) == 1:
            txn = group[0]
            code = _event_code(txn)

            # T0200 standalone → exclude
            if code == "T0200":
                if not txn.get("excluded_reason"):
                    await self._set_excluded(
                        txn["id"],
                        reason="Currency conversion noise",
                        description=f"[Excluded] Standalone T0200 conversion — {txn.get('description', '')}",
                    )
                summary["excluded_t0200_standalone"] += 1
                processed.add(txn["id"])
                return processed

            # T0700 standalone passthrough → exclude
            if code == "T0700" and _passthrough_type(txn) == "personal_funding":
                if not txn.get("excluded_reason"):
                    await self._set_excluded(
                        txn["id"],
                        reason="Standalone passthrough personal funding",
                        description=f"[Excluded] Standalone T0700 personal funding — {txn.get('description', '')}",
                    )
                summary["excluded_t0700_standalone"] += 1
                processed.add(txn["id"])
                return processed

            # Check Revolut match for standalone expense
            if txn.get("direction") == "out":
                rev_match = self._find_revolut_match_same_currency(
                    txn, revolut_txns
                )
                if rev_match:
                    # Pattern C — covered by Revolut
                    return await self._apply_revolut_match(
                        [txn], rev_match, summary, "pattern_c_revolut_matched"
                    )
                # Pattern F — standalone expense
                summary["pattern_f_standalone_expense"] += 1
                processed.add(txn["id"])
                return processed

            # Pattern E — standalone sale
            summary["pattern_e_standalone_sale"] += 1
            processed.add(txn["id"])
            return processed

        # ── Multi-transaction group ──────────────────────────────────────

        # Find the authoritative expense (direction=out, not T0200/T0700/T1105)
        noise_codes = {"T0200", "T0700", "T1105"}
        expenses = [
            t for t in group
            if t.get("direction") == "out" and _event_code(t) not in noise_codes
        ]
        t0200s = [t for t in group if _event_code(t) == "T0200"]
        t0700s = [t for t in group if _event_code(t) == "T0700"]

        # Determine authoritative expense
        auth_expense = None
        if expenses:
            # Prefer T0003/T0006/T0007/T1000 as the real expense
            auth_expense = expenses[0]

        # ── Check for Revolut match first ────────────────────────────────
        if auth_expense and has_t0200:
            # Pattern D — Revolut matched with FX conversion
            rev_match = self._find_revolut_match_fx(
                auth_expense, t0200s, revolut_txns
            )
            if rev_match:
                return await self._apply_revolut_match(
                    group, rev_match, summary, "pattern_d_revolut_fx_matched"
                )

        if auth_expense:
            rev_match = self._find_revolut_match_same_currency(
                auth_expense, revolut_txns
            )
            if rev_match:
                # Pattern C — same currency Revolut match
                return await self._apply_revolut_match(
                    group, rev_match, summary, "pattern_c_revolut_matched"
                )

        # ── No Revolut match — handle conversion or personal funds ───────
        if has_t0200 and auth_expense:
            # Pattern A — Conversion group, personal funds
            processed |= await self._apply_conversion_group(
                auth_expense, t0200s, t0700s, group, summary
            )
            return processed

        if auth_expense and t0700s:
            # Pattern B — Personal funds (no conversion, paired T0700 in)
            processed |= await self._apply_personal_funds(
                auth_expense, t0700s, group, summary
            )
            return processed

        # ── Fallback: just mark all as processed ─────────────────────────
        for txn in group:
            processed.add(txn["id"])
            # T0200 without a parent expense → standalone noise
            if _event_code(txn) == "T0200" and not txn.get("excluded_reason"):
                await self._set_excluded(
                    txn["id"],
                    reason="Currency conversion noise",
                    description=f"[Excluded] T0200 orphan conversion — {txn.get('description', '')}",
                )
                summary["excluded_t0200_orphan"] += 1
            elif _event_code(txn) == "T0700" and _passthrough_type(txn) == "personal_funding":
                if not txn.get("excluded_reason"):
                    await self._set_excluded(
                        txn["id"],
                        reason="Orphan passthrough personal funding",
                        description=f"[Excluded] T0700 orphan personal funding — {txn.get('description', '')}",
                    )
                    summary["excluded_t0700_orphan"] += 1

        summary["pattern_unclassified"] += 1
        return processed

    # =====================================================================
    # PATTERN IMPLEMENTATIONS
    # =====================================================================

    async def _apply_revolut_match(
        self,
        paypal_group: List[Dict[str, Any]],
        revolut_txn: Dict[str, Any],
        summary: Dict[str, int],
        pattern_key: str,
    ) -> Set[str]:
        """Patterns C/D — Revolut is authoritative; exclude all PayPal; enrich Revolut."""
        processed: Set[str] = set()

        # Determine the excluded_reason based on pattern
        if "fx" in pattern_key:
            reason = "Covered by matching Revolut transaction (FX conversion)"
        else:
            reason = "Covered by matching Revolut transaction"

        # Exclude all PayPal transactions in the group
        for txn in paypal_group:
            if not txn.get("excluded_reason"):
                await self._set_excluded(
                    txn["id"],
                    reason=reason,
                    description=f"[Excluded] {reason} — {txn.get('description', '')}",
                )
            processed.add(txn["id"])

        # Enrich Revolut with PayPal metadata
        enrichment = self._build_enrichment(paypal_group)
        await self._enrich_transaction_metadata(revolut_txn["id"], enrichment)

        summary[pattern_key] += 1
        return processed

    async def _apply_conversion_group(
        self,
        auth_expense: Dict[str, Any],
        t0200s: List[Dict[str, Any]],
        t0700s: List[Dict[str, Any]],
        group: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Pattern A — Currency conversion group with personal funds."""
        processed: Set[str] = set()

        # Exclude T0200 conversion transactions
        for txn in t0200s:
            if not txn.get("excluded_reason"):
                await self._set_excluded(
                    txn["id"],
                    reason="Currency conversion noise",
                    description=f"[Excluded] T0200 currency conversion — {txn.get('description', '')}",
                )
            processed.add(txn["id"])

        # Calculate fx_rate and base_amount from T0200 pair
        fx_rate, base_amount = self._calc_fx_from_conversions(
            auth_expense, t0200s
        )
        if fx_rate and base_amount:
            await self._update_fx(auth_expense["id"], fx_rate, base_amount)

        # Handle T0700 passthrough funding (personal funds)
        for txn in t0700s:
            if _passthrough_type(txn) == "personal_funding":
                if not txn.get("excluded_reason"):
                    await self._set_excluded(
                        txn["id"],
                        reason="Personal funding passthrough for conversion group",
                        description=f"[Excluded] T0700 personal funding — {txn.get('description', '')}",
                    )
                processed.add(txn["id"])

        # Update the authoritative expense description for personal funds
        has_personal = any(
            _passthrough_type(t) == "personal_funding" for t in t0700s
        )
        if has_personal:
            desc = auth_expense.get("description", "")
            if "personal funds" not in desc.lower():
                new_desc = f"{desc} [Paid using personal funds — no matching Revolut transaction]"
                await self._update_description(auth_expense["id"], new_desc)

        processed.add(auth_expense["id"])

        # Mark any remaining group members as processed
        for txn in group:
            if txn["id"] not in processed:
                # Other noise (e.g. T0200 in different direction)
                code = _event_code(txn)
                if code in ("T0200", "T0700"):
                    if not txn.get("excluded_reason"):
                        pt = _passthrough_type(txn)
                        if code == "T0700" and pt == "personal_funding":
                            await self._set_excluded(
                                txn["id"],
                                reason="Personal funding passthrough for conversion group",
                                description=f"[Excluded] T0700 personal funding — {txn.get('description', '')}",
                            )
                        elif code == "T0200":
                            await self._set_excluded(
                                txn["id"],
                                reason="Currency conversion noise",
                                description=f"[Excluded] T0200 currency conversion — {txn.get('description', '')}",
                            )
                processed.add(txn["id"])

        summary["pattern_a_conversion"] += 1
        return processed

    async def _apply_personal_funds(
        self,
        auth_expense: Dict[str, Any],
        t0700s: List[Dict[str, Any]],
        group: List[Dict[str, Any]],
        summary: Dict[str, int],
    ) -> Set[str]:
        """Pattern B — Personal funds (no Revolut match, no conversion)."""
        processed: Set[str] = set()

        # Exclude T0700 passthrough transactions
        for txn in t0700s:
            if _passthrough_type(txn) == "personal_funding":
                if not txn.get("excluded_reason"):
                    await self._set_excluded(
                        txn["id"],
                        reason="Personal funding passthrough",
                        description=f"[Excluded] T0700 personal funding — {txn.get('description', '')}",
                    )
                processed.add(txn["id"])

        # Update the authoritative expense description
        desc = auth_expense.get("description", "")
        if "personal funds" not in desc.lower():
            new_desc = f"{desc} [Paid using personal funds — no matching Revolut transaction]"
            await self._update_description(auth_expense["id"], new_desc)

        processed.add(auth_expense["id"])

        # Mark remaining group members
        for txn in group:
            processed.add(txn["id"])

        summary["pattern_b_personal_funds"] += 1
        return processed

    # =====================================================================
    # REVOLUT MATCHING
    # =====================================================================

    def _find_revolut_match_same_currency(
        self,
        paypal_txn: Dict[str, Any],
        revolut_txns: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """Pattern C — Find a Revolut transaction matching by same currency and amount.

        Returns the matched Revolut transaction or None.
        """
        p_amount = _dec(paypal_txn.get("amount"))
        p_currency = (paypal_txn.get("currency_code") or "").strip()
        p_date = _parse_dt(paypal_txn.get("created_at"))
        p_counterparty = (paypal_txn.get("counterparty_name") or "").lower().strip()

        for r_txn in revolut_txns:
            r_currency = (r_txn.get("currency_code") or "").strip()
            if r_currency != p_currency:
                continue

            r_amount = _dec(r_txn.get("amount"))
            if abs(r_amount - p_amount) > AMOUNT_TOLERANCE:
                continue

            if r_txn.get("direction") != paypal_txn.get("direction"):
                continue

            # Date proximity — use both occurred_at and created_at from Revolut
            r_created = _parse_dt(r_txn.get("created_at"))
            r_occurred = _parse_dt(r_txn.get("occurred_at"))
            if p_date:
                dates = [d for d in [r_created, r_occurred] if d]
                if dates:
                    min_diff = min(abs((d - p_date).total_seconds()) for d in dates)
                    if min_diff > REVOLUT_MATCH_WINDOW_SECONDS:
                        continue

            return r_txn

        return None

    def _find_revolut_match_fx(
        self,
        auth_expense: Dict[str, Any],
        t0200s: List[Dict[str, Any]],
        revolut_txns: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """Pattern D — Find a Revolut transaction matching via FX conversion amounts.

        Looks for a Revolut transaction where:
        - The Revolut bill_amount matches the T0200 source amount
        - OR the Revolut amount matches the T0200 GBP conversion amount
        - Same counterparty
        - Tight time window
        """
        p_date = _parse_dt(auth_expense.get("created_at"))
        p_counterparty = (auth_expense.get("counterparty_name") or "").lower().strip()

        # Collect conversion amounts from T0200 transactions
        conversion_amounts: List[Tuple[Decimal, str]] = []
        for t in t0200s:
            conversion_amounts.append((_dec(t.get("amount")), (t.get("currency_code") or "").strip()))

        for r_txn in revolut_txns:
            if r_txn.get("direction") != "out":
                continue

            r_counterparty = (r_txn.get("counterparty_name") or "").lower().strip()
            r_amount = _dec(r_txn.get("amount"))
            r_currency = (r_txn.get("currency_code") or "").strip()
            r_meta = r_txn.get("metadata") or {}
            r_bill_amount = r_meta.get("bill_amount")
            r_bill_currency = str(r_meta.get("bill_currency") or "").upper().strip()

            # Date proximity
            r_created = _parse_dt(r_txn.get("created_at"))
            r_occurred = _parse_dt(r_txn.get("occurred_at"))
            if p_date:
                dates = [d for d in [r_created, r_occurred] if d]
                if dates:
                    min_diff = min(abs((d - p_date).total_seconds()) for d in dates)
                    if min_diff > REVOLUT_MATCH_WINDOW_SECONDS:
                        continue

            # Counterparty match (fuzzy — one must contain the other)
            if p_counterparty and r_counterparty:
                if not (
                    p_counterparty in r_counterparty
                    or r_counterparty in p_counterparty
                ):
                    continue

            # Strategy 1: Revolut amount matches a T0200 conversion amount
            for conv_amount, conv_currency in conversion_amounts:
                if r_currency == conv_currency and abs(r_amount - conv_amount) <= AMOUNT_TOLERANCE:
                    return r_txn

            # Strategy 2: Revolut bill_amount matches the auth expense amount
            if r_bill_amount is not None:
                r_bill_dec = _dec(r_bill_amount)
                auth_amount = _dec(auth_expense.get("amount"))
                auth_currency = (auth_expense.get("currency_code") or "").strip()
                if r_bill_currency == auth_currency and abs(r_bill_dec - auth_amount) <= AMOUNT_TOLERANCE:
                    return r_txn

        return None

    # =====================================================================
    # FX CALCULATION
    # =====================================================================

    def _calc_fx_from_conversions(
        self,
        auth_expense: Dict[str, Any],
        t0200s: List[Dict[str, Any]],
    ) -> Tuple[Optional[Decimal], Optional[Decimal]]:
        """Calculate fx_rate and base_amount from T0200 conversion transactions.

        In a conversion group, T0200 transactions come in pairs:
        - T0200 IN  in the source currency (e.g. USD 151.20)
        - T0200 OUT in the target currency (e.g. GBP 115.16)

        The fx_rate = source_amount / target_amount
        The base_amount = target_amount (GBP equivalent)
        """
        auth_currency = (auth_expense.get("currency_code") or "").strip()
        base_currency = (auth_expense.get("base_currency_code") or "GBP").strip()

        if auth_currency == base_currency:
            # No conversion needed
            return None, None

        # Find the GBP (base currency) T0200 — direction OUT
        gbp_t0200 = None
        for t in t0200s:
            t_currency = (t.get("currency_code") or "").strip()
            if t_currency == base_currency and t.get("direction") == "out":
                gbp_t0200 = t
                break

        # If no GBP out found, try GBP in (some patterns have it reversed)
        if not gbp_t0200:
            for t in t0200s:
                t_currency = (t.get("currency_code") or "").strip()
                if t_currency == base_currency and t.get("direction") == "in":
                    gbp_t0200 = t
                    break

        if not gbp_t0200:
            return None, None

        auth_amount = _dec(auth_expense.get("amount"))
        gbp_amount = _dec(gbp_t0200.get("amount"))

        if auth_amount == 0 or gbp_amount == 0:
            return None, None

        fx_rate = auth_amount / gbp_amount
        return fx_rate.quantize(Decimal("0.00000001")), gbp_amount

    # =====================================================================
    # ENRICHMENT
    # =====================================================================

    def _build_enrichment(
        self,
        paypal_group: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Build enrichment payload from a PayPal group to apply to a Revolut transaction."""
        enrichment: Dict[str, Any] = {"paypal_cleaned": True}

        for txn in paypal_group:
            meta = txn.get("metadata") or {}
            if meta.get("invoice_id") and "invoice_id" not in enrichment:
                enrichment["invoice_id"] = meta["invoice_id"]
            if meta.get("invoice_numbers") and "invoice_numbers" not in enrichment:
                enrichment["invoice_numbers"] = meta["invoice_numbers"]
            if meta.get("payer_email") and "payer_email" not in enrichment:
                enrichment["payer_email"] = meta["payer_email"]
            if meta.get("payer_name") and "payer_name" not in enrichment:
                enrichment["payer_name"] = meta["payer_name"]
            if meta.get("cart_items") and "cart_items" not in enrichment:
                enrichment["cart_items"] = meta["cart_items"]
            if meta.get("paypal_invoice_id") and "paypal_internal_invoice_id" not in enrichment:
                enrichment["paypal_internal_invoice_id"] = meta["paypal_invoice_id"]
            if txn.get("external_transaction_id") and "paypal_transaction_id" not in enrichment:
                enrichment["paypal_transaction_id"] = txn["external_transaction_id"]

        return enrichment

    # =====================================================================
    # DATABASE HELPERS
    # =====================================================================

    async def _fetch_paypal_transactions(
        self,
        entity_id: UUID,
    ) -> List[Dict[str, Any]]:
        """Fetch all PayPal transactions for the entity (not yet excluded)."""
        def _query():
            return self.client.table("financial_transactions") \
                .select(
                    "id, source, external_transaction_id, amount, currency_code, "
                    "base_currency_code, base_amount, fx_rate, "
                    "direction, occurred_at, created_at, counterparty_name, "
                    "description, metadata, excluded_reason, transaction_type"
                ) \
                .eq("entity_id", str(entity_id)) \
                .eq("source", "paypal") \
                .is_("excluded_reason", "null") \
                .order("created_at") \
                .execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def _fetch_revolut_transactions(
        self,
        entity_id: UUID,
    ) -> List[Dict[str, Any]]:
        """Fetch all non-excluded Revolut transactions for matching."""
        def _query():
            return self.client.table("financial_transactions") \
                .select(
                    "id, source, external_transaction_id, amount, currency_code, "
                    "base_currency_code, base_amount, fx_rate, "
                    "direction, occurred_at, created_at, counterparty_name, "
                    "description, metadata, excluded_reason, transaction_type"
                ) \
                .eq("entity_id", str(entity_id)) \
                .eq("source", "revolut") \
                .is_("excluded_reason", "null") \
                .order("created_at") \
                .execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def _set_excluded(
        self,
        transaction_id: str,
        reason: str,
        description: Optional[str] = None,
    ) -> None:
        """Set excluded_reason (and optionally update description) on a transaction."""
        update_data: Dict[str, Any] = {
            "excluded_reason": reason,
            "status": "excluded",
        }
        if description:
            update_data["description"] = description

        def _update(tid=transaction_id, data=update_data):
            return self.client.table("financial_transactions") \
                .update(data) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)
        logger.info("Excluded %s: %s", transaction_id[:8], reason[:60])

    async def _update_fx(
        self,
        transaction_id: str,
        fx_rate: Decimal,
        base_amount: Decimal,
    ) -> None:
        """Update fx_rate and base_amount on a transaction."""
        def _update(tid=transaction_id, rate=str(fx_rate), amt=str(base_amount)):
            return self.client.table("financial_transactions") \
                .update({
                    "fx_rate": rate,
                    "base_amount": amt,
                }) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)
        logger.info(
            "Updated FX on %s: rate=%s base_amount=%s",
            transaction_id[:8], fx_rate, base_amount,
        )

    async def _update_description(
        self,
        transaction_id: str,
        description: str,
    ) -> None:
        """Update the description of a transaction."""
        def _update(tid=transaction_id, desc=description):
            return self.client.table("financial_transactions") \
                .update({"description": desc}) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)

    async def _enrich_transaction_metadata(
        self,
        transaction_id: str,
        enrichment: Dict[str, Any],
    ) -> None:
        """Merge enrichment data into a transaction's metadata JSONB column."""
        def _fetch():
            return self.client.table("financial_transactions") \
                .select("metadata") \
                .eq("id", transaction_id) \
                .execute()

        result = await asyncio.to_thread(_fetch)
        rows = extract_rows(result)
        if not rows:
            return

        existing = rows[0].get("metadata") or {}
        merged = {**existing, **enrichment}
        if merged == existing:
            return

        def _update(tid=transaction_id, meta=merged):
            return self.client.table("financial_transactions") \
                .update({"metadata": meta}) \
                .eq("id", tid) \
                .execute()

        await asyncio.to_thread(_update)
        logger.info("Enriched Revolut %s with PayPal metadata", transaction_id[:8])

    # =====================================================================
    # SUMMARY
    # =====================================================================

    @staticmethod
    def _empty_summary(entity_id: UUID) -> Dict[str, Any]:
        return {
            "entity_id": str(entity_id),
            "total_processed": 0,
            "patterns": {},
            "message": "No PayPal transactions to clean",
        }

    @staticmethod
    def _build_summary(
        entity_id: UUID,
        summary: Dict[str, int],
    ) -> Dict[str, Any]:
        total_excluded = sum(
            v for k, v in summary.items()
            if "excluded" in k or "pattern_h" in k or "pattern_g" in k
            or "pattern_c" in k or "pattern_d" in k
        )
        total_enriched = summary.get("pattern_c_revolut_matched", 0) + summary.get(
            "pattern_d_revolut_fx_matched", 0
        )
        return {
            "entity_id": str(entity_id),
            "total_processed": sum(summary.values()),
            "total_excluded": total_excluded,
            "total_enriched": total_enriched,
            "patterns": dict(summary),
        }


# Module-level singleton
paypal_cleaning_service = PayPalCleaningService()
