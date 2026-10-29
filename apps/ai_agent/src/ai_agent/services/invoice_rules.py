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

Synced invoices (``SYNCED_ORIGINS``) belong to their provider: their status comes from the
sync and their payment links, so a person cannot set it, change their direction or delete
them (``check_editable``).

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

# Where an invoice can come from. Uploads are the business's own documents; the rest are
# copies of what a provider holds, kept in step by a sync.
ORIGINS: FrozenSet[str] = frozenset({"upload", "revolut_merchant", "revolut_expense"})
SYNCED_ORIGINS: FrozenSet[str] = ORIGINS - {"upload"}

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


def check_deletable(status: str) -> None:
    """Raise InvoiceRuleError unless the invoice is a draft, cancelled or void."""
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


def check_editable(
    origin: Optional[str], change: Literal["status", "direction", "delete"]
) -> None:
    """Raise InvoiceRuleError if ``change`` is not the app's to make for this origin."""
    if (origin or "upload") not in SYNCED_ORIGINS:
        return
    what = {
        "status": "Its status follows Revolut and its matched payments",
        "direction": "Which side owes whom comes from Revolut",
        "delete": "It would come back on the next sync",
    }[change]
    raise InvoiceRuleError(f"This invoice is synced from Revolut. {what}.")
