"""Database utilities for ThreadWise AI Agent.

Provides database connection and SQLDatabase instance for LangChain tools.
"""

import os
import logging

from dotenv import load_dotenv
from langchain_community.utilities import SQLDatabase

from .config import settings

load_dotenv(dotenv_path=".env")

logger = logging.getLogger(__name__)

# Get database URL from settings
database_url = settings.database_url

# Initialize SQLDatabase for LangChain tools
# Uses psycopg2 for synchronous operations
try:
    db = SQLDatabase.from_uri(database_url)
    logger.info(f"Database connected: dialect={db.dialect}")
    logger.info(f"Available tables: {db.get_usable_table_names()}")
except Exception as e:
    logger.error(f"Failed to connect to database: {e}")
    db = None
