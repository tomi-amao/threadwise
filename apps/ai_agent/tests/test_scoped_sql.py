"""The agent's SQL: what the checker refuses, and (against the local database) that a user
only ever sees their own business."""

import os

import psycopg2
import pytest

from ai_agent.core import scoped_sql
from ai_agent.core.scoped_sql import QueryRefused, check_query, run_query
from ai_agent.tools.sql_tools import (
    AgentUser,
    agent_user_from_config,
    build_sql_tools,
)

ALLOWED = [
    "select count(*) from orders",
    "select o.id, sum(l.quantity) from orders o "
    "join order_line_items l on l.order_id = o.id group by 1",
    "with x as (select * from orders) select count(*) from x",
    "with a as (select * from orders), b as (select * from a) select * from b",
    "with recursive t(n) as (select 1 union all select n + 1 from t where n < 5) "
    "select * from t",
    "select date_trunc('month', created_at), sum(amount) from payments group by 1",
    "select coalesce(sum(amount), 0)::numeric(12,2) from payments",
    "select * from orders order by created_at desc limit 5;",
]

REFUSED = {
    "other schema": "select * from auth.users",
    "storage schema": "select * from storage.objects",
    "system catalog": "select * from pg_proc",
    "information schema": "select * from information_schema.tables",
    "credential table": "select * from external_sources",
    "raw payloads": "select * from external_raw_events",
    "write": "delete from orders",
    "update": "update orders set status = 'x'",
    "insert": "insert into customers (name) values ('x')",
    "ddl": "drop table orders",
    "two statements": "select 1; drop table orders",
    "write inside WITH": "with d as (delete from orders returning *) select * from d",
    "set_config": "select set_config('request.jwt.claims', '{}', true)",
    "set_config qualified": "select pg_catalog.set_config('a', 'b', true)",
    "set_config quoted": "select \"set_config\"('a', 'b', true)",
    "set_config in CTE": "with x as (select set_config('a','b',true)) select * from x",
    "read a file": "select pg_read_file('/etc/passwd')",
    "sleep": "select pg_sleep(100)",
    "settings": "select current_setting('request.jwt.claims')",
    "other database": "select * from dblink('x', 'select 1') as t(a int)",
    "select into": "select 1 into foo",
    "row lock": "select * from orders for update",
    "copy": "copy orders to stdout",
    "catalog in subquery": "select * from orders "
    "where id = (select id from pg_user limit 1)",
    "auth in exists": "select * from orders o where exists (select 1 from auth.users)",
    "CTE shadowing a forbidden table": "with external_sources as "
    "(select * from external_sources) select * from external_sources",
    "CTE used before it is defined": "with a as (select * from b), "
    "b as (select 1) select * from a",
    "nested WITH": "select * from (with y as (select 1) select * from y) z",
    "empty": "   ;  ",
    "not SQL": "show me the revenue",
}


@pytest.mark.parametrize("sql", ALLOWED)
def test_plain_reads_are_allowed(sql):
    check_query(sql)


@pytest.mark.parametrize("sql", REFUSED.values(), ids=REFUSED.keys())
def test_everything_else_is_refused(sql):
    with pytest.raises(QueryRefused):
        check_query(sql)


def test_the_refusal_tells_the_model_what_to_do():
    with pytest.raises(QueryRefused, match="sql_db_list_tables"):
        check_query("select * from external_sources")


def test_agent_user_comes_only_from_the_auth_layer():
    with pytest.raises(PermissionError):
        agent_user_from_config({"configurable": {}})
    with pytest.raises(PermissionError):
        agent_user_from_config(None)
    with pytest.raises(PermissionError):  # an identity without a business
        agent_user_from_config(
            {"configurable": {"langgraph_auth_user": {"identity": "u"}}}
        )
    user = agent_user_from_config(
        {"configurable": {"langgraph_auth_user": {"identity": "u1", "entity_id": "e1"}}}
    )
    assert user == AgentUser("u1", "e1")


# ── against the local database (skipped when it is not running) ──────────────────────

LOCAL_DB = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)


@pytest.fixture(scope="module")
def two_businesses():
    try:
        conn = psycopg2.connect(LOCAL_DB, connect_timeout=2)
    except psycopg2.Error:
        pytest.skip("local Supabase database is not running")
    with conn, conn.cursor() as cur:
        cur.execute(
            "select e.owner_user_id::text, e.id::text, "
            "(select count(*) from orders o where o.entity_id = e.id) "
            "from entities e where e.owner_user_id is not null order by e.created_at"
        )
        rows = cur.fetchall()
    conn.close()
    if len(rows) < 2 or len({r[2] for r in rows}) < 2:
        pytest.skip("seed two businesses with different order counts (pnpm db:fresh)")
    return rows[0], rows[1]


@pytest.fixture(autouse=True)
def _use_local_db(monkeypatch):
    monkeypatch.setattr(scoped_sql.settings, "database_url", LOCAL_DB)


def test_each_user_sees_only_their_own_rows(two_businesses):
    for owner, entity, order_count in two_businesses:
        result = run_query(
            owner, "select count(*), count(distinct entity_id) from orders"
        )
        assert result.rows == [[order_count, 1]]
        names = run_query(owner, "select id::text from entities").rows
        assert names == [[entity]]


def test_a_stranger_sees_nothing(two_businesses):
    nobody = "00000000-0000-0000-0000-000000000000"
    assert run_query(nobody, "select count(*) from orders").rows == [[0]]


def test_the_model_cannot_ask_for_the_other_business(two_businesses):
    (owner_a, _, count_a), (_, entity_b, _) = two_businesses
    # Naming the other business's id returns nothing: those rows are not there for them.
    result = run_query(
        owner_a, f"select count(*) from orders where entity_id = '{entity_b}'"
    )
    assert result.rows == [[0]]
    assert run_query(owner_a, "select count(*) from orders").rows == [[count_a]]


def test_results_are_capped_and_flagged(two_businesses):
    owner = two_businesses[0][0]
    result = run_query(owner, "select * from order_line_items", max_rows=3)
    assert len(result.rows) == 3 and result.truncated


def test_a_slow_query_is_cancelled(two_businesses):
    owner = two_businesses[0][0]
    with pytest.raises(psycopg2.errors.QueryCanceled):
        run_query(
            owner,
            "select count(*) from generate_series(1, 100000000) g",
            timeout_ms=200,
        )


def test_the_transaction_itself_is_read_only(two_businesses, monkeypatch):
    # Even if the checker were wrong, the database would refuse to write.
    owner = two_businesses[0][0]
    monkeypatch.setattr(scoped_sql, "check_query", lambda _sql: None)
    with pytest.raises(psycopg2.Error):
        run_query(owner, "delete from orders")


async def _call(tool, **kwargs):
    return await tool.ainvoke(kwargs)


def test_the_tools_answer_for_their_user_only(two_businesses):
    import asyncio

    (owner_a, entity_a, count_a), (owner_b, _, count_b) = two_businesses
    tools = {t.name: t for t in build_sql_tools(AgentUser(owner_a, entity_a))}
    assert set(tools) == {
        "sql_db_list_tables",
        "sql_db_schema",
        "sql_db_query_checker",
        "sql_db_query",
    }
    answer = asyncio.run(
        _call(tools["sql_db_query"], query="select count(*) from orders")
    )
    assert str(count_a) in answer and str(count_b) not in answer.replace(
        str(count_a), ""
    )
    refused = asyncio.run(
        _call(tools["sql_db_query"], query="select * from auth.users")
    )
    assert refused.startswith("Error:")
    assert asyncio.run(_call(tools["sql_db_query_checker"], query="select 1")) == "OK"
    schema = asyncio.run(
        _call(tools["sql_db_schema"], table_names="orders, external_sources")
    )
    assert "orders:" in schema and "external_sources: not available" in schema
