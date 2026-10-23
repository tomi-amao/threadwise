"""The chat agent's SQL fallback, run as the signed-in user.

`list_tables`, `describe_tables` and `run_sql` are for questions the typed tools in
`data_tools.py` cannot answer. Every query is checked and then run as the caller with
row-level security on (`core/scoped_sql.py`), so whatever the model writes, it only
ever sees that user's business. A refusal comes back to the model as text so it can
correct the query.
"""

import asyncio
import logging
from functools import lru_cache
from typing import Any

import psycopg2  # type: ignore[import-untyped]
from langchain.tools import ToolRuntime, tool

from ..core.scoped_sql import ALLOWED_RELATIONS, QueryRefused, _connect, run_query
from .identity import agent_user, json_safe, progress

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _columns() -> dict[str, list[tuple[str, str]]]:
    """Column names and types of the queryable tables (schema only, no business data)."""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "select table_name, column_name, data_type "
                "from information_schema.columns "
                "where table_schema = 'public' and table_name = any(%s) "
                "order by table_name, ordinal_position",
                (sorted(ALLOWED_RELATIONS),),
            )
            out: dict[str, list[tuple[str, str]]] = {}
            for table, column, data_type in cur.fetchall():
                out.setdefault(table, []).append((column, data_type))
            return out
    finally:
        conn.close()


@tool
async def list_tables(runtime: ToolRuntime) -> str:
    """List the tables and views run_sql can query. Use the typed tools first."""
    agent_user(runtime)
    return ", ".join(sorted(ALLOWED_RELATIONS))


@tool
async def describe_tables(table_names: list[str], runtime: ToolRuntime) -> str:
    """Columns and types of the named tables or views, before writing run_sql."""
    agent_user(runtime)
    try:
        columns = await asyncio.to_thread(_columns)
    except Exception as exc:
        logger.error("Could not read the schema: %s", exc)
        return "Error: the schema is not available right now."
    blocks = []
    for raw in table_names:
        name = raw.strip().strip('"')
        if name not in ALLOWED_RELATIONS:
            blocks.append(f"{name}: not available. Call list_tables.")
            continue
        cols = ", ".join(f"{c} ({t})" for c, t in columns.get(name, []))
        blocks.append(f"{name}: {cols}")
    return "\n".join(blocks) or "Name at least one table."


@tool
async def run_sql(query: str, runtime: ToolRuntime) -> dict[str, Any]:
    """Run one read-only PostgreSQL SELECT over this business's data (max 200 rows).

    Only when no typed tool answers the question. Returns the columns and rows, or an
    error saying what to change. Rows are already limited to this business.
    """
    user = agent_user(runtime)
    progress(runtime, "Running a custom query")
    try:
        result = await asyncio.to_thread(run_query, user.user_id, query)
    except QueryRefused as exc:
        return {"error": str(exc)}
    except psycopg2.Error as exc:
        first_line = str(exc).strip().splitlines()[0] if str(exc).strip() else "failed"
        return {"error": first_line}
    return {
        "columns": result.columns,
        "rows": json_safe(result.rows),
        "truncated": result.truncated,
    }


SQL_TOOLS = [list_tables, describe_tables, run_sql]
