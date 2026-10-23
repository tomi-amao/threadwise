"""What the user is looking at, so "why is this invoice unmatched?" works without naming
it.

The browser sends a small context with each run: the page, its URL filters, and the
record open in a drawer (type, id, a label). **None of that is trusted.** The id is only
a name for a record: the server reads it again as the signed-in user (row-level security
on, so another business's id finds nothing) and builds the summary the model sees from
that read. The label the browser sent is never used. Imported text inside the summary (a
counterparty or product name) is data, and is fenced as such in the prompt.
"""

import asyncio
import logging
import re
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..core.scoped_sql import run_trusted
from ..tools.identity import AgentUser, json_safe

logger = logging.getLogger(__name__)

# SQL fragments shared by the readers below: fixed text, never built from input.
FULL_NAME = (
    "nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')"
)
LIVE = "o.status is distinct from 'cancelled'"

RecordType = Literal["invoice", "order", "customer", "product", "transaction"]


class PageRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: RecordType
    id: str

    @field_validator("id")
    @classmethod
    def _uuid(cls, value: str) -> str:
        return str(UUID(value))  # a malformed id is refused before it reaches SQL


class PageContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    route: str = Field(max_length=200)
    page: str = Field(default="", max_length=40)
    filters: dict[str, str] = Field(default_factory=dict, max_length=10)
    record: PageRecord | None = None

    @field_validator("route")
    @classmethod
    def _path(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//"):
            raise ValueError("route must be a path inside the app")
        return value


def parse_context(raw: Any) -> PageContext | None:
    """The browser's page context if it is well formed; None (not an error) if not."""
    if not isinstance(raw, dict):
        return None
    try:
        return PageContext.model_validate(raw)
    except (ValidationError, ValueError):
        logger.info("Ignoring a malformed page context")
        return None


def _clean(text: Any, limit: int = 80) -> str:
    """Text from the browser or the data, flattened so it cannot pose as a prompt line."""
    return re.sub(r"\s+", " ", str(text)).strip()[:limit]


async def _rows(user: AgentUser, sql: str, params: tuple[Any, ...]) -> list[dict]:
    result = await asyncio.to_thread(
        run_trusted, user.user_id, sql, params, max_rows=12
    )
    return [json_safe(dict(zip(result.columns, row))) for row in result.rows]


def _money(row: dict, key: str, currency: str = "GBP") -> str:
    return f"{currency} {row[key]:,.2f}" if row.get(key) is not None else "n/a"


async def _invoice(user: AgentUser, record_id: str) -> list[str]:
    found = await _rows(
        user,
        """
        select i.id::text, i.invoice_number, i.invoice_type, i.status, i.gross_amount,
               coalesce(i.currency, 'GBP') as currency, i.invoice_date::date as issued,
               i.due_date::date as due,
               coalesce(c.company_name, c.name) as counterparty
          from invoices i left join contacts c on c.id = i.counterparty_id
         where i.id = %s
        """,
        (record_id,),
    )
    if not found:
        return []
    inv = found[0]
    sale = inv["invoice_type"] == "SALE"
    lines = [
        f"Invoice {inv['invoice_number']} ({'sale' if sale else 'purchase'}), "
        f"status {inv['status']}, {_money(inv, 'gross_amount', inv['currency'])}, "
        f"issued {inv['issued']}, due {inv['due']}, "
        f"{'customer' if sale else 'supplier'} "
        f"{_clean(inv['counterparty'] or 'unknown')}."
    ]
    matched = await _rows(
        user,
        """
        select t.occurred_at::date as day, t.description, t.amount,
               coalesce(t.currency_code, 'GBP') as currency
          from financial_transactions t
         where t.metadata->>'invoice_id' = %s and t.excluded_reason is null
         limit 1
        """,
        (inv["invoice_number"],),
    )
    if matched:
        m = matched[0]
        lines.append(
            f"Matched bank payment: {m['day']}, {_money(m, 'amount', m['currency'])}, "
            f"{_clean(m['description'] or '')}."
        )
    elif inv["status"] not in ("DRAFT", "CANCELLED", "VOID") and inv["gross_amount"]:
        lines.append("No bank payment is matched to it.")
        candidates = await _rows(
            user,
            """
            select t.occurred_at::date as day, t.description, t.amount,
                   coalesce(t.currency_code, 'GBP') as currency
              from financial_transactions t
             where t.direction = %s and t.currency_code = %s
               and t.excluded_reason is null
               and t.amount between %s * 0.9 and %s * 1.1
               and coalesce(t.metadata->>'invoice_id', '') = ''
             order by abs(t.amount - %s), t.occurred_at desc
             limit 3
            """,
            (
                "in" if inv["invoice_type"] == "SALE" else "out",
                inv["currency"],
                inv["gross_amount"],
                inv["gross_amount"],
                inv["gross_amount"],
            ),
        )
        if candidates:
            lines.append(
                "Bank payments within 10% of the amount that could be it: "
                + "; ".join(
                    f"{c['day']} {_money(c, 'amount', c['currency'])} "
                    f"{_clean(c['description'] or '', 50)}"
                    for c in candidates
                )
                + "."
            )
        else:
            lines.append("No bank payment is within 10% of its amount.")
    journals = await _rows(
        user,
        """
        select journal_type, status, journal_date::date as day
          from journals where source_id::text = %s order by journal_date limit 5
        """,
        (inv["id"],),
    )
    if journals:
        lines.append(
            "Journals: "
            + "; ".join(
                f"{j['journal_type']} {j['status']} {j['day']}" for j in journals
            )
            + "."
        )
    return lines


async def _order(user: AgentUser, record_id: str) -> list[str]:
    found = await _rows(
        user,
        f"""
        select o.order_number, o.status, o.grand_total_amount, o.refunded_total_amount,
               o.created_at::date as day,
               {FULL_NAME}
                 as customer
          from orders o left join customers c on c.id = o.customer_id
         where o.id = %s
        """,  # nosec B608
        (record_id,),
    )
    if not found:
        return []
    o = found[0]
    lines = [
        f"Order {o['order_number']}, status {o['status']}, placed {o['day']}, "
        f"total {_money(o, 'grand_total_amount')}"
        + (
            f", refunded {_money(o, 'refunded_total_amount')}"
            if o["refunded_total_amount"]
            else ""
        )
        + (f", customer {_clean(o['customer'])}" if o["customer"] else "")
        + "."
    ]
    items = await _rows(
        user,
        "select product_name, quantity, total_price_amount from order_line_items "
        "where order_id = %s order by total_price_amount desc limit 10",
        (record_id,),
    )
    if items:
        lines.append(
            "Lines: "
            + "; ".join(
                f"{_clean(i['product_name'], 50)} x{i['quantity']} "
                f"({_money(i, 'total_price_amount')})"
                for i in items
            )
            + "."
        )
    return lines


async def _customer(user: AgentUser, record_id: str) -> list[str]:
    found = await _rows(
        user,
        f"""
        select {FULL_NAME}
                 as name,
               count(o.id) filter (where o.status is distinct from 'cancelled') as orders,
               coalesce(sum(o.grand_total_amount - coalesce(o.refunded_total_amount, 0))
                 filter (where o.status is distinct from 'cancelled'), 0) as spent,
               max(o.created_at)::date as last_order
          from customers c left join orders o on o.customer_id = c.id
         where c.id = %s group by c.id
        """,  # nosec B608
        (record_id,),
    )
    if not found:
        return []
    c = found[0]
    return [
        f"Customer {_clean(c['name'] or 'unnamed')}: {c['orders']} orders, "
        f"{_money(c, 'spent')} net of refunds"
        + (f", last order {c['last_order']}" if c["last_order"] else "")
        + "."
    ]


async def _product(user: AgentUser, record_id: str) -> list[str]:
    found = await _rows(
        user,
        f"""
        select p.name, p.product_type, p.status,
               coalesce(sum(l.quantity) filter (where {LIVE}), 0)
                 as units,
               coalesce(sum(l.total_price_amount)
                 filter (where {LIVE}), 0) as revenue
          from products p
          left join order_line_items l on l.product_id = p.id
          left join orders o on o.id = l.order_id
         where p.id = %s group by p.id
        """,  # nosec B608
        (record_id,),
    )
    if not found:
        return []
    p = found[0]
    return [
        f"Product {_clean(p['name'])} ({_clean(p['product_type'] or 'no type')}, "
        f"status {p['status']}): {p['units']} units sold, {_money(p, 'revenue')} revenue."
    ]


async def _transaction(user: AgentUser, record_id: str) -> list[str]:
    found = await _rows(
        user,
        """
        select t.occurred_at::date as day, t.description, t.counterparty_name as payee,
               t.direction, t.amount, coalesce(t.currency_code, 'GBP') as currency,
               t.status, t.excluded_reason, t.metadata->>'expense_category' as category,
               t.metadata->>'invoice_id' as invoice,
               t.journalised_at is not null as journalised
          from financial_transactions t where t.id = %s
        """,
        (record_id,),
    )
    if not found:
        return []
    t = found[0]
    parts = [
        f"Bank transaction {t['day']}, {t['direction']}, "
        f"{_money(t, 'amount', t['currency'])}, "
        f"{_clean(t['description'] or 'no description')}"
        + (f" ({_clean(t['payee'])})" if t["payee"] else ""),
        f"status {t['status']}"
        + (
            f", excluded: {_clean(t['excluded_reason'])}"
            if t["excluded_reason"]
            else ""
        ),
        f"category {_clean(t['category'])}" if t["category"] else "no category",
        (
            f"matched to invoice {_clean(t['invoice'])}"
            if t["invoice"]
            else "not matched to an invoice"
        ),
        "journalised" if t["journalised"] else "not journalised yet",
    ]
    return [", ".join(parts) + "."]


_READERS = {
    "invoice": _invoice,
    "order": _order,
    "customer": _customer,
    "product": _product,
    "transaction": _transaction,
}


async def describe_page(user: AgentUser, context: PageContext) -> str:
    """The text the model sees about the page, built from what the server could read."""
    page = _clean(context.page or context.route, 40)
    lines = [f"Page: {page} ({_clean(context.route, 120)})."]
    if context.filters:
        lines.append(
            "Filters on the page: "
            + ", ".join(
                f"{_clean(k, 20)}={_clean(v, 40)}" for k, v in context.filters.items()
            )
            + "."
        )
    if context.record:
        try:
            facts = await _READERS[context.record.type](user, context.record.id)
        except (
            Exception
        ) as exc:  # the page is a convenience; never fail the turn for it
            logger.warning("Page record not read: %s", type(exc).__name__)
            facts = []
        if facts:
            lines += ["The record open on the page:", *facts]
        else:
            lines.append(
                f"A {context.record.type} is open on the page, but it could not be read."
            )
    return "\n".join(lines)
