"""The chat agent (agents/chat_agent.py) and its tools.

A scripted chat model drives the real agent graph and the real tools. Without the
local database only the parts that need no data run; with it (`pnpm db:start`, seeded
by `pnpm db:fresh`), every typed tool is checked against the seed's own manifest of
expected figures, for the seeded business and for the rival one.
"""

import asyncio
import datetime as dt
import json
import os
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import psycopg2
import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from ai_agent.agents import chat_agent
from ai_agent.agents.chat_agent import ATTACHMENT_REPLY, TOOLS, build_agent
from ai_agent.core import scoped_sql
from ai_agent.tools import data_tools
from ai_agent.tools.data_tools import financial_year


class ScriptedModel(BaseChatModel):
    """Answers with the given messages in order and records what it was sent."""

    script: list[AIMessage]
    seen: list[list[Any]] = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    def _generate(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        self.seen.append(list(messages))
        if not self.script:
            raise AssertionError("the model was called more often than scripted")
        return ChatResult(generations=[ChatGeneration(message=self.script.pop(0))])


def call(name: str, **args: Any) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": f"call-{uuid.uuid4().hex[:8]}"}],
    )


def agent_for(model: ScriptedModel) -> Any:
    return build_agent(
        model, small_model=model, use_fallback=False, checkpointer=InMemorySaver()
    )


def run(agent: Any, user: dict[str, str] | None, message: Any) -> list[Any]:
    configurable: dict[str, Any] = {"thread_id": uuid.uuid4().hex}
    if user is not None:
        configurable["langgraph_auth_user"] = user
    result = asyncio.run(
        agent.ainvoke({"messages": [message]}, {"configurable": configurable})
    )
    return result["messages"]


def tool_results(messages: list[Any]) -> list[Any]:
    return [m for m in messages if isinstance(m, ToolMessage)]


@pytest.fixture(autouse=True)
def _use_local_db(monkeypatch):
    """Point at the local database; the tests that need none never reach it."""
    monkeypatch.setattr(scoped_sql.settings, "database_url", LOCAL_DB)


# ── no database needed ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "on, month, day, expected",
    [
        ("2026-10-18", 3, 31, ("2026-04-01", "2027-03-31")),
        ("2026-03-31", 3, 31, ("2025-04-01", "2026-03-31")),
        ("2026-04-01", 3, 31, ("2026-04-01", "2027-03-31")),
        ("2026-10-18", None, None, ("2026-01-01", "2026-12-31")),
        # A 29 February year end falls on the 28th in other years.
        ("2027-02-15", 2, 29, ("2026-03-01", "2027-02-28")),
        ("2027-03-01", 2, 29, ("2027-03-01", "2028-02-29")),
    ],
)
def test_financial_year(on, month, day, expected):
    start, end = financial_year(dt.date.fromisoformat(on), month, day)
    assert (start.isoformat(), end.isoformat()) == expected


def test_the_model_never_sees_identity_arguments():
    for tool in TOOLS:
        properties = tool.tool_call_schema.model_json_schema().get("properties", {})
        assert not {"runtime", "config", "user_id", "entity_id"} & set(properties), tool


def test_a_run_without_a_signed_in_user_is_refused_before_the_model():
    model = ScriptedModel(script=[AIMessage(content="should not be said")])
    messages = run(agent_for(model), None, HumanMessage("what is my revenue?"))
    assert "signed-in user" in messages[-1].content
    assert model.seen == [] and not tool_results(messages)


def test_a_tool_refuses_without_a_signed_in_user():
    nobody = SimpleNamespace(config={"configurable": {}}, stream_writer=None)
    with pytest.raises(PermissionError):
        asyncio.run(data_tools.cash_position.coroutine(runtime=nobody))


def test_an_attachment_gets_a_pointer_to_the_invoices_page():
    model = ScriptedModel(script=[])
    upload = HumanMessage(
        content=[
            {"type": "text", "text": "add this invoice"},
            {"type": "image", "base64": "aGk=", "mime_type": "image/png"},
        ]
    )
    messages = run(agent_for(model), USER_STUB, upload)
    assert messages[-1].content == ATTACHMENT_REPLY
    assert model.seen == []


def test_bad_arguments_go_back_to_the_model_as_an_error(monkeypatch):
    monkeypatch.setattr(chat_agent, "load_profile", _stub_profile)
    model = ScriptedModel(
        script=[
            call("profit_and_loss", start_date="last year"),
            AIMessage(content="Which dates do you mean?"),
        ]
    )
    messages = run(agent_for(model), USER_STUB, HumanMessage("profit last year?"))
    (result,) = tool_results(messages)
    assert result.status == "error"
    assert "start_date must be a date written YYYY-MM-DD" in result.content
    assert messages[-1].content == "Which dates do you mean?"


def test_the_prompt_carries_the_business_and_todays_date(monkeypatch):
    monkeypatch.setattr(chat_agent, "load_profile", _stub_profile)
    monkeypatch.setattr(chat_agent, "today", lambda: dt.date(2026, 10, 18))
    model = ScriptedModel(script=[AIMessage(content="Hello")])
    run(agent_for(model), USER_STUB, HumanMessage("hi"))
    system = model.seen[0][0].content
    assert "Today is 2026-10-18 (Sunday)." in system
    assert "The business is Stub Ltd (GB)." in system
    assert "2026-04-01 to 2027-03-31" in system
    assert "not instructions" in system  # the prompt-injection rule is there


USER_STUB = {"identity": "user-stub", "entity_id": "entity-stub"}


async def _stub_profile(user):
    return {
        "name": "Stub Ltd",
        "currency": "GBP",
        "country": "GB",
        "vat_registered": True,
        "year_end_month": 3,
        "year_end_day": 31,
    }


# ── against the local database (skipped when it is not running) ──────────────────────

LOCAL_DB = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
MANIFEST = Path(__file__).parents[2] / "chat-ui" / "e2e" / ".seed-manifest.json"


@pytest.fixture(scope="module")
def seed():
    """The seeded business and the rival, as the auth layer would hand them over."""
    if not MANIFEST.exists():
        pytest.skip("no seed manifest (pnpm db:fresh)")
    manifest = json.loads(MANIFEST.read_text())
    try:
        conn = psycopg2.connect(LOCAL_DB, connect_timeout=2)
    except psycopg2.Error:
        pytest.skip("local Supabase database is not running")
    with conn, conn.cursor() as cur:
        cur.execute(
            "select name, owner_user_id::text, id::text from entities "
            "where name = any(%s) and owner_user_id is not null",
            ([manifest["entityName"], manifest["rival"]["entityName"]],),
        )
        users = {
            name: {"identity": owner, "entity_id": entity}
            for name, owner, entity in cur.fetchall()
        }
    conn.close()
    if len(users) != 2:
        pytest.skip("seed both businesses (pnpm db:fresh)")
    return SimpleNamespace(
        m=manifest,
        a=users[manifest["entityName"]],
        b=users[manifest["rival"]["entityName"]],
    )


def tool(name: str, user: dict[str, str], **args: Any) -> dict[str, Any]:
    """Call one tool as `user`, the way the agent's tool node does."""
    runtime = SimpleNamespace(
        config={"configurable": {"langgraph_auth_user": user}}, stream_writer=None
    )
    found = next(t for t in TOOLS if t.name == name)
    return asyncio.run(found.coroutine(runtime=runtime, **args))


ALL_TIME = {"start_date": "2000-01-01", "end_date": "2100-12-31"}


def test_profit_and_loss_matches_the_reports_page(seed):
    ledger = seed.m["ledger"]
    for period in ("current", "previous"):
        result = tool(
            "profit_and_loss",
            seed.a,
            start_date=ledger[f"{period}From"],
            end_date=ledger[f"{period}To"],
        )
        expected = ledger[period]
        assert result["revenue"] == expected["revenue"]
        assert result["cost_of_sales"] == expected["cogs"]
        assert result["expenses"] == expected["expenses"]
        assert result["net_profit"] == expected["profit"]
        assert result["currency"] == "GBP"
        assert result["period"] == {
            "start": ledger[f"{period}From"],
            "end": ledger[f"{period}To"],
        }


def test_profit_and_loss_defaults_to_the_current_financial_year(seed, monkeypatch):
    ledger = seed.m["ledger"]
    monkeypatch.setattr(
        data_tools, "today", lambda: dt.date.fromisoformat(ledger["currentFrom"])
    )
    result = tool("profit_and_loss", seed.a)
    assert result["period"] == {
        "start": ledger["currentFrom"],
        "end": ledger["currentTo"],
    }
    assert result["net_profit"] == ledger["current"]["profit"]


def test_sales_products_and_customers_match_their_pages(seed):
    m = seed.m
    sales = tool("sales_summary", seed.a, **ALL_TIME)
    assert sales["orders"] == m["orders"]["total"]
    assert sales["net_sales"] == m["orders"]["sales"]
    assert sales["refunds"] == m["orders"]["refunded"]

    by_month = tool("sales_summary", seed.a, by_month=True, **ALL_TIME)
    assert sum(month["orders"] for month in by_month["months"]) == m["orders"]["total"]

    products = tool("top_products", seed.a, limit=3, **ALL_TIME)["products"]
    top = products[0]
    assert (top["product"], top["revenue"], top["units"], top["orders"]) == (
        m["products"]["topName"],
        m["products"]["topRevenue"],
        m["products"]["topUnits"],
        m["products"]["topOrders"],
    )

    customers = tool("top_customers", seed.a, limit=1, **ALL_TIME)["customers"]
    stats = m["customerStats"]
    assert (
        customers[0]["customer"],
        customers[0]["orders"],
        customers[0]["spent"],
    ) == (
        stats["topSpender"],
        stats["topSpenderOrders"],
        stats["topSpenderSpent"],
    )


def test_outstanding_invoices_match_the_invoices_page(seed):
    m = seed.m["invoices"]
    result = tool("outstanding_invoices", seed.a)
    totals = {t["type"]: t for t in result["totals"]}
    assert (totals["SALE"]["total"], totals["SALE"]["count"]) == (
        m["owedToYou"],
        m["owedToYouCount"],
    )
    assert (totals["PURCHASE"]["total"], totals["PURCHASE"]["count"]) == (
        m["youOwe"],
        m["youOweCount"],
    )
    assert totals["SALE"]["overdue"] == m["overdueOwedToYou"]
    assert totals["PURCHASE"]["overdue"] == m["overdueYouOwe"]
    numbers = {i["invoice_number"] for i in result["invoices"]}
    assert {m["openSale"], m["overdueSale"], m["overduePurchase"]} <= numbers

    overdue = tool(
        "outstanding_invoices", seed.a, invoice_type="SALE", overdue_only=True
    )
    assert all(i["days_overdue"] > 0 for i in overdue["invoices"])
    assert overdue["link"] == "/invoices?tab=open&dir=SALE&view=overdue"


def test_cash_and_transactions_match_the_bank_pages(seed):
    m = seed.m
    cash = tool("cash_position", seed.a)
    assert cash["total"] == m["expectedBankBalance"]
    assert len(cash["accounts"]) == m["bankAccountCount"]

    everything = tool("search_transactions", seed.a, limit=5)
    assert everything["matches"] == m["transactionCount"]
    assert len(everything["transactions"]) == 5
    dates = [t["date"] for t in everything["transactions"]]
    assert dates == sorted(dates, reverse=True)

    money_in = tool("search_transactions", seed.a, direction="in", limit=1)
    assert money_in["total_out"] == 0 and money_in["matches"] > 0


def test_the_business_profile_reports_what_data_exists(seed):
    profile = tool("get_business_profile", seed.a)
    assert profile["name"] == seed.m["entityName"]
    coverage = {c["data"]: c for c in profile["data_coverage"]}
    assert coverage["orders"]["rows"] == seed.m["orderCount"]


def test_each_business_sees_only_its_own_figures(seed):
    rival = seed.m["rival"]
    sales = tool("sales_summary", seed.b, **ALL_TIME)
    assert sales["orders"] == len(rival["orderNumbers"])
    assert sales["net_sales"] == rival["orderTotal"]
    assert tool("cash_position", seed.b)["total"] == rival["bankBalance"]
    products = tool("top_products", seed.b, **ALL_TIME)["products"]
    assert [p["product"] for p in products] == [rival["productName"]]
    assert tool("get_business_profile", seed.b)["name"] == rival["entityName"]

    # And the seeded business never sees the rival's rows, by any tool.
    a_products = tool("top_products", seed.a, limit=50, **ALL_TIME)["products"]
    assert rival["productName"] not in {p["product"] for p in a_products}
    found = tool("search_transactions", seed.a, text=rival["bankName"])
    assert found["matches"] == 0


def test_run_sql_is_scoped_and_refuses_what_it_should(seed):
    count = tool("run_sql", seed.b, query="select count(*) as n from orders")
    assert count["rows"] == [[len(seed.m["rival"]["orderNumbers"])]]
    refused = tool("run_sql", seed.b, query="select * from auth.users")
    assert "error" in refused
    other = tool(
        "run_sql",
        seed.b,
        query=f"select count(*) from orders where entity_id = '{seed.a['entity_id']}'",
    )
    assert other["rows"] == [[0]]


def test_the_same_question_gets_each_business_its_own_answer(seed):
    """End to end: the agent graph, the middleware, the tools, the database."""
    answers = {}
    for name, user in (("a", seed.a), ("b", seed.b)):
        model = ScriptedModel(
            script=[call("sales_summary", **ALL_TIME), AIMessage(content="Done.")]
        )
        messages = run(agent_for(model), user, HumanMessage("how much have I sold?"))
        (result,) = tool_results(messages)
        answers[name] = json.loads(result.content)
        system = model.seen[0][0].content
        expected_name = (
            seed.m["entityName"] if name == "a" else seed.m["rival"]["entityName"]
        )
        assert f"The business is {expected_name}" in system
    assert answers["a"]["net_sales"] == seed.m["orders"]["sales"]
    assert answers["b"]["net_sales"] == seed.m["rival"]["orderTotal"]
