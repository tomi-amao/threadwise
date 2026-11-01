"""Splitting a payment's journal by the invoice it paid.

A payment is journaled on its own, usually before its invoice arrives, to one account. Once an
invoice is matched to it, the invoice's lines say what the money was for, so the payment's
journal can be re-cut across those lines' accounts. The invoice still posts nothing: the
journal stays the transaction's, with the transaction's date, amount and cash line.

``split_lines`` (pure) works the split out from the payment's live journal:

- the credit (cash) side is kept exactly as it is;
- the debit side becomes one line per invoice line, on that line's account, or on the account
  the payment was journaled to when the line has none;
- the lines are weighted by their gross amount and scaled so they add up exactly to the
  payment, rounding left on the largest line. One rule therefore covers a part payment (a
  deposit is that share of every line), a currency difference (a USD invoice paid from a GBP
  account) and a fee or rounding (a PayPal fee on top);
- VAT is folded into each line's amount (the business is not VAT registered), but the VAT
  share of each line is kept in the journal's metadata, so registering later needs no rework.

Nothing is stored until the person approves: ``proposals_for`` works it out, ``apply_split``
posts it and voids the journal it replaces in one database call (``apply_invoice_split``), and
``undo_split`` puts the replaced journal back (``undo_invoice_split``). Both respect the
accounting-period lock. Purchases only, for now.
"""

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_row, extract_rows
from .invoice_rules import InvoiceRuleError

logger = logging.getLogger(__name__)

SPLIT = "invoice_split"
# The journals a split can replace: a payment's own expense journal.
SPLITTABLE_TYPES = ("expense",)
CENT = Decimal("0.01")


class SplitError(InvoiceRuleError):
    """A split that cannot be made or undone (maps to HTTP 409)."""


@dataclass
class SplitLine:
    line_item_id: str
    description: str
    account_id: str
    amount: Decimal
    vat: Decimal
    from_invoice_account: bool


@dataclass
class Proposal:
    """One payment of an invoice, and how its journal would be split (or already is)."""

    transaction_id: str
    state: str  # ready | applied | not_journaled | unsupported
    reason: Optional[str] = None
    occurred_at: Optional[str] = None
    payment_amount: Optional[float] = None
    payment_currency: Optional[str] = None
    journal_amount: Optional[float] = None
    journal_currency: Optional[str] = None
    share_of_invoice: Optional[float] = None
    replaces: List[Dict[str, Any]] = field(default_factory=list)
    current_lines: List[Dict[str, Any]] = field(default_factory=list)
    lines: List[Dict[str, Any]] = field(default_factory=list)
    split_journal_id: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Working out the split (pure)
# ---------------------------------------------------------------------------


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0))


def _weight(line: Dict[str, Any]) -> Decimal:
    gross = line.get("line_gross")
    if gross is not None:
        return abs(_money(gross))
    net = _money(line.get("quantity")) * _money(line.get("unit_cost"))
    return abs(net * (1 + _money(line.get("vat_rate"))))


def _vat_share(line: Dict[str, Any]) -> Decimal:
    """The part of a line's gross that is VAT (0 to 1)."""
    gross = _weight(line)
    vat = abs(_money(line.get("line_vat")))
    return vat / gross if gross else Decimal(0)


def split_lines(
    invoice_lines: List[Dict[str, Any]],
    journal_amount: Decimal,
    fallback_account_id: str,
) -> List[SplitLine]:
    """The debit lines of a split: one per invoice line, adding up to ``journal_amount``.

    Raises SplitError when the invoice has no line with an amount to weigh by."""
    weighted = [(line, _weight(line)) for line in invoice_lines]
    weighted = [(line, w) for line, w in weighted if w > 0]
    total = sum((w for _, w in weighted), Decimal(0))
    if not weighted or total <= 0:
        raise SplitError("The invoice has no lines with an amount to split by.")

    amounts = [
        (journal_amount * w / total).quantize(CENT, rounding=ROUND_HALF_UP)
        for _, w in weighted
    ]
    # Rounding lands on the largest line, so the split adds up to the penny.
    largest = max(range(len(weighted)), key=lambda i: weighted[i][1])
    amounts[largest] += journal_amount - sum(amounts, Decimal(0))

    result = []
    for (line, _), amount in zip(weighted, amounts):
        account = line.get("gl_account_id")
        result.append(
            SplitLine(
                line_item_id=str(line["id"]),
                description=str(line.get("description") or "Invoice line"),
                account_id=str(account or fallback_account_id),
                amount=amount,
                vat=(amount * _vat_share(line)).quantize(CENT, rounding=ROUND_HALF_UP),
                from_invoice_account=bool(account),
            )
        )
    return result


def journal_lines(
    split: List[SplitLine],
    credit_lines: List[Dict[str, Any]],
    currency: str,
    gbp_total: Optional[Decimal],
    journal_amount: Decimal,
    invoice_number: str,
) -> List[Dict[str, Any]]:
    """The split journal's line items: the invoice's debit lines, then the payment's credit
    line(s) as they were. In a non-GBP journal each debit line's GBP equivalent is its share
    of the GBP the payment was booked at."""
    items: List[Dict[str, Any]] = []
    for line in split:
        item: Dict[str, Any] = {
            "account_id": line.account_id,
            "debit": float(line.amount),
            "credit": 0,
            "currency": currency,
            "description": f"{invoice_number}: {line.description}"[:255],
        }
        if gbp_total is not None and journal_amount:
            item["gbp_equivalent"] = float(
                (gbp_total * line.amount / journal_amount).quantize(Decimal("0.0001"))
            )
        items.append(item)
    for credit in credit_lines:
        kept = {
            "account_id": credit["account_id"],
            "debit": 0,
            "credit": float(_money(credit.get("credit"))),
            "currency": credit.get("currency") or currency,
            "description": credit.get("description"),
        }
        if credit.get("gbp_equivalent") is not None:
            kept["gbp_equivalent"] = float(_money(credit["gbp_equivalent"]))
        items.append(kept)
    return items


def balanced(items: List[Dict[str, Any]]) -> bool:
    debits = sum((_money(i.get("debit")) for i in items), Decimal(0))
    credits = sum((_money(i.get("credit")) for i in items), Decimal(0))
    return abs(debits - credits) < CENT


@dataclass
class Cut:
    """A split worked out for one journal: its debit lines and the journal's line items."""

    split: List[SplitLine]
    items: List[Dict[str, Any]]
    amount: Decimal
    currency: str


def cut(invoice: Dict[str, Any], journal: Dict[str, Any]) -> Cut:
    """Split ``journal`` (a payment's expense journal, with ``lines``) by the invoice's lines.

    The journal's debits are what is split; its credits are kept. Raises SplitError when there
    is nothing to split."""
    debits = [line for line in journal["lines"] if _money(line.get("debit")) > 0]
    credits = [line for line in journal["lines"] if _money(line.get("credit")) > 0]
    amount = sum((_money(line.get("debit")) for line in debits), Decimal(0))
    if not debits or not credits or amount <= 0:
        raise SplitError("The payment's journal has no amount to split.")
    currency = str(debits[0].get("currency") or "GBP")
    gbp = [line.get("gbp_equivalent") for line in debits]
    gbp_total = (
        sum((_money(g) for g in gbp), Decimal(0))
        if all(g is not None for g in gbp)
        else None
    )
    split = split_lines(
        invoice.get("invoice_line_items") or [], amount, str(debits[0]["account_id"])
    )
    items = journal_lines(
        split, credits, currency, gbp_total, amount, str(invoice["invoice_number"])
    )
    if not balanced(items):
        raise SplitError("The split does not balance.")
    return Cut(split=split, items=items, amount=amount, currency=currency)


def propose(
    invoice: Dict[str, Any],
    txn: Dict[str, Any],
    live: List[Dict[str, Any]],
    accounts: Dict[str, Dict[str, Any]],
) -> Proposal:
    """How one payment's journal would be split by the invoice, from what is stored.

    ``live`` is the payment's journals that are not reversed, each with ``lines``;
    ``accounts`` maps account id to its number and name, for showing."""
    proposal = Proposal(
        transaction_id=str(txn["id"]),
        state="unsupported",
        occurred_at=str(txn.get("occurred_at") or ""),
        payment_amount=float(abs(_money(txn.get("amount")))),
        payment_currency=txn.get("currency_code"),
    )
    gross = _money(invoice.get("gross_amount"))
    if gross and txn.get("currency_code") == invoice.get("currency"):
        proposal.share_of_invoice = float(
            (abs(_money(txn.get("amount"))) / gross).quantize(Decimal("0.0001"))
        )

    applied = [j for j in live if j.get("journal_type") == SPLIT]
    if applied:
        proposal.state = "applied"
        proposal.split_journal_id = str(applied[0]["id"])
        proposal.lines = [_shown(line, accounts) for line in applied[0]["lines"]]
        return proposal
    if txn.get("excluded_reason"):
        proposal.reason = "The payment is left out of the books, so it has no journal."
        return proposal
    if invoice.get("invoice_type") != "PURCHASE":
        proposal.reason = "Only purchases can be split for now."
        return proposal
    if not live:
        proposal.state = "not_journaled"
        proposal.reason = (
            "The payment has no journal yet. Generate journals, then split it."
        )
        return proposal
    if (
        any(j.get("journal_type") not in SPLITTABLE_TYPES for j in live)
        or len(live) != 1
    ):
        proposal.reason = "Only a payment journaled as one expense can be split."
        return proposal

    journal = live[0]
    try:
        made = cut(invoice, journal)
    except SplitError as error:
        proposal.reason = str(error)
        return proposal
    proposal.state = "ready"
    proposal.journal_amount = float(made.amount)
    proposal.journal_currency = made.currency
    proposal.replaces = [
        {
            "id": str(journal["id"]),
            "journal_type": journal["journal_type"],
            "status": journal["status"],
        }
    ]
    proposal.current_lines = [_shown(line, accounts) for line in journal["lines"]]
    debit_items = made.items[: len(made.split)]
    proposal.lines = [
        {
            **_shown(item, accounts),
            "line_item_id": line.line_item_id,
            "vat": float(line.vat),
            "from_invoice_account": line.from_invoice_account,
        }
        for line, item in zip(made.split, debit_items)
    ] + [_shown(item, accounts) for item in made.items[len(made.split) :]]
    return proposal


def _shown(line: Dict[str, Any], accounts: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    account = accounts.get(str(line.get("account_id"))) or {}
    return {
        "account_id": str(line.get("account_id")),
        "account_number": account.get("account_number"),
        "account_name": account.get("name"),
        "description": line.get("description"),
        "debit": float(_money(line.get("debit"))),
        "credit": float(_money(line.get("credit"))),
        "currency": line.get("currency"),
    }


# ---------------------------------------------------------------------------
# Reading, applying and undoing
# ---------------------------------------------------------------------------


def _client():
    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase is not configured")
    return client


async def _rows(query) -> List[Dict[str, Any]]:
    return extract_rows(await asyncio.to_thread(lambda: query.execute()))


async def _invoice(entity_id: UUID, invoice_id: UUID) -> Dict[str, Any]:
    row = extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoices")
            .select(
                "id, entity_id, invoice_number, invoice_type, status, currency, "
                "gross_amount, invoice_line_items(*), invoice_payments(financial_transaction_id)"
            )
            .eq("id", str(invoice_id))
            .eq("entity_id", str(entity_id))
            .execute()
        )
    )
    if not row:
        raise ValueError(f"Invoice not found: {invoice_id}")
    row["invoice_line_items"] = sorted(
        row.get("invoice_line_items") or [], key=lambda line: str(line["id"])
    )
    return row


async def _payment_state(
    entity_id: UUID, transaction_id: str
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """The transaction and its live (not reversed) journals, each with its lines."""
    txn = extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("financial_transactions")
            .select("id, occurred_at, amount, currency_code, excluded_reason")
            .eq("id", transaction_id)
            .eq("entity_id", str(entity_id))
            .execute()
        )
    )
    if not txn:
        raise ValueError(f"Transaction not found: {transaction_id}")
    journals = await _rows(
        _client()
        .table("journals")
        .select(
            "id, journal_type, status, journal_date, metadata, "
            "journal_line_items(account_id, debit, credit, currency, description, gbp_equivalent)"
        )
        .eq("entity_id", str(entity_id))
        .eq("source_type", "financial_transaction")
        .eq("source_id", transaction_id)
        .neq("status", "reversed")
    )
    for journal in journals:
        journal["lines"] = journal.pop("journal_line_items", None) or []
    return txn, journals


async def _accounts(ids: set) -> Dict[str, Dict[str, Any]]:
    if not ids:
        return {}
    rows = await _rows(
        _client()
        .table("chart_of_accounts")
        .select("id, account_number, name")
        .in_("id", sorted(ids))
    )
    return {str(r["id"]): r for r in rows}


async def proposals_for(entity_id: UUID, invoice_id: UUID) -> List[Dict[str, Any]]:
    """For each payment matched to the invoice: its split, worked out or already applied."""
    invoice = await _invoice(entity_id, invoice_id)
    found = []
    for link in invoice.get("invoice_payments") or []:
        txn, live = await _payment_state(entity_id, link["financial_transaction_id"])
        found.append((txn, live))
    ids = {
        str(line["gl_account_id"])
        for line in invoice["invoice_line_items"]
        if line.get("gl_account_id")
    }
    for _, live in found:
        ids.update(str(line["account_id"]) for j in live for line in j["lines"])
    accounts = await _accounts(ids)
    return [propose(invoice, txn, live, accounts).as_dict() for txn, live in found]


def _refusal(error: Exception) -> Exception:
    """A database refusal as a SplitError (409); anything else (a lost connection, a bug)
    is returned as it is, to be raised as a 500."""
    if "Accounting period is locked" in str(error):
        return SplitError(
            "That payment is in a locked accounting period, so its journal cannot change."
        )
    if getattr(error, "code", None) == "P0001":
        return SplitError(str(getattr(error, "message", None) or error))
    return error


async def apply_split(
    entity_id: UUID, invoice_id: UUID, transaction_id: UUID
) -> Dict[str, Any]:
    """Post the split for one payment of the invoice, voiding the journal it replaces."""
    invoice = await _invoice(entity_id, invoice_id)
    linked = {
        str(link["financial_transaction_id"])
        for link in invoice.get("invoice_payments") or []
    }
    if str(transaction_id) not in linked:
        raise SplitError("That transaction is not matched to this invoice.")
    txn, live = await _payment_state(entity_id, str(transaction_id))
    proposal = propose(invoice, txn, live, {})
    if proposal.state != "ready":
        raise SplitError(proposal.reason or "This payment's journal cannot be split.")

    journal = live[0]
    made = cut(invoice, journal)

    metadata = {
        "invoice_id": str(invoice_id),
        "invoice_number": invoice["invoice_number"],
        "lines": [
            {
                "line_item_id": line.line_item_id,
                "account_id": line.account_id,
                "amount": float(line.amount),
                "vat": float(line.vat),
            }
            for line in made.split
        ],
    }
    try:
        result = await asyncio.to_thread(
            lambda: _client()
            .rpc(
                "apply_invoice_split",
                {
                    "p_entity_id": str(entity_id),
                    "p_transaction_id": str(transaction_id),
                    "p_journal_date": str(journal["journal_date"])[:10],
                    "p_description": f"Split by invoice {invoice['invoice_number']}",
                    "p_metadata": metadata,
                    "p_line_items": made.items,
                    "p_replaces": [str(journal["id"])],
                },
            )
            .execute()
        )
    except Exception as error:
        raise _refusal(error) from error
    logger.info(
        f"Split journal {result.data} for transaction {transaction_id} by invoice "
        f"{invoice['invoice_number']}"
    )
    return {"journal_id": result.data, "replaced": [str(journal["id"])]}


async def undo_split(
    entity_id: UUID, invoice_id: UUID, transaction_id: UUID
) -> Dict[str, Any]:
    """Void the split on one payment and restore the journal it replaced."""
    _, live = await _payment_state(entity_id, str(transaction_id))
    split = next(
        (
            j
            for j in live
            if j.get("journal_type") == SPLIT
            and str((j.get("metadata") or {}).get("invoice_id")) == str(invoice_id)
        ),
        None,
    )
    if not split:
        raise SplitError("This payment's journal is not split by this invoice.")
    try:
        await asyncio.to_thread(
            lambda: _client()
            .rpc(
                "undo_invoice_split",
                {"p_entity_id": str(entity_id), "p_journal_id": str(split["id"])},
            )
            .execute()
        )
    except Exception as error:
        raise _refusal(error) from error
    return {"journal_id": str(split["id"]), "undone": True}
