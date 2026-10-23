"""Read-only SQL for the agent, run as the signed-in user.

The agent writes SQL, so what it can reach must not depend on the model behaving.
Two layers:

1. `check_query` parses the statement (Postgres's own parser) and accepts one plain SELECT
   that names only allow-listed tables and views and calls only allow-listed functions.
   Function calls are the dangerous part: `set_config` could rewrite the identity
   row-level security reads, `pg_read_file` and friends reach the server, `dblink`
   reaches other databases. Anything not on the list is refused, not blocked by name.
2. `run_query` runs it in a READ ONLY transaction, as the `authenticated` role with the
   user's id set as the JWT claim, so the same row-level-security policies as the app's
   own pages decide which rows exist. Statement timeout, a row cap, a rollback at the end.

The model is never trusted to filter by business: the database does it.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any

import psycopg2  # type: ignore[import-untyped]
from pglast import ast, parse_sql
from pglast.visitors import Skip, Visitor

from .config import settings

logger = logging.getLogger(__name__)

MAX_ROWS = 200
STATEMENT_TIMEOUT_MS = 8000

# Business data the agent may query. Not here on purpose: external_sources (credential
# references), external_raw_events (raw provider payloads), sync state, logs, backups.
ALLOWED_RELATIONS = frozenset(
    {
        "accounting_period_locks",
        "accounting_periods",
        "bank_accounts",
        "chart_of_accounts",
        "collection_costs",
        "collection_plan_costs",
        "collection_plan_lines",
        "collection_plans",
        "collection_products",
        "collections",
        "contacts",
        "corporation_tax_rates",
        "customers",
        "entities",
        "financial_transactions",
        "inventory_items",
        "inventory_movements",
        "invoice_line_items",
        "invoices",
        "journal_line_items",
        "journals",
        "order_line_items",
        "orders",
        "payment_fees",
        "payments",
        "products",
        "tax_adjustments",
        # views (security_invoker: they see only the caller's rows)
        "accounting_health_checks",
        "accounting_period_results",
        "clearing_account_breakdown",
        "inventory_gl_reconciliation",
        "inventory_negative_stock",
        "inventory_on_hand",
        "inventory_uncosted_sales",
        "tax_account_positions",
        "tax_period_account_breakdown",
        "tax_review_items",
    }
)

# Plain analytics functions. Deliberately short: add one when a real question needs it.
ALLOWED_FUNCTIONS = frozenset(
    {
        # aggregates
        "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every",
        "string_agg", "array_agg", "json_agg", "jsonb_agg", "json_object_agg",
        "jsonb_object_agg", "stddev", "stddev_pop", "stddev_samp", "variance",
        "var_pop", "var_samp", "percentile_cont", "percentile_disc", "mode",
        # window
        "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile",
        "lag", "lead", "first_value", "last_value", "nth_value",
        # numbers
        "abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "sqrt", "power",
        "mod", "div", "exp", "ln", "log", "greatest", "least",
        # text
        "lower", "upper", "initcap", "length", "char_length", "btrim", "ltrim", "rtrim",
        "trim", "substr", "substring", "replace", "split_part", "concat", "concat_ws",
        "left", "right", "position", "strpos", "starts_with", "lpad", "rpad", "repeat",
        "reverse", "regexp_replace", "regexp_match", "to_char", "format", "md5",
        # dates (now/current_date are fixed per transaction)
        "date_trunc", "date_part", "extract", "age", "now", "current_date",
        "make_date", "to_date", "to_timestamp", "timezone", "date_bin", "justify_days",
        "justify_hours", "justify_interval", "generate_series", "isfinite",
        # json / arrays (reading only)
        "jsonb_extract_path", "jsonb_extract_path_text", "json_extract_path",
        "json_extract_path_text", "jsonb_array_elements", "jsonb_array_elements_text",
        "jsonb_array_length", "json_array_length", "jsonb_typeof", "jsonb_each",
        "jsonb_each_text", "jsonb_object_keys", "jsonb_build_object",
        "jsonb_build_array", "json_build_object", "json_build_array", "to_jsonb",
        "to_json", "jsonb_pretty", "array_length", "cardinality", "array_to_string",
        "string_to_array", "unnest", "array_position", "array_remove", "array_cat",
        # conversion / null handling
        "nullif", "coalesce", "to_number", "btrim", "ascii", "chr",
        # money-safe conversion
        "numeric", "float8", "int4", "int8", "text", "bool", "date", "timestamp",
        "timestamptz", "varchar", "bpchar", "float4", "int2", "interval", "jsonb",
        "json", "uuid",
    }
)  # fmt: skip


class QueryRefused(Exception):
    """The statement is not allowed; the message is written for the model to act on."""


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]
    truncated: bool


class _Collector(Visitor):  # type: ignore[misc]
    """What a piece of a statement touches: tables, functions, anything forbidden."""

    def __init__(self, top_ctes: tuple[Any, ...] = ()) -> None:
        super().__init__()
        self.relations: set[str] = set()
        self.functions: set[str] = set()
        self.problems: list[str] = []
        self._top_ctes = top_ctes

    def visit_RangeVar(self, ancestors: Any, node: Any) -> None:  # noqa: N802
        if node.schemaname and node.schemaname != "public":
            self.problems.append(f"schema '{node.schemaname}' is not available")
        else:
            self.relations.add(node.relname)

    def visit_CommonTableExpr(self, ancestors: Any, node: Any) -> Any:  # noqa: N802
        # Top-level CTEs are checked one by one by check_query (a name is only a CTE to
        # the queries that come after it). A WITH anywhere else is not supported.
        if any(node is cte for cte in self._top_ctes):
            return Skip
        self.problems.append("WITH is only allowed at the start of the query")
        return None

    def visit_FuncCall(self, ancestors: Any, node: Any) -> None:  # noqa: N802
        names = [n.sval for n in node.funcname]
        if len(names) > 1 and names[0] != "pg_catalog":
            self.problems.append(f"function '{'.'.join(names)}' is not available")
        else:
            self.functions.add(names[-1].lower())

    def visit_SelectStmt(self, ancestors: Any, node: Any) -> None:  # noqa: N802
        if node.intoClause is not None:
            self.problems.append("SELECT INTO is not allowed")
        if node.lockingClause:
            self.problems.append("row locking (FOR UPDATE/SHARE) is not allowed")

    def _write(self, ancestors: Any, node: Any) -> None:
        self.problems.append("only SELECT queries are allowed")

    # Data-modifying statements can hide inside WITH (WITH x AS (DELETE ...))).
    visit_InsertStmt = visit_UpdateStmt = visit_DeleteStmt = visit_MergeStmt = _write


def check_query(sql: str) -> None:
    """Raise QueryRefused unless `sql` is one plain SELECT over allowed data."""
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        raise QueryRefused("The query is empty.")
    try:
        statements = parse_sql(text)
    except Exception as exc:  # pglast.Error and friends
        raise QueryRefused(f"The query is not valid PostgreSQL: {exc}") from exc
    if len(statements) != 1:
        raise QueryRefused("Send exactly one statement.")
    stmt = statements[0].stmt
    if not isinstance(stmt, ast.SelectStmt):
        raise QueryRefused("Only SELECT queries are allowed.")

    problems: list[str] = []
    functions: set[str] = set()
    real_relations: set[str] = set()

    # A CTE name only means "the CTE" to what comes after it. Inside its own body (unless
    # WITH RECURSIVE) or an earlier one, the same name is the real table, so it is checked
    # as one: `WITH external_sources AS (SELECT * FROM external_sources)` is refused.
    ctes = tuple(stmt.withClause.ctes) if stmt.withClause else ()
    recursive = bool(stmt.withClause and stmt.withClause.recursive)
    visible: set[str] = set()
    for cte in ctes:
        collector = _Collector()
        collector(cte.ctequery)
        problems += collector.problems
        functions |= collector.functions
        real_relations |= (
            collector.relations - visible - ({cte.ctename} if recursive else set())
        )
        visible.add(cte.ctename)

    main = _Collector(top_ctes=ctes)
    main(stmt)
    problems += main.problems
    functions |= main.functions
    real_relations |= main.relations - visible

    if problems:
        raise QueryRefused("; ".join(sorted(set(problems))) + ".")
    unknown_tables = sorted(real_relations - ALLOWED_RELATIONS)
    if unknown_tables:
        raise QueryRefused(
            f"Table(s) not available: {', '.join(unknown_tables)}. "
            "Call list_tables to see what you can query."
        )
    unknown_functions = sorted(functions - ALLOWED_FUNCTIONS)
    if unknown_functions:
        raise QueryRefused(
            f"Function(s) not available: {', '.join(unknown_functions)}. "
            "Use plain aggregates, date and text functions."
        )


def _connect() -> Any:
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is not configured")
    return psycopg2.connect(settings.database_url, connect_timeout=5)


def _run_as_user(
    user_id: str,
    sql: str,
    params: tuple[Any, ...] | dict[str, Any] | None,
    max_rows: int,
    timeout_ms: int,
) -> QueryResult:
    """One statement as `user_id`: READ ONLY transaction, `authenticated` role, RLS on."""
    claims = json.dumps(
        {"sub": user_id, "role": "authenticated", "aud": "authenticated"}
    )
    conn = _connect()
    try:
        conn.set_session(readonly=True, autocommit=False)
        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (claims,))
            cur.execute(
                "SELECT set_config('request.jwt.claim.sub', %s, true)", (user_id,)
            )
            cur.execute(
                "SELECT set_config('request.jwt.claim.role', 'authenticated', true)"
            )
            cur.execute(
                "SELECT set_config('statement_timeout', %s, true)", (str(timeout_ms),)
            )
        text = sql.strip().rstrip(";")
        with conn.cursor(name="agent_query") as cur:  # server-side: never pulls it all
            cur.execute(text, params)
            fetched = cur.fetchmany(max_rows + 1)
            columns = [d.name for d in cur.description or []]
        truncated = len(fetched) > max_rows
        rows = [list(r) for r in fetched[:max_rows]]
        return QueryResult(columns=columns, rows=rows, truncated=truncated)
    finally:
        conn.rollback()
        conn.close()


def run_query(
    user_id: str,
    sql: str,
    *,
    max_rows: int = MAX_ROWS,
    timeout_ms: int = STATEMENT_TIMEOUT_MS,
) -> QueryResult:
    """Run model-written `sql` as `user_id`: checked, read-only, RLS on, capped."""
    check_query(sql)
    return _run_as_user(user_id, sql, None, max_rows, timeout_ms)


def run_trusted(
    user_id: str,
    sql: str,
    params: tuple[Any, ...] | dict[str, Any] | None = None,
    *,
    max_rows: int = MAX_ROWS,
    timeout_ms: int = STATEMENT_TIMEOUT_MS,
) -> QueryResult:
    """Run fixed SQL written in this codebase, with psycopg2 parameters, as `user_id`.

    Not checked by `check_query` (placeholders do not parse), so never pass it text the
    model wrote. Row-level security, the READ ONLY transaction and the limits still apply.
    """
    return _run_as_user(user_id, sql, params, max_rows, timeout_ms)
