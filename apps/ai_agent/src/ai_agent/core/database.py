"""Database utilities for ThreadWise AI Agent.

Provides lazy database connection via get_db() for LangChain tools.
The connection is deferred until first use to avoid blocking startup.
"""

import logging
from functools import lru_cache

from langchain_community.utilities import SQLDatabase

from .config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_db() -> SQLDatabase | None:
    """Get or create the shared SQLDatabase instance (lazy singleton).

    The database connection is established on first call and cached for
    subsequent calls. This avoids blocking the LangGraph server startup
    with a synchronous psycopg2 connection and schema introspection.

    Returns:
        SQLDatabase instance or None if connection fails.
    """
    database_url = settings.database_url
    if not database_url:
        logger.error("DATABASE_URL is not configured")
        return None

    try:
        db = SQLDatabase.from_uri(database_url)
        logger.info(f"Database connected: dialect={db.dialect}")
        logger.info(f"Available tables: {db.get_usable_table_names()}")
        return db
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        return None
