"""The UI contract file shared with the frontend.

    poetry run python -m ai_agent.ui.contract   # after changing the catalogue

Writes `apps/chat-ui/app/components/assistant/ui-contract.json`: the catalogue version,
a JSON Schema for every component and interrupt, and examples made by running the real
presenters on sample tool results. `tests/test_ui_contract.py` fails when the file is
out of date; the frontend's `e2e/assistant-contract.spec.ts` checks its Zod schemas
accept every example and name the same fields.
"""

import json
from pathlib import Path
from typing import Any

from .catalogue import (
    CATALOGUE_VERSION,
    COMPONENTS,
    INTERRUPTS,
    Clarify,
    ClarifyOption,
    FollowUp,
    FollowUps,
)
from .presenters import present

CONTRACT_FILE = (
    Path(__file__).resolve().parents[4]
    / "chat-ui"
    / "app"
    / "components"
    / "assistant"
    / "ui-contract.json"
)

_FY = {"start": "2026-04-01", "end": "2027-03-31"}

# Sample tool results, shaped exactly like the typed tools' output.
SAMPLE_RESULTS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "profit_and_loss": (
        {},
        {
            "period": _FY,
            "currency": "GBP",
            "revenue": 28500.0,
            "cost_of_sales": 12000.0,
            "gross_profit": 16500.0,
            "expenses": 12050.84,
            "net_profit": 4449.16,
            "link": "/reports?from=2026-04-01&to=2027-03-31",
        },
    ),
    "sales_summary": (
        {},
        {
            "period": _FY,
            "currency": "GBP",
            "orders": 610,
            "gross": 136420.5,
            "refunds": 250.0,
            "net_sales": 136170.5,
            "average_order_value": 223.64,
            "link": "/orders?from=2026-04-01&to=2027-03-31",
        },
    ),
    "sales_summary_by_month": (
        {"by_month": True},
        {
            "period": _FY,
            "currency": "GBP",
            "orders": 210,
            "gross": 47000.0,
            "refunds": 0.0,
            "net_sales": 47000.0,
            "average_order_value": 223.81,
            "link": "/orders?from=2026-04-01&to=2027-03-31",
            "months": [
                {"month": "2026-08", "orders": 70, "gross": 15600.0, "refunds": 0.0,
                 "net_sales": 15600.0, "average_order_value": 222.86},
                {"month": "2026-09", "orders": 72, "gross": 16100.0, "refunds": 0.0,
                 "net_sales": 16100.0, "average_order_value": 223.61},
                {"month": "2026-10", "orders": 68, "gross": 15300.0, "refunds": 0.0,
                 "net_sales": 15300.0, "average_order_value": 225.0},
            ],
        },
    ),
    "top_products": (
        {},
        {
            "period": _FY,
            "currency": "GBP",
            "ranked_by": "revenue",
            "products": [
                {"product": "Selvedge Work Trouser", "product_id": "p-1", "units": 477,
                 "revenue": 64395.0, "orders": 295},
                {"product": "Wool Overshirt", "product_id": "p-2", "units": 475,
                 "revenue": 58900.0, "orders": 305},
            ],
            "link": "/products",
        },
    ),
    "top_customers": (
        {},
        {
            "period": _FY,
            "currency": "GBP",
            "customers": [
                {"customer": "Noor Aziz", "customer_id": "c-1", "orders": 93,
                 "spent": 22644.3, "last_order": "2026-10-16"},
            ],
            "link": "/customers",
        },
    ),
    "outstanding_invoices": (
        {},
        {
            "as_of": "2026-10-18",
            "currency": "GBP",
            "totals": [
                {"type": "PURCHASE", "meaning": "you owe", "count": 2, "total": 3780.0,
                 "overdue": 180.0, "other_currency_count": 0},
                {"type": "SALE", "meaning": "owed to you", "count": 3, "total": 4860.0,
                 "overdue": 2460.0, "other_currency_count": 1},
            ],
            "invoices": [
                {"id": "i-1", "invoice_number": "INV-OUT-2003", "type": "SALE",
                 "status": "OPEN", "counterparty": "Harbour & Co", "gross_amount": 960.0,
                 "currency": "GBP", "invoice_date": "2026-08-08",
                 "due_date": "2026-09-07",
                 "days_overdue": 41},
            ],
            "link": "/invoices?tab=open",
        },
    ),
    "cash_position": (
        {},
        {
            "as_of": "2026-10-18",
            "currency": "GBP",
            "total": 100956.91,
            "accounts": [
                {"account": "Revolut GBP", "currency": "GBP", "source": "revolut",
                 "balance_snapshot_at": "2026-10-01T00:00:00+00:00", "balance": 90000.0},
                {"account": "PayPal", "currency": "GBP", "source": "paypal",
                 "balance_snapshot_at": "2026-10-01T00:00:00+00:00", "balance": 10956.91},
            ],
            "link": "/transactions",
        },
    ),
    "search_transactions": (
        {"text": "royal mail"},
        {
            "filters": {"text": "royal mail", "start": "2026-09-01", "end": "2026-09-30",
                        "direction": None, "min_amount": None, "max_amount": None},
            "matches": 14,
            "total_in": 0.0,
            "total_out": 412.6,
            "transactions": [
                {"id": "t-1", "date": "2026-09-28",
                 "description": "Royal Mail Click & Drop",
                 "payee": "Royal Mail", "direction": "out", "amount": 31.2,
                 "currency": "GBP", "account": "Revolut GBP"},
            ],
            "link": "/transactions?q=royal+mail&from=2026-09-01&to=2026-09-30",
        },
    ),
    "run_sql": (
        {"query": "select status, count(*) from orders group by 1"},
        {"columns": ["status", "count"], "rows": [["delivered", 580], ["shipped", 141]],
         "truncated": False},
    ),
}  # fmt: skip


def examples() -> dict[str, list[dict[str, Any]]]:
    """Props examples per component, from the real presenters (plus follow-ups)."""
    out: dict[str, list[dict[str, Any]]] = {name: [] for name in COMPONENTS}
    for key, (args, result) in SAMPLE_RESULTS.items():
        tool = key.removesuffix("_by_month")
        for name, props in present(tool, args, result):
            out[name].append(props.model_dump(mode="json", exclude_none=True))
    out["follow-ups"].append(
        FollowUps(
            items=[
                FollowUp(
                    label="Compare with last year",
                    prompt="How does this compare with last financial year?",
                ),
                FollowUp(
                    label="Biggest expenses",
                    prompt="What were my biggest expenses this financial year?",
                ),
            ]
        ).model_dump(mode="json")
    )
    return out


def contract() -> dict[str, Any]:
    return {
        "version": CATALOGUE_VERSION,
        "components": {
            name: model.model_json_schema() for name, model in COMPONENTS.items()
        },
        "interrupts": {
            kind: model.model_json_schema() for kind, model in INTERRUPTS.items()
        },
        "examples": examples(),
        "interrupt_examples": {
            "clarify": [
                Clarify(
                    question="Which period do you mean?",
                    options=[
                        ClarifyOption(label="This month"),
                        ClarifyOption(label="Last month"),
                        ClarifyOption(label="This financial year"),
                    ],
                ).model_dump(mode="json")
            ]
        },
    }


def render() -> str:
    return json.dumps(contract(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    CONTRACT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONTRACT_FILE.write_text(render())
    print(f"wrote {CONTRACT_FILE}")
