"""SQL Tools for database interaction.

Provides lazy SQL toolkit and tools via get_toolkit() and get_sql_tools().
All heavy initialization (DB connection, LLM, toolkit creation) is deferred
until first use to avoid blocking LangGraph server startup.
"""

import logging
from functools import lru_cache
from typing import TypedDict

from langchain_community.agent_toolkits import SQLDatabaseToolkit

from ..core.config import get_local_llm
from ..core.database import get_db

logger = logging.getLogger(__name__)


# =============================================================================
# STATE SCHEMA
# =============================================================================


class State(TypedDict):
    """State schema for SQL agent."""
    question: str
    query: str
    result: str
    answer: str


# =============================================================================
# SQL TOOLKIT (LAZY)
# =============================================================================


@lru_cache(maxsize=1)
def get_toolkit() -> SQLDatabaseToolkit | None:
    """Get or create the SQL toolkit (lazy singleton).

    Uses the shared database connection from core.database to avoid
    duplicate psycopg2 connections.

    Returns:
        SQLDatabaseToolkit instance or None if database unavailable.
    """
    db = get_db()
    if db is None:
        logger.warning("SQL toolkit not initialized - database connection failed")
        return None

    model = get_local_llm("qwen/qwen3-vl-4b")
    toolkit = SQLDatabaseToolkit(db=db, llm=model)
    logger.info(f"SQL Tools - Database dialect: {db.dialect}")
    logger.info(f"SQL Tools - Available tables: {db.get_usable_table_names()}")
    return toolkit


@lru_cache(maxsize=1)
def get_sql_tools() -> list:
    """Get the SQL tools list (lazy singleton).

    Returns:
        List of LangChain tools from the SQL toolkit, or empty list.
    """
    tk = get_toolkit()
    if tk is None:
        return []
    tools = tk.get_tools()
    logger.info(f"Available SQL Tools: {[t.name for t in tools]}")
    return tools
