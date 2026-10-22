"""Typed tools for the questions business owners ask most.

Each runs fixed, parameterised SQL as the signed-in user (`core/scoped_sql.run_trusted`,
row-level security on), and returns a structured dict that states the period and the
currency it used. The definitions are the ones the app's pages use, so the chat and
the page agree on a figure:

- Profit and loss: posted journals; revenue = credit - debit on `revenue` accounts,
  cost of sales and expenses = debit - credit on `cogs` and `expense` accounts;
  non-GBP lines count their `gbp_equivalent` and are skipped without one
  (`reports.server.ts`).
- Sales: orders that are not cancelled; net = grand total - refunded
  (`revenue-metrics.server.ts`, the Orders and Customers pages).
- Products: order line totals of orders that are not cancelled (Products page).
- Cash: each active account's balance snapshot plus the non-excluded transactions
  after it (`bank-balance.server.ts`).
- Invoices outstanding: OPEN and PARTIALLY_PAID; totals in GBP only (Invoices page).

Dates are YYYY-MM-DD and inclusive. With no dates, a tool uses the current financial
year (from the business's year end).

SQL here is fixed. Where an f-string builds it (marked `nosec B608`), it only inserts
fragments this module chooses (a filter clause, a column picked from a `Literal`, a fixed
expression); every value goes in as a psycopg2 parameter.
"""

import asyncio
import calendar
import datetime as dt
from typing import Any, Literal
from urllib.parse import urlencode

from langchain.tools import ToolRuntime, tool

from ..core.scoped_sql import QueryResult, run_trusted
from .identity import AgentUser, agent_user, json_safe, progress

# The ledger's reporting currency: report lines in another currency carry gbp_equivalent.
LEDGER_CURRENCY = "GBP"


async def _query(
    user: AgentUser,
    sql: str,
    params: tuple[Any, ...] | dict[str, Any] | None = None,
    max_rows: int = 200,
) -> QueryResult:
    return await asyncio.to_thread(
        run_trusted, user.user_id, sql, params, max_rows=max_rows
    )


async def _records(
    user: AgentUser,
    sql: str,
    params: tuple[Any, ...] | dict[str, Any] | None = None,
    max_rows: int = 200,
) -> list[dict[str, Any]]:
    result = await _query(user, sql, params, max_rows)
    return [json_safe(dict(zip(result.columns, row))) for row in result.rows]


def today() -> dt.date:
    """Today's date (a function so tests can fix it)."""
    return dt.date.today()


def financial_year(
    on: dt.date, year_end_month: int | None, year_end_day: int | None
) -> tuple[dt.date, dt.date]:
    """The financial year containing `on`, for a business with this year end."""
    month = year_end_month if year_end_month and 1 <= year_end_month <= 12 else 12
    wanted_day = year_end_day or 31

    def end_in(year: int) -> dt.date:
        return dt.date(
            year, month, min(wanted_day, calendar.monthrange(year, month)[1])
        )

    end = end_in(on.year)
    if end < on:
        end = end_in(on.year + 1)
    start = end_in(end.year - 1) + dt.timedelta(days=1)
    return start, end


def _parse_date(value: str | None, name: str) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be a date written YYYY-MM-DD.") from exc


async def load_profile(user: AgentUser) -> dict[str, Any]:
    rows = await _records(
        user,
        "select name, currency, country, vat_registered, year_end_month, year_end_day "
        "from entities where id = %s",
        (user.entity_id,),
        max_rows=1,
    )
    if not rows:
        raise PermissionError("The business for this account could not be found.")
    return rows[0]


async def load_coverage(user: AgentUser) -> list[dict[str, Any]]:
    """Which dates each kind of data covers, so nobody asks about an empty period."""
    return await _records(
        user,
        """
        select 'orders' as data, count(*) as rows,
               min(created_at)::date as first, max(created_at)::date as last
          from orders
        union all
        select 'posted journals', count(*), min(journal_date), max(journal_date)
          from journals where status = 'posted'
        union all
        select 'bank transactions', count(*),
               min(occurred_at)::date, max(occurred_at)::date
          from financial_transactions
        union all
        select 'invoices', count(*), min(invoice_date)::date, max(invoice_date)::date
          from invoices
        """,
    )


async def load_sources(user: AgentUser) -> list[dict[str, Any]]:
    """Which data sources are connected and when each last synced (no credentials)."""
    return await _records(
        user,
        "select provider, display_name, sync_status, "
        "sync_error is not null as has_error, last_synced_at "
        "from external_sources order by provider",
    )


async def _period(
    user: AgentUser, start_date: str | None, end_date: str | None
) -> tuple[dt.date, dt.date, dict[str, Any]]:
    """The inclusive period to report on, and the business profile."""
    start, end = _parse_date(start_date, "start_date"), _parse_date(
        end_date, "end_date"
    )
    profile = await load_profile(user)
    if start is None or end is None:
        fy_start, fy_end = financial_year(
            today(), profile.get("year_end_month"), profile.get("year_end_day")
        )
        start, end = start or fy_start, end or fy_end
    if start > end:
        raise ValueError("start_date is after end_date.")
    return start, end, profile


def _period_out(start: dt.date, end: dt.date) -> dict[str, str]:
    return {"start": start.isoformat(), "end": end.isoformat()}


def _bounds(start: dt.date, end: dt.date) -> tuple[str, str]:
    """Timestamps for `created_at >= a and created_at < b` (UTC, as the pages use)."""
    after_end = end + dt.timedelta(days=1)
    return f"{start.isoformat()}T00:00:00Z", f"{after_end.isoformat()}T00:00:00Z"


def _link(path: str, **params: Any) -> str:
    """A link into the app, with the page's own URL filters (empty ones left out)."""
    kept = {k: str(v) for k, v in params.items() if v}
    return f"{path}?{urlencode(kept)}" if kept else path


# ── business profile ────────────────────────────────────────────────────────────────


@tool
async def get_business_profile(runtime: ToolRuntime) -> dict[str, Any]:
    """The business: name, currency, country, VAT status, current financial year,
    today's date, and which dates its orders, ledger and bank data cover.

    Call it when you need the financial year, or to check whether there is any data
    for a period before saying there is none.
    """
    user = agent_user(runtime)
    progress(runtime, "Reading the business profile")
    profile = await load_profile(user)
    fy_start, fy_end = financial_year(
        today(), profile.get("year_end_month"), profile.get("year_end_day")
    )
    coverage = await load_coverage(user)
    return {
        "name": profile["name"],
        "currency": profile.get("currency") or LEDGER_CURRENCY,
        "ledger_currency": LEDGER_CURRENCY,
        "country": profile.get("country"),
        "vat_registered": profile.get("vat_registered"),
        "today": today().isoformat(),
        "financial_year": _period_out(fy_start, fy_end),
        "data_coverage": coverage,
    }


# ── ledger ──────────────────────────────────────────────────────────────────────────

# A line's natural credit-side amount in the ledger currency (see the module docstring).
_LINE_CREDIT_MINUS_DEBIT = """
    case
      when coalesce(upper(l.currency), 'GBP') = 'GBP' then l.credit - l.debit
      when l.gbp_equivalent is null then 0
      when l.debit > 0 then -l.gbp_equivalent
      else l.gbp_equivalent
    end
"""


@tool
async def profit_and_loss(
    runtime: ToolRuntime,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    """Profit and loss from the posted ledger: revenue, cost of sales, gross profit,
    expenses and net profit for a period, with the amount on each account.

    Dates are YYYY-MM-DD, inclusive; default is the current financial year.
    """
    user = agent_user(runtime)
    start, end, _ = await _period(user, start_date, end_date)
    progress(runtime, f"Reading the ledger, {start} to {end}")
    accounts = await _records(
        user,
        f"""
        select a.account_number, a.name as account, a.account_type as type,
               sum({_LINE_CREDIT_MINUS_DEBIT}) as credit_minus_debit,
               count(*) filter (
                 where coalesce(upper(l.currency), 'GBP') <> 'GBP'
                   and l.gbp_equivalent is null
               ) as skipped_lines
          from journal_line_items l
          join journals j on j.id = l.journal_id
          join chart_of_accounts a on a.id = l.account_id
         where j.status = 'posted'
           and a.is_header = false and a.status = 'active'
           and a.account_type in ('revenue', 'cogs', 'expense')
           and j.journal_date between %s and %s
         group by 1, 2, 3
         order by 3, 1
        """,  # nosec B608
        (start, end),
    )
    totals = {"revenue": 0.0, "cogs": 0.0, "expense": 0.0}
    lines = []
    skipped = 0
    for row in accounts:
        sign = 1 if row["type"] == "revenue" else -1
        amount = round(sign * float(row["credit_minus_debit"] or 0), 2)
        totals[row["type"]] += amount
        skipped += int(row["skipped_lines"] or 0)
        lines.append(
            {
                "account_number": row["account_number"],
                "account": row["account"],
                "type": row["type"],
                "amount": amount,
            }
        )
    revenue, cogs, expenses = (
        round(totals[k], 2) for k in ("revenue", "cogs", "expense")
    )
    return {
        "period": _period_out(start, end),
        "currency": LEDGER_CURRENCY,
        "basis": "posted journals",
        "revenue": revenue,
        "cost_of_sales": cogs,
        "gross_profit": round(revenue - cogs, 2),
        "expenses": expenses,
        "net_profit": round(revenue - cogs - expenses, 2),
        "accounts": lines,
        "skipped_foreign_lines_without_gbp_value": skipped,
        "link": _link("/reports", **{"from": start, "to": end}),
    }


# ── orders ──────────────────────────────────────────────────────────────────────────


@tool
async def sales_summary(
    runtime: ToolRuntime,
    start_date: str | None = None,
    end_date: str | None = None,
    by_month: bool = False,
) -> dict[str, Any]:
    """Order sales for a period: order count, gross total, refunds, net sales and
    average order value; optionally month by month. Cancelled orders are excluded.

    Dates are YYYY-MM-DD, inclusive; default is the current financial year.
    """
    user = agent_user(runtime)
    start, end, profile = await _period(user, start_date, end_date)
    progress(runtime, f"Reading orders, {start} to {end}")
    lower, upper = _bounds(start, end)
    group = "to_char(created_at at time zone 'UTC', 'YYYY-MM')" if by_month else "'all'"
    rows = await _records(
        user,
        f"""
        select {group} as month,
               count(*) as orders,
               coalesce(sum(grand_total_amount), 0) as gross,
               coalesce(sum(refunded_total_amount), 0) as refunds,
               coalesce(sum(grand_total_amount - coalesce(refunded_total_amount, 0)), 0)
                 as net_sales
          from orders
         where status is distinct from 'cancelled'
           and created_at >= %s and created_at < %s
         group by 1
         order by 1
        """,  # nosec B608
        (lower, upper),
    )

    def shape(row: dict[str, Any]) -> dict[str, Any]:
        orders = int(row["orders"])
        return {
            "orders": orders,
            "gross": row["gross"],
            "refunds": row["refunds"],
            "net_sales": row["net_sales"],
            "average_order_value": round(row["gross"] / orders, 2) if orders else 0,
        }

    total = {"orders": 0, "gross": 0.0, "refunds": 0.0, "net_sales": 0.0}
    for row in rows:
        for key in total:
            total[key] += row[key]
    out: dict[str, Any] = {
        "period": _period_out(start, end),
        "currency": profile.get("currency") or LEDGER_CURRENCY,
        **shape({k: round(v, 2) for k, v in total.items()}),
        "link": _link("/orders", **{"from": start, "to": end}),
    }
    if by_month:
        out["months"] = [{"month": r["month"], **shape(r)} for r in rows]
    return out


@tool
async def top_products(
    runtime: ToolRuntime,
    start_date: str | None = None,
    end_date: str | None = None,
    rank_by: Literal["revenue", "units"] = "revenue",
    limit: int = 5,
) -> dict[str, Any]:
    """Best-selling products in a period by revenue or units, from order lines of
    orders that were not cancelled.

    Dates are YYYY-MM-DD, inclusive; default is the current financial year.
    """
    user = agent_user(runtime)
    start, end, profile = await _period(user, start_date, end_date)
    progress(runtime, f"Ranking products, {start} to {end}")
    lower, upper = _bounds(start, end)
    order_by = "units" if rank_by == "units" else "revenue"
    products = await _records(
        user,
        f"""
        select l.product_name as product,
               min(l.product_id::text) as product_id,
               coalesce(sum(l.quantity), 0) as units,
               coalesce(sum(l.total_price_amount), 0) as revenue,
               count(distinct o.id) as orders
          from order_line_items l
          join orders o on o.id = l.order_id
         where o.status is distinct from 'cancelled'
           and o.created_at >= %s and o.created_at < %s
         group by 1
         order by {order_by} desc, 1
         limit %s
        """,  # nosec B608
        (lower, upper, max(1, min(limit, 50))),
    )
    return {
        "period": _period_out(start, end),
        "currency": profile.get("currency") or LEDGER_CURRENCY,
        "ranked_by": order_by,
        "products": products,
        "link": "/products",
    }


@tool
async def top_customers(
    runtime: ToolRuntime,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 5,
) -> dict[str, Any]:
    """Customers who spent the most in a period (net of refunds, cancelled orders
    excluded), with their order counts and last order date.

    Dates are YYYY-MM-DD, inclusive; default is the current financial year.
    """
    user = agent_user(runtime)
    start, end, profile = await _period(user, start_date, end_date)
    progress(runtime, f"Ranking customers, {start} to {end}")
    lower, upper = _bounds(start, end)
    customers = await _records(
        user,
        """
        select coalesce(nullif(trim(coalesce(c.first_name, '') || ' '
                                    || coalesce(c.last_name, '')), ''),
                        c.email, 'Unknown customer') as customer,
               c.id::text as customer_id,
               count(*) as orders,
               coalesce(sum(o.grand_total_amount
                            - coalesce(o.refunded_total_amount, 0)), 0) as spent,
               max(o.created_at)::date as last_order
          from orders o
          join customers c on c.id = o.customer_id
         where o.status is distinct from 'cancelled'
           and o.created_at >= %s and o.created_at < %s
         group by c.id, 1
         order by spent desc, 1
         limit %s
        """,
        (lower, upper, max(1, min(limit, 50))),
    )
    return {
        "period": _period_out(start, end),
        "currency": profile.get("currency") or LEDGER_CURRENCY,
        "customers": customers,
        "link": "/customers",
    }


# ── invoices ────────────────────────────────────────────────────────────────────────


@tool
async def outstanding_invoices(
    runtime: ToolRuntime,
    invoice_type: Literal["SALE", "PURCHASE"] | None = None,
    overdue_only: bool = False,
    limit: int = 20,
) -> dict[str, Any]:
    """Unpaid invoices as of today (OPEN or PARTIALLY_PAID): what customers owe the
    business (SALE) and what it owes suppliers (PURCHASE), overdue amounts, and the
    invoices themselves, oldest due first.

    Totals are in GBP; invoices in other currencies are counted separately.
    """
    user = agent_user(runtime)
    progress(runtime, "Reading unpaid invoices")
    as_of = today()
    type_filter = "and i.invoice_type = %(type)s" if invoice_type else ""
    # due_date and invoice_date are timestamps; compare and show them as dates.
    overdue_filter = "and i.due_date::date < %(today)s" if overdue_only else ""
    params = {"type": invoice_type, "today": as_of, "limit": max(1, min(limit, 100))}
    totals = await _records(
        user,
        f"""
        select i.invoice_type as type,
               count(*) filter (where coalesce(i.currency, 'GBP') = 'GBP') as count,
               coalesce(sum(i.gross_amount)
                 filter (where coalesce(i.currency, 'GBP') = 'GBP'), 0) as total,
               coalesce(sum(i.gross_amount)
                 filter (where coalesce(i.currency, 'GBP') = 'GBP'
                           and i.due_date::date < %(today)s), 0) as overdue,
               count(*) filter (where coalesce(i.currency, 'GBP') <> 'GBP')
                 as other_currency_count
          from invoices i
         where i.status in ('OPEN', 'PARTIALLY_PAID') {type_filter} {overdue_filter}
         group by 1
         order by 1
        """,  # nosec B608
        params,
    )
    invoices = await _records(
        user,
        f"""
        select i.id::text as id, i.invoice_number, i.invoice_type as type, i.status,
               coalesce(c.company_name, c.name) as counterparty,
               i.gross_amount, coalesce(i.currency, 'GBP') as currency,
               i.invoice_date::date as invoice_date, i.due_date::date as due_date,
               greatest(%(today)s - i.due_date::date, 0) as days_overdue
          from invoices i
          left join contacts c on c.id = i.counterparty_id
         where i.status in ('OPEN', 'PARTIALLY_PAID') {type_filter} {overdue_filter}
         order by i.due_date nulls last, i.invoice_number
         limit %(limit)s
        """,  # nosec B608
        params,
    )
    return {
        "as_of": as_of.isoformat(),
        "currency": LEDGER_CURRENCY,
        "totals": [
            {
                "type": t["type"],
                "meaning": "owed to you" if t["type"] == "SALE" else "you owe",
                **{k: v for k, v in t.items() if k != "type"},
            }
            for t in totals
        ],
        "invoices": invoices,
        "link": _link(
            "/invoices",
            tab="open",
            dir=invoice_type,
            view="overdue" if overdue_only else None,
        ),
    }


# ── bank ────────────────────────────────────────────────────────────────────────────


@tool
async def cash_position(runtime: ToolRuntime) -> dict[str, Any]:
    """Current balance of each active bank account and the total: the last balance
    from the bank plus the transactions recorded since then.
    """
    user = agent_user(runtime)
    progress(runtime, "Reading bank balances")
    accounts = await _records(
        user,
        """
        select b.name as account, b.currency, b.source,
               b.updated_at as balance_snapshot_at,
               coalesce(b.balance, 0) + coalesce((
                 select sum(case when t.direction = 'in' then 1 else -1 end
                            * coalesce(nullif(t.base_amount, 0), t.amount, 0))
                   from financial_transactions t
                  where t.bank_account_id = b.id
                    and t.status is distinct from 'excluded'
                    and (b.updated_at is null or t.occurred_at > b.updated_at)
               ), 0) as balance
          from bank_accounts b
         where b.state = 'active'
         order by balance desc
        """,
    )
    profile = await load_profile(user)
    return {
        "as_of": today().isoformat(),
        "currency": profile.get("currency") or LEDGER_CURRENCY,
        "total": round(sum(a["balance"] for a in accounts), 2),
        "accounts": accounts,
        "link": "/transactions",
    }


@tool
async def search_transactions(
    runtime: ToolRuntime,
    text: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    direction: Literal["in", "out"] | None = None,
    min_amount: float | None = None,
    max_amount: float | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Find bank transactions by words in the description or payee, date range,
    direction (in/out) and amount; newest first, with the count and total of all
    matches. Dates are YYYY-MM-DD, inclusive; with none, all dates are searched.
    """
    user = agent_user(runtime)
    progress(runtime, "Searching bank transactions")
    start, end = _parse_date(start_date, "start_date"), _parse_date(
        end_date, "end_date"
    )
    where = ["t.status is distinct from 'excluded'"]
    params: dict[str, Any] = {"limit": max(1, min(limit, 100))}
    if text and text.strip():
        escaped = (
            text.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        params["text"] = f"%{escaped}%"
        where.append(
            "(t.description ilike %(text)s or t.counterparty_name ilike %(text)s)"
        )
    if start:
        params["lower"] = _bounds(start, start)[0]
        where.append("t.occurred_at >= %(lower)s")
    if end:
        params["upper"] = _bounds(end, end)[1]
        where.append("t.occurred_at < %(upper)s")
    if direction:
        params["direction"] = direction
        where.append("t.direction = %(direction)s")
    amount = "coalesce(nullif(t.base_amount, 0), t.amount, 0)"
    if min_amount is not None:
        params["min"] = min_amount
        where.append(f"{amount} >= %(min)s")
    if max_amount is not None:
        params["max"] = max_amount
        where.append(f"{amount} <= %(max)s")
    condition = " and ".join(where)
    summary = await _records(
        user,
        f"""
        select count(*) as matches,
               coalesce(sum({amount}) filter (where t.direction = 'in'), 0) as total_in,
               coalesce(sum({amount}) filter (where t.direction = 'out'), 0) as total_out
          from financial_transactions t where {condition}
        """,  # nosec B608
        params,
        max_rows=1,
    )
    rows = await _records(
        user,
        f"""
        select t.id::text as id, t.occurred_at::date as date, t.description,
               t.counterparty_name as payee, t.direction,
               {amount} as amount,
               coalesce(t.base_currency_code, t.currency_code) as currency,
               b.name as account
          from financial_transactions t
          left join bank_accounts b on b.id = t.bank_account_id
         where {condition}
         order by t.occurred_at desc
         limit %(limit)s
        """,  # nosec B608
        params,
    )
    return {
        "filters": {
            "text": text,
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "direction": direction,
            "min_amount": min_amount,
            "max_amount": max_amount,
        },
        **summary[0],
        "transactions": rows,
        "link": _link(
            "/transactions",
            q=(text or "").strip(),
            **{"from": start, "to": end},
            direction=direction,
        ),
    }


DATA_TOOLS = [
    get_business_profile,
    profit_and_loss,
    sales_summary,
    top_products,
    top_customers,
    outstanding_invoices,
    cash_position,
    search_transactions,
]
