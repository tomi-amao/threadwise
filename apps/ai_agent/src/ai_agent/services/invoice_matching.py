"""Matching an invoice to the bank transaction that paid it.

An uploaded invoice is scored against the business's transactions (``score``):

- the right direction (money out for a purchase, in for a sale), in the invoice's currency,
  counted in the books, not already paying another invoice;
- dated from ``DAYS_BEFORE`` days before the invoice to ``DAYS_AFTER`` after it;
- for the exact amount or within ``AMOUNT_NEAR`` of it, or carrying the invoice number (a
  part payment: a deposit, then the rest);
- scored up for the invoice number appearing on the transaction, the exact amount, the
  supplier's name, and a date close to the invoice's.

A match is **confident** when the transaction carries the invoice number and the exact amount.
A confident match that is the only one is linked automatically (``matched_by = 'auto'``); any
other is a suggestion the person confirms in the drawer. Linking changes no journal: the
transaction is journaled on its own, and a draft stays a draft.

Matching runs when an invoice is uploaded (``auto_match``) and after each Revolut or PayPal
sync for every upload still unlinked (``match_unlinked``), since a bill is often uploaded
before it is paid. That run first removes automatic links whose transaction has since been
left out of the books (the PayPal clean-up excludes a PayPal payment that a Revolut one
covers), so the next match can find the transaction that counts. Links a person made are never
touched.
"""

import asyncio
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_row, extract_rows
from .invoice_rules import InvoiceRuleError

logger = logging.getLogger(__name__)

DAYS_BEFORE = 15
DAYS_AFTER = 120
AMOUNT_NEAR = Decimal("0.10")
MAX_SUGGESTIONS = 8
# Only uploads are matched here: Revolut requests and receipt invoices are linked by their
# own sync. A paid upload without a link was marked paid by hand, and one paid outside the
# bank (``paid_outside_bank``: cash, paid personally) is never matched.
MATCHABLE_ORIGINS = ("upload",)
MATCHABLE_STATUSES = ("DRAFT", "OPEN", "OVERDUE")
# Words that say nothing about who a supplier is.
_NAME_NOISE = frozenset(
    {"limited", "ltd", "llc", "inc", "company", "the", "and", "group", "trading", "co"}
)


@dataclass
class Candidate:
    """A transaction that could be an invoice's payment, with why."""

    transaction_id: str
    occurred_at: str
    description: Optional[str]
    counterparty: Optional[str]
    amount: float
    currency: str
    score: float
    exact_amount: bool
    number_found: bool
    name_found: bool
    days_after: int
    reasons: List[str] = field(default_factory=list)

    @property
    def confident(self) -> bool:
        return self.number_found and self.exact_amount

    def as_dict(self) -> Dict[str, Any]:
        return {**asdict(self), "confident": self.confident}


# ---------------------------------------------------------------------------
# Scoring (pure)
# ---------------------------------------------------------------------------


def _squash(text: str) -> str:
    """Lower case, letters and digits only: "PI-Trendsldn-02" and "pi trendsldn 02" agree."""
    return re.sub(r"[^0-9a-z]", "", text.lower())


def _searchable(txn: Dict[str, Any]) -> str:
    return " ".join(
        [
            str(txn.get("description") or ""),
            str(txn.get("counterparty_name") or ""),
            json.dumps(txn.get("metadata") or {}, ensure_ascii=False, default=str),
        ]
    )


def number_on(number: Optional[str], txn: Dict[str, Any]) -> bool:
    """Whether the invoice number appears on the transaction (its text or provider data).

    A number too short to be told apart from other text (under 4 letters and digits, or with
    no digit) never counts."""
    wanted = _squash(number or "")
    if len(wanted) < 4 or not re.search(r"\d", wanted):
        return False
    return wanted in _squash(_searchable(txn))


def name_on(names: List[str], txn: Dict[str, Any]) -> bool:
    """Whether the supplier's name appears on the transaction. Card merchants are often
    cut short ("Wellsuc7tb4" for Wellsucceed), so a long word matches on its first six
    letters."""
    text = _squash(_searchable(txn))
    for name in names:
        for word in re.findall(r"[a-z0-9]+", (name or "").lower()):
            if len(word) < 4 or word in _NAME_NOISE:
                continue
            if (word[:6] if len(word) >= 6 else word) in text:
                return True
    return False


def _day(value: Any) -> datetime:
    return datetime.fromisoformat(str(value)[:10])


def score(invoice: Dict[str, Any], txn: Dict[str, Any]) -> Optional[Candidate]:
    """How well a transaction fits as this invoice's payment, or None if it cannot be it.

    ``invoice`` has invoice_type, currency, gross_amount, invoice_date, invoice_number and
    ``names`` (the counterparty's names); ``txn`` is a financial_transactions row."""
    if txn.get("excluded_reason"):
        return None
    wanted_direction = "in" if invoice.get("invoice_type") == "SALE" else "out"
    if txn.get("direction") != wanted_direction:
        return None
    if (
        str(txn.get("currency_code") or "").upper()
        != str(invoice.get("currency") or "").upper()
    ):
        return None
    days = (_day(txn["occurred_at"]) - _day(invoice["invoice_date"])).days
    if days < -DAYS_BEFORE or days > DAYS_AFTER:
        return None

    gross = Decimal(str(invoice.get("gross_amount") or 0))
    amount = abs(Decimal(str(txn.get("amount") or 0)))
    exact = gross > 0 and abs(amount - gross) < Decimal("0.005")
    near = gross > 0 and abs(amount - gross) / gross <= AMOUNT_NEAR
    number = number_on(invoice.get("invoice_number"), txn)
    if not (near or number):
        return None
    name = name_on(invoice.get("names") or [], txn)

    reasons = []
    if number:
        reasons.append("Invoice number on the transaction")
    if exact:
        reasons.append("Exact amount")
    elif near:
        reasons.append("Amount within 10%")
    else:
        reasons.append("A part of the total")
    if name:
        reasons.append(
            "Supplier name" if wanted_direction == "out" else "Customer name"
        )
    reasons.append(
        f"{days} day{'' if abs(days) == 1 else 's'} after the invoice"
        if days >= 0
        else f"{-days} day{'' if days == -1 else 's'} before the invoice"
    )

    points = (
        (50 if number else 0)
        + (30 if exact else 15 if near else 0)
        + (15 if name else 0)
        + max(0.0, 5 - abs(days) / 10)
    )
    return Candidate(
        transaction_id=str(txn["id"]),
        occurred_at=str(txn["occurred_at"]),
        description=txn.get("description"),
        counterparty=txn.get("counterparty_name"),
        amount=float(amount),
        currency=str(txn.get("currency_code") or ""),
        score=round(points, 2),
        exact_amount=exact,
        number_found=number,
        name_found=name,
        days_after=days,
        reasons=reasons,
    )


def rank(
    invoice: Dict[str, Any], transactions: List[Dict[str, Any]]
) -> List[Candidate]:
    """The transactions that could be this invoice's payment, best first."""
    found = [c for c in (score(invoice, t) for t in transactions) if c]
    return sorted(found, key=lambda c: (-c.score, abs(c.days_after)))


def automatic_choice(candidates: List[Candidate]) -> Optional[Candidate]:
    """The candidate to link without asking: the only confident one, if there is exactly one.
    Two confident candidates (the same payment seen by PayPal and Revolut, say) are left
    for the person to choose."""
    confident = [c for c in candidates if c.confident]
    return confident[0] if len(confident) == 1 else None


# ---------------------------------------------------------------------------
# Reading and linking
# ---------------------------------------------------------------------------


def _client():
    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase is not configured")
    return client


async def _invoice(entity_id: UUID, invoice_id: UUID) -> Optional[Dict[str, Any]]:
    row = extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoices")
            .select(
                "id, entity_id, invoice_number, invoice_type, status, origin, currency, "
                "gross_amount, invoice_date, created_at, paid_outside_bank, "
                "contacts:counterparty_id(name, company_name)"
            )
            .eq("id", str(invoice_id))
            .eq("entity_id", str(entity_id))
            .execute()
        )
    )
    if not row:
        return None
    contact = row.get("contacts") or {}
    return {
        **row,
        "invoice_date": row.get("invoice_date") or row.get("created_at"),
        "names": [n for n in (contact.get("company_name"), contact.get("name")) if n],
    }


async def _window(entity_id: UUID, invoice: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Transactions in the invoice's date window that could pay it, not paying another."""
    day = _day(invoice["invoice_date"])
    start = (day - timedelta(days=DAYS_BEFORE)).date().isoformat()
    end = (day + timedelta(days=DAYS_AFTER + 1)).date().isoformat()
    rows = extract_rows(
        await asyncio.to_thread(
            lambda: _client()
            .table("financial_transactions")
            .select(
                "id, occurred_at, amount, currency_code, direction, description, "
                "counterparty_name, metadata, excluded_reason"
            )
            .eq("entity_id", str(entity_id))
            .eq("direction", "in" if invoice.get("invoice_type") == "SALE" else "out")
            .eq("currency_code", invoice.get("currency"))
            .is_("excluded_reason", "null")
            .gte("occurred_at", start)
            .lt("occurred_at", end)
            .execute()
        )
    )
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    taken: set = set()
    for start_at in range(0, len(ids), 200):
        taken.update(await _paying(ids[start_at : start_at + 200]))
    return [r for r in rows if r["id"] not in taken]


async def _paying(transaction_ids: List[str]) -> set:
    """Which of these transactions already pay an invoice."""
    links = extract_rows(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoice_payments")
            .select("financial_transaction_id")
            .in_("financial_transaction_id", transaction_ids)
            .execute()
        )
    )
    return {link["financial_transaction_id"] for link in links}


async def candidates_for(entity_id: UUID, invoice_id: UUID) -> List[Dict[str, Any]]:
    """The likeliest payments for an invoice, best first, each with why it fits."""
    invoice = await _invoice(entity_id, invoice_id)
    if (
        not invoice
        or invoice.get("status") in ("CANCELLED", "VOID")
        or invoice.get("paid_outside_bank")
    ):
        return []
    found = rank(invoice, await _window(entity_id, invoice))
    return [c.as_dict() for c in found[:MAX_SUGGESTIONS]]


async def _linked(invoice_id: str) -> bool:
    rows = extract_rows(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoice_payments")
            .select("id")
            .eq("invoice_id", invoice_id)
            .limit(1)
            .execute()
        )
    )
    return bool(rows)


async def auto_match(entity_id: UUID, invoice_id: UUID) -> Optional[Dict[str, Any]]:
    """Link an upload to its payment when the match is confident and the only one.

    Returns the candidate linked, or None (not an unlinked upload that can be paid, or no
    confident match). Refusals from the link rules are logged, not raised: matching is a
    convenience on top of the upload, never a reason for it to fail."""
    from .invoice_service import (  # the service imports nothing from here
        invoice_service,
    )

    invoice = await _invoice(entity_id, invoice_id)
    if (
        not invoice
        or invoice.get("origin") not in MATCHABLE_ORIGINS
        or invoice.get("status") not in MATCHABLE_STATUSES
        or invoice.get("paid_outside_bank")
        or await _linked(str(invoice_id))
    ):
        return None
    choice = automatic_choice(rank(invoice, await _window(entity_id, invoice)))
    if not choice:
        return None
    try:
        await invoice_service.link_payment(
            entity_id, invoice_id, UUID(choice.transaction_id), "auto"
        )
    except (InvoiceRuleError, ValueError) as error:
        logger.info(f"Invoice {invoice_id} not matched automatically: {error}")
        return None
    logger.info(
        f"Invoice {invoice['invoice_number']} matched to transaction "
        f"{choice.transaction_id} automatically"
    )
    return choice.as_dict()


async def remove_stale_auto_links(entity_id: UUID) -> int:
    """Take away automatic links whose transaction has since been left out of the books,
    so the next match can find the one that counts. A person's links stay."""
    from .invoice_service import invoice_service

    links = extract_rows(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoice_payments")
            .select("invoice_id, financial_transaction_id")
            .eq("entity_id", str(entity_id))
            .eq("matched_by", "auto")
            .execute()
        )
    )
    if not links:
        return 0
    ids = [link["financial_transaction_id"] for link in links]
    excluded = {
        row["id"]
        for row in extract_rows(
            await asyncio.to_thread(
                lambda: _client()
                .table("financial_transactions")
                .select("id")
                .in_("id", ids)
                .not_.is_("excluded_reason", "null")
                .execute()
            )
        )
    }
    removed = 0
    for link in links:
        if link["financial_transaction_id"] in excluded:
            await invoice_service.unlink_payment(
                entity_id,
                UUID(link["invoice_id"]),
                UUID(link["financial_transaction_id"]),
            )
            removed += 1
    return removed


async def unlinked_uploads(entity_id: UUID) -> List[str]:
    """Uploads that could still be matched: payable, with no payment linked."""
    rows = extract_rows(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoices")
            .select("id, invoice_payments(id)")
            .eq("entity_id", str(entity_id))
            .in_("origin", list(MATCHABLE_ORIGINS))
            .in_("status", list(MATCHABLE_STATUSES))
            .execute()
        )
    )
    return [r["id"] for r in rows if not r.get("invoice_payments")]


async def match_unlinked(entity_id: UUID) -> Dict[str, int]:
    """Clear stale automatic links, then try every unlinked upload. Safe to repeat."""
    removed = await remove_stale_auto_links(entity_id)
    matched = 0
    for invoice_id in await unlinked_uploads(entity_id):
        if await auto_match(entity_id, UUID(invoice_id)):
            matched += 1
    return {"stale_links_removed": removed, "matched": matched}
