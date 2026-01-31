"""SQL Tools for database interaction.

Provides SQL toolkit and tools for the financial agent to query the database.
"""

import os
import logging
from typing import TypedDict
from pprint import pprint

from dotenv import load_dotenv
from langchain_community.agent_toolkits import SQLDatabaseToolkit
from langchain_community.utilities import SQLDatabase

from ..core.config import get_local_llm, settings

load_dotenv(dotenv_path=".env")

logger = logging.getLogger(__name__)

# =============================================================================
# DATABASE CONNECTION
# =============================================================================

# Get database URL from settings
database_url = settings.database_url

# Initialize SQLDatabase
try:
    db = SQLDatabase.from_uri(database_url)
    logger.info(f"SQL Tools - Database dialect: {db.dialect}")
    logger.info(f"SQL Tools - Available tables: {db.get_usable_table_names()}")
except Exception as e:
    logger.error(f"Failed to initialize SQL database: {e}")
    db = None


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
# SQL TOOLKIT
# =============================================================================

# Initialize model for SQL toolkit
model = get_local_llm("qwen/qwen3-vl-4b")

# Create the toolkit with tools for database interaction
if db:
    toolkit = SQLDatabaseToolkit(db=db, llm=model)
    sql_tools = toolkit.get_tools()
else:
    toolkit = None
    sql_tools = []
    logger.warning("SQL toolkit not initialized - database connection failed")

# General tools list (can be extended with custom tools)
tools = []

# Log available tools
pprint(f"Available SQL Tools: {[t.name for t in sql_tools]}")
pprint(f"Available General Tools: {[t.name for t in tools]}")
