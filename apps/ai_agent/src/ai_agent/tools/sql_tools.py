"""The analytics agent's database tools, scoped to the signed-in user.

Four tools under the names the prompts already use (`sql_db_list_tables`, `sql_db_schema`,
`sql_db_query_checker`, `sql_db_query`). They are built per request from the caller's
identity: every query runs as that user with row-level security on (see
`core/scoped_sql.py`), so the model cannot read another business's data, whatever
it writes.
"""

import asyncio
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import psycopg2  # type: ignore[import-untyped]
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, tool

from ..core.scoped_sql import (
    ALLOWED_RELATIONS,
    QueryRefused,
    _connect,
    check_query,
    run_query,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AgentUser:
    """Who the agent is working for. Set by the auth layer, never by the client."""

    user_id: str
    entity_id: str


def agent_user_from_config(config: RunnableConfig | None) -> AgentUser:
    """The authenticated user of this run. Raises PermissionError if there is none."""
    raw = ((config or {}).get("configurable") or {}).get("langgraph_auth_user")
    if raw is None:
        raise PermissionError("This agent only works for a signed-in user.")

    def pick(key: str) -> str | None:
        # The server hands over a dict-like proxy of what auth.py returned.
        getter = getattr(raw, "get", None)
        value = getter(key) if callable(getter) else getattr(raw, key, None)
        return str(value) if value else None

    user_id, entity_id = pick("identity"), pick("entity_id")
    if not user_id or not entity_id:
        raise PermissionError(
            "This agent only works for a signed-in user with a business."
        )
    return AgentUser(user_id=user_id, entity_id=entity_id)


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


def _format(columns: list[str], rows: list[list[Any]], truncated: bool) -> str:
    if not rows:
        return "No rows returned."
    lines = [" | ".join(columns)]
    lines += [" | ".join("NULL" if v is None else str(v) for v in row) for row in rows]
    if truncated:
        lines.append(f"(first {len(rows)} rows only; narrow the query or aggregate it)")
    return "\n".join(lines)


def build_sql_tools(user: AgentUser) -> list[BaseTool]:
    """The database tools for one user's run."""

    @tool
    async def sql_db_list_tables(tool_input: str = "") -> str:
        """List the tables and views you can query, comma-separated."""
        return ", ".join(sorted(ALLOWED_RELATIONS))

    @tool
    async def sql_db_schema(table_names: str) -> str:
        """Columns and types for a comma-separated list of tables or views."""
        try:
            columns = await asyncio.to_thread(_columns)
        except Exception as exc:
            logger.error("Could not read the schema: %s", exc)
            return "Error: the schema is not available right now."
        wanted = [t.strip().strip('"') for t in table_names.split(",") if t.strip()]
        blocks = []
        for name in wanted:
            if name not in ALLOWED_RELATIONS:
                blocks.append(f"{name}: not available. Use sql_db_list_tables.")
                continue
            cols = ", ".join(f"{c} ({t})" for c, t in columns.get(name, []))
            blocks.append(f"{name}: {cols}")
        return "\n".join(blocks) or "Name at least one table."

    @tool
    async def sql_db_query_checker(query: str) -> str:
        """Check a SQL query before running it. Returns OK or what to change."""
        try:
            check_query(query)
        except QueryRefused as exc:
            return f"Error: {exc}"
        return "OK"

    @tool
    async def sql_db_query(query: str) -> str:
        """Run a read-only SQL query over your business's data and return the rows."""
        try:
            result = await asyncio.to_thread(run_query, user.user_id, query)
        except QueryRefused as exc:
            return f"Error: {exc}"
        except psycopg2.Error as exc:
            first_line = (
                str(exc).strip().splitlines()[0] if str(exc).strip() else "failed"
            )
            return f"Error: {first_line}"
        return _format(result.columns, result.rows, result.truncated)

    return [sql_db_list_tables, sql_db_schema, sql_db_query_checker, sql_db_query]
