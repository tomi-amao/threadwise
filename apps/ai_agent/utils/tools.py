"""Tools module for ThreadWise AI Agent."""

import os

from dotenv import load_dotenv
from langchain_community.agent_toolkits import SQLDatabaseToolkit
from langchain_community.utilities import SQLDatabase
from typing_extensions import TypedDict

from .settings import get_local_llm

load_dotenv(dotenv_path=".env")
model = get_local_llm()

# Get database URL from environment variable or use local development default
database_url = os.getenv("DATABASE_URL")

# Use psycopg2 instead of asyncpg for synchronous operations
db = SQLDatabase.from_uri(database_url)

print(db.dialect)
print(db.get_usable_table_names())


class State(TypedDict):
    """State schema for the agent."""

    question: str
    query: str
    result: str
    answer: str


# Create the toolkit that contains the tools for interacting with the database
toolkit = SQLDatabaseToolkit(db=db, llm=model)
# Get the tools
tools = toolkit.get_tools()
