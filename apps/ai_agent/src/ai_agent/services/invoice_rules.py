"""Pure business rules for invoices: no I/O, so they are cheap to test.

The invoice lifecycle:

    DRAFT ──► OPEN ──► PAID
      │         │ ╲
      │         │  ──► PARTIALLY_PAID ──► PAID
      │         ▼
      │      OVERDUE ──► PAID
      ▼
    CANCELLED / VOID   (terminal; a PAID invoice can only be voided or un-paid)

Invoices are documents, not ledger entries: no status posts or reverses a journal. The
money an invoice describes reaches the books through its bank or payment transaction, so
the status only says where the invoice stands. See ``InvoiceService.set_invoice_status``.

Payments decide paid. An invoice is linked to the transactions that settled it
(``invoice_payments``), and linking or unlinking one sets the status from what the links
cover (``status_from_payments``). Marking paid by hand is for money with no transaction
behind it, such as cash.

Synced invoices (``SYNCED_ORIGINS``) are not the app's to settle: a Revolut payment request's
status comes from Revolut, and an invoice read from a receipt was paid by the transaction the
receipt is on. So a person cannot set their status or change their direction
(``check_editable``). A payment request cannot be deleted either (the next sync would bring it
back), but an invoice read from a receipt can: the receipt stays on its transaction and is not
read again, so deleting one is how a person says "this is not an invoice". Their payments are
still linked, to show which transaction moved the money.

``OVERDUE`` is a status a person can set, but nothing sets it automatically, so an
invoice that is simply past its due date is still OPEN in the database.
``effective_status`` is the rule everything that *displays* a status should use.
"""

from datetime import date
from decimal import Decimal
from typing import Dict, FrozenSet, Iterable, Literal, Optional, Tuple, Union

VALID_STATUSES: FrozenSet[str] = frozenset(
    {"DRAFT", "OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}
)

# Where an invoice may go next. Same-status is handled by the caller as a no-op.
TRANSITIONS: Dict[str, FrozenSet[str]] = {
    "DRAFT": frozenset({"OPEN", "PAID", "CANCELLED", "VOID"}),
    "OPEN": frozenset({"PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}),
    "OVERDUE": frozenset({"OPEN", "PAID", "PARTIALLY_PAID", "CANCELLED", "VOID"}),
    "PARTIALLY_PAID": frozenset({"OPEN", "PAID", "OVERDUE", "VOID"}),
    # A mistaken "paid" can be undone; otherwise only VOID.
    "PAID": frozenset({"OPEN", "VOID"}),
    "CANCELLED": frozenset(),
    "VOID": frozenset(),
}

# Statuses an invoice can be deleted from; a live one is voided instead, to keep the record.
DELETABLE: FrozenSet[str] = frozenset({"DRAFT", "CANCELLED", "VOID"})

# Where an invoice can come from. Uploads are the business's own documents; the rest come
# from a sync: a payment request sent from Revolut, or a supplier invoice read from a receipt
# on a Revolut expense.
ORIGINS: FrozenSet[str] = frozenset({"upload", "revolut_merchant", "revolut_expense"})
SYNCED_ORIGINS: FrozenSet[str] = ORIGINS - {"upload"}

Change = Literal["status", "direction", "delete"]

# What a person may not change, per synced origin, and why.
LOCKED: Dict[str, Dict[str, str]] = {
    "revolut_merchant": {
        "status": "This invoice is synced from Revolut. Its status follows Revolut and "
        "its matched payments.",
        "direction": "This invoice is synced from Revolut. Which side owes whom comes "
        "from Revolut.",
        "delete": "This invoice is synced from Revolut. It would come back on the next "
        "sync.",
    },
    "revolut_expense": {
        "status": "This invoice was read from a Revolut receipt. It was paid by the "
        "transaction the receipt is on.",
        "direction": "This invoice was read from a receipt on money going out, so it is "
        "a purchase.",
    },
}

# Statuses a payment link can settle. A draft is still being checked and keeps its place in
# To review; a cancelled or void invoice is not owed.
PAYABLE: FrozenSet[str] = frozenset({"OPEN", "OVERDUE", "PARTIALLY_PAID", "PAID"})

# Linked payments within this share of the total count as paid in full, the same allowance
# reconciliation has always used (bank fees and rounding take a little off).
PAID_SHARE = Decimal("0.95")


class InvoiceRuleError(ValueError):
    """An invoice operation that the lifecycle rules forbid (maps to HTTP 409)."""


def normalise_status(status: Optional[str]) -> str:
    return (status or "").strip().upper()


def check_transition(current: str, target: str) -> None:
    """Raise InvoiceRuleError unless ``current`` → ``target`` is allowed.

    Staying in the same status is always fine (it is a no-op, and replaying a transition
    is how a half-failed one is retried).
    """
    current, target = normalise_status(current), normalise_status(target)
    if target not in VALID_STATUSES:
        raise InvoiceRuleError(f"Unknown status '{target}'")
    if current == target:
        return
    if target not in TRANSITIONS.get(current, frozenset()):
        allowed = sorted(TRANSITIONS.get(current, frozenset()))
        hint = (
            f"It can only become {', '.join(allowed)}."
            if allowed
            else f"A {current.lower()} invoice cannot change status."
        )
        raise InvoiceRuleError(
            f"Cannot move an invoice from {current} to {target}. {hint}"
        )


def check_deletable(status: str, origin: Optional[str] = None) -> None:
    """Raise InvoiceRuleError unless the invoice is a draft, cancelled or void.

    An invoice read from a receipt can go whatever its status: it is a reading of a file that
    stays on its transaction, so nothing is lost, and it is not read again.
    """
    if origin == "revolut_expense":
        return
    status = normalise_status(status)
    if status not in DELETABLE:
        raise InvoiceRuleError(
            f"A {status.lower().replace('_', ' ')} invoice cannot be deleted. "
            "Void it instead: that keeps the record."
        )


def effective_status(
    status: Optional[str],
    due_date: Union[str, date, None],
    today: Optional[date] = None,
) -> str:
    """The status to show: an unpaid, finalised invoice past its due date is OVERDUE."""
    status = normalise_status(status)
    if status not in {"OPEN", "PARTIALLY_PAID"} or not due_date:
        return status
    due = (
        due_date
        if isinstance(due_date, date)
        else date.fromisoformat(str(due_date)[:10])
    )
    return "OVERDUE" if due < (today or date.today()) else status


def status_from_payments(
    current: Optional[str],
    gross: Union[Decimal, float, int, str, None],
    currency: Optional[str],
    payments: Iterable[Tuple[Union[Decimal, float, int, str], Optional[str]]],
) -> str:
    """The status an invoice's payment links imply, given ``(amount, currency)`` pairs.

    Drafts, cancelled and void invoices keep their status. Otherwise no links means OPEN
    (an overdue invoice stays OVERDUE), links covering the total mean PAID and less means
    PARTIALLY_PAID. A payment in another currency cannot be compared, so an invoice with
    one is taken as paid: the person or sync that linked it said so.
    """
    current = normalise_status(current)
    if current not in PAYABLE:
        return current
    linked = list(payments)
    if not linked:
        return current if current in {"OPEN", "OVERDUE"} else "OPEN"
    own = normalise_status(currency)
    if any(normalise_status(c) != own for _, c in linked):
        return "PAID"
    paid = sum((Decimal(str(a)) for a, _ in linked), Decimal(0))
    total = Decimal(str(gross or 0))
    return "PAID" if paid >= total * PAID_SHARE else "PARTIALLY_PAID"


def check_editable(origin: Optional[str], change: Change) -> None:
    """Raise InvoiceRuleError if ``change`` is not the app's to make for this origin."""
    reason = LOCKED.get(origin or "upload", {}).get(change)
    if reason:
        raise InvoiceRuleError(reason)
