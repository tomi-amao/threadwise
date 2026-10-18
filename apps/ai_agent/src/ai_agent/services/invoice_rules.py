"""Pure business rules for invoices: no I/O, so they are cheap to test.

The invoice lifecycle:

    DRAFT ──► OPEN ──► PAID
      │         │ ╲
      │         │  ──► PARTIALLY_PAID ──► PAID
      │         ▼
      │      OVERDUE ──► PAID
      ▼
    CANCELLED / VOID   (terminal; a PAID invoice can only be voided or un-paid)

A DRAFT is a document, not an obligation: uploading one posts nothing. Leaving DRAFT
posts the purchase/sale journal; PAID posts the payment journal. CANCELLED and VOID undo
whatever was posted. See ``InvoiceService.set_invoice_status``.

``OVERDUE`` is a status a person can set, but nothing sets it automatically, so an
invoice that is simply past its due date is still OPEN in the database.
``effective_status`` is the rule everything that *displays* a status should use.
"""

from datetime import date
from typing import Dict, FrozenSet, Optional, Union

VALID_STATUSES: FrozenSet[str] = frozenset(
    {"DRAFT", "OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}
)

# Where an invoice may go next. Same-status is handled by the caller as a no-op.
TRANSITIONS: Dict[str, FrozenSet[str]] = {
    "DRAFT": frozenset({"OPEN", "PAID", "CANCELLED", "VOID"}),
    "OPEN": frozenset({"PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}),
    "OVERDUE": frozenset({"OPEN", "PAID", "PARTIALLY_PAID", "CANCELLED", "VOID"}),
    "PARTIALLY_PAID": frozenset({"OPEN", "PAID", "OVERDUE", "VOID"}),
    # A mistaken "paid" can be undone (its payment journal is voided); else only VOID.
    "PAID": frozenset({"OPEN", "VOID"}),
    "CANCELLED": frozenset(),
    "VOID": frozenset(),
}

# Statuses at which the purchase/sale journal should exist.
FINALISED: FrozenSet[str] = frozenset({"OPEN", "OVERDUE", "PARTIALLY_PAID", "PAID"})
# Statuses whose payment journal should exist.
SETTLED: FrozenSet[str] = frozenset({"PAID"})
# Statuses an invoice can be deleted from (and only if nothing is posted against it).
DELETABLE: FrozenSet[str] = frozenset({"DRAFT", "CANCELLED", "VOID"})


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


def check_deletable(status: str, has_posted_journals: bool) -> None:
    """Raise InvoiceRuleError unless the invoice can go without orphaning the ledger."""
    status = normalise_status(status)
    if status not in DELETABLE:
        raise InvoiceRuleError(
            f"A {status.lower().replace('_', ' ')} invoice cannot be deleted. "
            "Void it instead: that keeps the record and removes its effect on the books."
        )
    if has_posted_journals:
        raise InvoiceRuleError(
            "This invoice still has posted journals. Void it so they are reversed, "
            "rather than deleting the record they point at."
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
