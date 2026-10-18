"""Tool result -> UI components. Pure functions: no model, no I/O.

The chart or table under an answer is built from exactly the rows the tool returned, never
from what the model wrote, so the two cannot disagree. Each presenter takes the tool's
arguments and its (JSON) result and returns the components to show, in order. A tool with
no presenter, or a result that is an error, shows nothing.
"""

from typing import Any, Callable
from urllib.parse import urlencode

from .catalogue import (
    BarChart,
    BarPoint,
    Column,
    Metric,
    MetricDetail,
    Period,
    Props,
    Source,
    SummaryList,
    SummaryRow,
    Table,
)

Presenter = Callable[[dict[str, Any], dict[str, Any]], list[tuple[str, Props]]]

MAX_TABLE_ROWS = 50


def _period(result: dict[str, Any]) -> Period | None:
    period = result.get("period") or {}
    if period.get("start") and period.get("end"):
        return Period(start=period["start"], end=period["end"])
    return None


def _source(tool: str, label: str, result: dict[str, Any]) -> Source:
    return Source(
        tool=tool,
        label=label,
        period=_period(result),
        as_of=result.get("as_of"),
        link=result.get("link"),
    )


def _with_query(path: str, **params: str) -> str:
    return f"{path}?{urlencode(params)}"


def profit_and_loss(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    rows = [
        SummaryRow(label="Revenue", value=result["revenue"]),
        SummaryRow(label="Cost of sales", value=result["cost_of_sales"], deduct=True),
        SummaryRow(label="Gross profit", value=result["gross_profit"], kind="total"),
        SummaryRow(label="Expenses", value=result["expenses"], deduct=True),
        SummaryRow(label="Net profit", value=result["net_profit"], kind="grand"),
    ]
    return [
        (
            "summary-list",
            SummaryList(
                title="Profit and loss",
                currency=result.get("currency"),
                rows=rows,
                source=_source("profit_and_loss", "Posted journals", result),
            ),
        )
    ]


def sales_summary(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    source = _source("sales_summary", "Orders, not cancelled", result)
    months = result.get("months") or []
    if months:
        return [
            (
                "bar-chart",
                BarChart(
                    title="Net sales by month",
                    currency=result.get("currency"),
                    points=[
                        BarPoint(label=m["month"], value=m["net_sales"]) for m in months
                    ][-60:],
                    source=source,
                ),
            )
        ]
    return [
        (
            "metric",
            Metric(
                label="Net sales",
                value=result["net_sales"],
                currency=result.get("currency"),
                details=[
                    MetricDetail(label="Orders", value=result["orders"]),
                    MetricDetail(
                        label="Average order",
                        value=result["average_order_value"],
                        format="money",
                    ),
                    MetricDetail(
                        label="Refunds", value=result["refunds"], format="money"
                    ),
                ],
                source=source,
            ),
        )
    ]


def top_products(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    products = result.get("products") or []
    if not products:
        return []
    return [
        (
            "table",
            Table(
                title=f"Top products by {result.get('ranked_by', 'revenue')}",
                columns=[
                    Column(key="product", label="Product"),
                    Column(key="units", label="Units", format="number"),
                    Column(key="orders", label="Orders", format="number"),
                    Column(key="revenue", label="Revenue", format="money"),
                ],
                rows=[
                    {k: p.get(k) for k in ("product", "units", "orders", "revenue")}
                    for p in products[:MAX_TABLE_ROWS]
                ],
                row_links=[
                    (
                        _with_query("/products", product=p["product_id"])
                        if p.get("product_id")
                        else None
                    )
                    for p in products[:MAX_TABLE_ROWS]
                ],
                currency=result.get("currency"),
                source=_source("top_products", "Order lines, not cancelled", result),
            ),
        )
    ]


def top_customers(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    customers = result.get("customers") or []
    if not customers:
        return []
    return [
        (
            "table",
            Table(
                title="Top customers",
                columns=[
                    Column(key="customer", label="Customer"),
                    Column(key="orders", label="Orders", format="number"),
                    Column(key="last_order", label="Last order", format="date"),
                    Column(key="spent", label="Spent", format="money"),
                ],
                rows=[
                    {k: c.get(k) for k in ("customer", "orders", "last_order", "spent")}
                    for c in customers[:MAX_TABLE_ROWS]
                ],
                row_links=[
                    (
                        _with_query("/customers", customer=c["customer_id"])
                        if c.get("customer_id")
                        else None
                    )
                    for c in customers[:MAX_TABLE_ROWS]
                ],
                currency=result.get("currency"),
                source=_source("top_customers", "Orders, net of refunds", result),
            ),
        )
    ]


def outstanding_invoices(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    out: list[tuple[str, Props]] = []
    source = _source("outstanding_invoices", "Open and part-paid invoices", result)
    # Money owed to the business first, then what it owes.
    totals = sorted(result.get("totals") or [], key=lambda t: t["type"] != "SALE")
    rows: list[SummaryRow] = []
    for total in totals:
        meaning = "Owed to you" if total["type"] == "SALE" else "You owe"
        rows.append(
            SummaryRow(label=f"{meaning} ({total['count']})", value=total["total"])
        )
        if total.get("overdue"):
            rows.append(
                SummaryRow(
                    label="of which overdue", value=total["overdue"], indent=True
                )
            )
    if rows:
        out.append(
            (
                "summary-list",
                SummaryList(
                    title="Unpaid invoices",
                    currency=result.get("currency"),
                    rows=rows,
                    source=source,
                ),
            )
        )
    invoices = (result.get("invoices") or [])[:MAX_TABLE_ROWS]
    if invoices:
        out.append(
            (
                "table",
                Table(
                    title="Invoices, oldest due first",
                    columns=[
                        Column(key="invoice_number", label="Invoice"),
                        Column(key="counterparty", label="Who"),
                        Column(key="due_date", label="Due", format="date"),
                        Column(key="days_overdue", label="Days late", format="number"),
                        Column(key="gross_amount", label="Amount", format="money"),
                    ],
                    rows=[
                        {
                            k: i.get(k)
                            for k in (
                                "invoice_number",
                                "counterparty",
                                "due_date",
                                "days_overdue",
                                "gross_amount",
                            )
                        }
                        for i in invoices
                    ],
                    row_links=[
                        (
                            _with_query("/invoices", invoice=i["id"])
                            if i.get("id")
                            else None
                        )
                        for i in invoices
                    ],
                    currency=result.get("currency"),
                    source=source,
                ),
            )
        )
    return out


def cash_position(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    accounts = result.get("accounts") or []
    if not accounts:
        return []
    rows = [
        SummaryRow(label=a.get("account") or "Account", value=a["balance"])
        for a in accounts
    ]
    rows.append(SummaryRow(label="Total", value=result["total"], kind="grand"))
    return [
        (
            "summary-list",
            SummaryList(
                title="Cash in the bank",
                currency=result.get("currency"),
                rows=rows[:20],
                source=_source(
                    "cash_position", "Bank balances, plus transactions since", result
                ),
            ),
        )
    ]


def search_transactions(
    args: dict[str, Any], result: dict[str, Any]
) -> list[tuple[str, Props]]:
    transactions = (result.get("transactions") or [])[:MAX_TABLE_ROWS]
    if not transactions:
        return []
    filters = result.get("filters") or {}
    period = (
        {"period": {"start": filters["start"], "end": filters["end"]}}
        if filters.get("start") and filters.get("end")
        else {}
    )
    return [
        (
            "table",
            Table(
                title="Bank transactions",
                columns=[
                    Column(key="date", label="Date", format="date"),
                    Column(key="description", label="Description"),
                    Column(key="direction", label="In/out"),
                    Column(key="amount", label="Amount", format="money"),
                ],
                rows=[
                    {
                        k: t.get(k)
                        for k in ("date", "description", "direction", "amount")
                    }
                    for t in transactions
                ],
                row_links=[
                    (
                        _with_query("/transactions", transactionId=t["id"])
                        if t.get("id")
                        else None
                    )
                    for t in transactions
                ],
                total_rows=result.get("matches"),
                source=_source(
                    "search_transactions",
                    "Bank transactions, not excluded",
                    {**result, **period},
                ),
            ),
        )
    ]


def run_sql(args: dict[str, Any], result: dict[str, Any]) -> list[tuple[str, Props]]:
    columns = (result.get("columns") or [])[:8]
    rows = (result.get("rows") or [])[:MAX_TABLE_ROWS]
    if not columns or not rows:
        return []
    keys = [f"c{i}" for i in range(len(columns))]
    return [
        (
            "table",
            Table(
                title=(
                    f"Custom query (first {len(rows)} rows)"
                    if result.get("truncated")
                    or len(result.get("rows") or []) > len(rows)
                    else "Custom query"
                ),
                columns=[
                    Column(
                        key=key,
                        label=str(name),
                        format=(
                            "number"
                            if all(
                                isinstance(r[i], (int, float))
                                for r in rows
                                if r[i] is not None
                            )
                            and any(r[i] is not None for r in rows)
                            else "text"
                        ),
                    )
                    for i, (key, name) in enumerate(zip(keys, columns))
                ],
                rows=[
                    {
                        key: (v if isinstance(v, (int, float)) or v is None else str(v))
                        for key, v in zip(keys, row)
                    }
                    for row in rows
                ],
                source=Source(tool="run_sql", label="A custom read-only query"),
            ),
        )
    ]


PRESENTERS: dict[str, Presenter] = {
    "profit_and_loss": profit_and_loss,
    "sales_summary": sales_summary,
    "top_products": top_products,
    "top_customers": top_customers,
    "outstanding_invoices": outstanding_invoices,
    "cash_position": cash_position,
    "search_transactions": search_transactions,
    "run_sql": run_sql,
}


def present(tool: str, args: dict[str, Any], result: Any) -> list[tuple[str, Props]]:
    """The components for one tool result (none for an error or an unknown tool)."""
    presenter = PRESENTERS.get(tool)
    if presenter is None or not isinstance(result, dict) or "error" in result:
        return []
    return presenter(args, result)
