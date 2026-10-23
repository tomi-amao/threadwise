"""Changes the agent can propose, and only the user can approve.

The agent never writes by itself. An action tool does four things, in this order:

1. Reads the record **as the signed-in user** (row-level security on) and refuses,
   without bothering the user, anything that cannot work: a record that is not theirs, a
   move the lifecycle rules forbid, an account that is not postable.
2. Builds what the user will see from that read: the title, what changes, from what to
   what. The model's words never appear in it.
3. Pauses on an interrupt (`ui/catalogue.Proposal`). Nothing has been written. The run
   can stay paused for as long as the user likes; if they never answer, nothing happens.
4. Only on approval, calls the **existing REST endpoint** through the app itself, with
   the user's own token. The endpoint, not the agent, enforces the rules (guards,
   ownership, the invoice lifecycle, the ledger), so the agent can do nothing a
   signed-in user could not do from the page.

A tool restarts from its top when the run resumes, which is why steps 1 and 2 only read
and the write comes after the interrupt.
"""

import asyncio
import logging
from typing import Any, Literal
from uuid import UUID

import httpx
from langchain.tools import ToolRuntime, tool
from langgraph.types import interrupt

from ..core.scoped_sql import run_trusted
from ..services.invoice_rules import InvoiceRuleError, check_transition
from ..ui.catalogue import Change, Proposal
from .identity import AgentUser, agent_user, json_safe

logger = logging.getLogger(__name__)

INVOICE_STATUS_LABELS = {
    "OPEN": "open",
    "PAID": "paid",
    "CANCELLED": "cancelled",
    "VOID": "void",
}

# What a move does to the ledger, in words for the person approving it.
INVOICE_CONSEQUENCES = {
    ("DRAFT", "OPEN"): "Finalises it and posts its journal.",
    ("PAID", "OPEN"): "Takes the payment back: voids the payment journal.",
    ("OPEN", "PAID"): "Posts the payment journal.",
    ("PARTIALLY_PAID", "PAID"): "Posts the payment journal.",
    ("OVERDUE", "PAID"): "Posts the payment journal.",
    ("DRAFT", "PAID"): "Finalises it and posts its journal and its payment journal.",
}
VOIDING = "Voids every journal this invoice posted. This cannot be undone."


def approved(answer: Any) -> bool:
    """Did the user approve? Anything but an explicit approval is a no."""
    return isinstance(answer, dict) and answer.get("decision") == "approve"


def ask(proposal: Proposal) -> bool:
    """Pause for the user's decision; True only if they approved."""
    return approved(interrupt(proposal.model_dump(mode="json")))


async def call_app(
    user: AgentUser,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
) -> httpx.Response:
    """Call one of the app's own endpoints as the user, in process (no network hop).

    The request goes through the whole app: the same guards, ownership checks and business
    rules as a call from the browser. Without the user's token it does not go at all.
    """
    if not user.access_token:
        raise PermissionError("This run cannot act on the user's behalf.")
    from ..main import app  # late: main imports the routes, which import tools

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://app", timeout=60
    ) as client:
        return await client.request(
            method,
            path,
            json=json,
            headers={"Authorization": f"Bearer {user.access_token}"},
        )


def _why(response: httpx.Response) -> str:
    """The reason an endpoint refused, as plain text (its `detail`)."""
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    if isinstance(detail, str) and detail:
        return detail
    return f"The app answered {response.status_code}."


async def _read(user: AgentUser, sql: str, params: tuple[Any, ...]) -> list[dict]:
    result = await asyncio.to_thread(run_trusted, user.user_id, sql, params, max_rows=5)
    return [json_safe(dict(zip(result.columns, row))) for row in result.rows]


def _uuid(value: str, what: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise ValueError(f"{what} must be the id from a tool result.") from exc


@tool
async def set_invoice_status(
    invoice_id: str,
    status: Literal["OPEN", "PAID", "CANCELLED", "VOID"],
    runtime: ToolRuntime,
) -> dict[str, Any]:
    """Propose moving an invoice to a new status (OPEN, PAID, CANCELLED or VOID).

    The user is shown exactly what will change and must approve it; nothing happens
    otherwise. `invoice_id` is the invoice's id (from a tool result or the page), not its
    number. Say what you are proposing in one sentence and wait: do not claim it is done
    until this returns `done: true`.
    """
    user = agent_user(runtime)
    invoice_id = _uuid(invoice_id, "invoice_id")
    found = await _read(
        user,
        """
        select i.invoice_number, i.status, i.invoice_type, i.gross_amount,
               coalesce(i.currency, 'GBP') as currency,
               coalesce(c.company_name, c.name) as counterparty
          from invoices i left join contacts c on c.id = i.counterparty_id
         where i.id = %s
        """,
        (invoice_id,),
    )
    if not found:
        return {"done": False, "reason": "No such invoice for this business."}
    invoice = found[0]
    current = str(invoice["status"]).upper()
    if current == status:
        return {"done": False, "reason": f"It is already {status.lower()}."}
    try:
        check_transition(current, status)
    except InvoiceRuleError as exc:
        return {"done": False, "reason": str(exc)}

    consequence = INVOICE_CONSEQUENCES.get((current, status)) or (
        VOIDING if status in ("CANCELLED", "VOID") else None
    )
    who = f"{invoice['counterparty']}, " if invoice["counterparty"] else ""
    proposal = Proposal(
        action="set_invoice_status",
        title=(
            f"Mark invoice {invoice['invoice_number']} "
            f"as {INVOICE_STATUS_LABELS[status]}"
        ),
        description=(
            f"{who}{invoice['currency']} {invoice['gross_amount']:,.2f}. {consequence}"
            if consequence
            else f"{who}{invoice['currency']} {invoice['gross_amount']:,.2f}."
        ),
        changes=[
            Change(
                label="Status",
                before=current.replace("_", " ").capitalize(),
                after=INVOICE_STATUS_LABELS[status].capitalize(),
            )
        ],
        link=f"/invoices?invoice={invoice_id}",
        approve_label=f"Mark as {INVOICE_STATUS_LABELS[status]}",
        dismiss_label="Leave it",
    )
    if not ask(proposal):
        return {
            "done": False,
            "declined": True,
            "note": "Declined. Nothing was changed.",
        }

    response = await call_app(
        user,
        "PATCH",
        f"/accounting/invoices/{invoice_id}/status",
        json={"entity_id": user.entity_id, "status": status},
    )
    if response.status_code >= 400:
        return {"done": False, "reason": _why(response)}
    return {
        "done": True,
        "invoice": invoice["invoice_number"],
        "status": status,
        "link": f"/invoices?invoice={invoice_id}",
    }


@tool
async def categorise_transaction(
    transaction_id: str, account_number: str, runtime: ToolRuntime
) -> dict[str, Any]:
    """Propose assigning a ledger account (a chart of accounts number, e.g. "8010") to a
    bank transaction, which decides where its journal is posted.

    The user is shown exactly what will change and must approve it; nothing happens
    otherwise. `transaction_id` is the transaction's id (from search_transactions or the
    page). Do not claim it is done until this returns `done: true`.
    """
    user = agent_user(runtime)
    transaction_id = _uuid(transaction_id, "transaction_id")
    account_number = account_number.strip()
    found = await _read(
        user,
        """
        select t.occurred_at::date as day, t.description, t.amount, t.direction,
               coalesce(t.currency_code, 'GBP') as currency,
               t.metadata->>'expense_category' as category,
               t.metadata->>'account_code' as code
          from financial_transactions t where t.id = %s
        """,
        (transaction_id,),
    )
    if not found:
        return {"done": False, "reason": "No such transaction for this business."}
    txn = found[0]
    accounts = await _read(
        user,
        "select account_number, name, account_type, is_header, status "
        "from chart_of_accounts where account_number = %s",
        (account_number,),
    )
    if not accounts:
        return {"done": False, "reason": f"There is no account {account_number}."}
    account = accounts[0]
    if account["is_header"] or account["status"] != "active":
        return {
            "done": False,
            "reason": f"Account {account_number} cannot be posted to.",
        }
    if txn["code"] == account["account_number"]:
        return {"done": False, "reason": "It is already categorised that way."}

    before = f"{txn['category'] or 'Uncategorised'}" + (
        f" ({txn['code']})" if txn["code"] else ""
    )
    proposal = Proposal(
        action="categorise_transaction",
        title=f"Categorise “{(txn['description'] or 'this transaction')[:60]}”",
        description=(
            f"{txn['day']}, {txn['direction']}, {txn['currency']} {txn['amount']:,.2f}. "
            "Sets where its journal is posted; a journal already posted for it "
            "is not changed."
        ),
        changes=[
            Change(
                label="Account",
                before=before,
                after=f"{account['name']} ({account['account_number']})",
            )
        ],
        link=f"/transactions?transactionId={transaction_id}",
        approve_label="Categorise",
        dismiss_label="Leave it",
    )
    if not ask(proposal):
        return {
            "done": False,
            "declined": True,
            "note": "Declined. Nothing was changed.",
        }

    response = await call_app(
        user,
        "PUT",
        f"/integrations/transactions/{transaction_id}/category",
        json={"account_number": account_number},
    )
    if response.status_code >= 400:
        return {"done": False, "reason": _why(response)}
    return {
        "done": True,
        "account": f"{account['name']} ({account['account_number']})",
        "link": f"/transactions?transactionId={transaction_id}",
    }


ACTION_TOOLS = [set_invoice_status, categorise_transaction]
ACTION_TOOL_NAMES = frozenset(t.name for t in ACTION_TOOLS)
