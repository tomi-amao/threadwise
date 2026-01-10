"""Tools module for ThreadWise AI Agent."""

import os
from typing import Literal

from dotenv import load_dotenv
from langchain_community.agent_toolkits import SQLDatabaseToolkit
from langchain_community.utilities import SQLDatabase
from pydantic import BaseModel, Field
from typing_extensions import TypedDict
from langchain.tools import tool, ToolRuntime


from .settings import CustomContext, CustomState, get_local_llm, get_chat_model
from ai_agent.services.embedding_service import embedding_service
from pprint import pprint
from langgraph.types import Command
from langchain.messages import ToolMessage, AIMessage
from langchain_community.tools import BraveSearch
from .sub_agents import qualify_query

load_dotenv(dotenv_path=".env")
model = get_chat_model()

# Get database URL from environment variable or use local development default
# database_url = os.getenv("DATABASE_URL", "postgresql://postgres:your-super-secret-and-long-postgres-password@127.0.0.1:5435/postgres")

# database_url = os.getenv("DATABASE_URL", "postgresql://postgres:sOxpF4SsploP3arq@db.iojdlaqvohuebsexmbad.supabase.co:5432/postgres")
database_url = os.getenv("DATABASE_URL", "postgresql://postgres.iojdlaqvohuebsexmbad:sOxpF4SsploP3arq@aws-1-eu-central-1.pooler.supabase.com:5432/postgres")

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
tools = []
tools = toolkit.get_tools()
sql_tools = toolkit.get_tools()

# @tool(response_format="content_and_artifact")
# async def retrieve_context(query: str):
#     """Retrieve information about the documents table to help answer a query using vector search."""
#     retrieved_docs = await embedding_service.search_documents(query, limit=2)
#     serialized = "\n\n".join(
#         (f"Source: {doc["metadata"]["source"]}\nContent: {doc["content"]}")
#         for doc in retrieved_docs 
#     )
#     return serialized, retrieved_docs

# tools.append(retrieve_context)

# tools.append(qualify_query)


# @tool
# def get_user_info(
#     runtime: ToolRuntime
# ) -> str:
#     """Look up user info."""
#     user_id = runtime.state["user_id"]
#     print(f"Run time state: {runtime.state}")
#     print(f"Getting info for user_id: {user_id}")
#     return "User is John Smith" if user_id == "user_123" else "Unknown user"

# tools.append(get_user_info)

# @tool
# def update_user_info(
#     runtime: ToolRuntime[CustomContext, CustomState],
# ) -> Command:
#     """Look up and update user info."""
#     user_id = runtime.context.user_id 
#     print(f"Updating info for user_id: {user_id}")
#     name = "John Smith" if user_id == "user_123" else "Unknown user"
#     return Command(update={  
#         "user_name": name,
#         # update the message history
#         "messages": [
#             ToolMessage(
#                 "Successfully looked up user information",
#                 tool_call_id=runtime.tool_call_id
#             )
#             # AIMessage(f"Wait before calling the greet tool, or any other tool, ensuring state is updated by successfully completing this too, This can be checked with the tool message")     
#         ]
#     })

# tools.append(update_user_info)

# @tool
# def greet(
#     runtime: ToolRuntime[CustomContext, CustomState]
# ) -> str:
#     """Use this to greet the user once you found their info."""
#     print(f"Run time state in greet: {runtime.state}")
#     print(f"Run time context in greet: {runtime.context}")
#     print(f"Runtime config: {runtime.config}")
#     print(f"Runtime store: {runtime.store}")
#     user_name = runtime.state["user_name"]
#     return f"Hello {user_name}!"

# tools.append(greet)
pprint(f"Available Tools: {tools}")

# TypedDict defines the structure of user information for the LLM
class UserInfo(TypedDict):
    name: str
# @tool
# def save_user_info(user_info: UserInfo, runtime: ToolRuntime[CustomContext]) -> str:
#     """Save user info."""
#     # Access the store - same as that provided to `create_agent`
#     print("runtime store:", runtime.store)
#     store = runtime.store 
#     user_id = runtime.context.user_id 
#     # Store data in the store (namespace, key, data)
#     store.put(("users",), user_id, user_info) 
#     return "Successfully saved user info."

# tools.append(save_user_info)


# @tool
# def get_user_info(runtime: ToolRuntime[CustomContext]) -> str:
#     """Look up user info."""
#     # Access the store - same as that provided to `create_agent`
#     store = runtime.store 
#     user_id = runtime.context.user_id
#     # Retrieve data from store - returns StoreValue object with value and metadata
#     if store is not None:
#         user_info = store.get(("users",), user_id)
#         return str(user_info.value) if user_info else "Unknown user"
#     else:
#         return "Store is not available."

# tools.append(get_user_info)

# tools.append(refine_query_subagent1)
# tools.append(BraveSearch())

class QueryEvaluation(BaseModel):
    """Evaluate the quality of the query"""
    rating: int | None = Field(description="The rating of the product", ge=1, le=5)
    result: Literal["pass", "fail"] = Field(description="The result of whether the query is detailed or not.")
    suggestions: list[str] = Field(description="Query suggestions based on available data.")

@tool
def qualify_query(query: str) -> QueryEvaluation:
    """Validate whether a user query is specific enough for the agent.
    Returns a QueryEvaluation model with fields:
      - result: "pass" or "fail"
      - rating: optional integer rating (None by default)
      - suggestions: list of suggestions strings
    """
    q = (query or "").strip()
    suggestions: list[str] = []

    if not q:
        return QueryEvaluation(result="fail", rating=None, suggestions=["Query is empty. Provide a question or request."])

    words = q.split()

    # Basic heuristics
    if len(words) < 3:
        suggestions.append("Make the query more specific (at least 3 words).")
    if "?" not in q and not q.lower().startswith(
        ("show", "list", "get", "how", "what", "who", "when", "where", "calculate", "count", "find")
    ):
        suggestions.append("Frame the query as a question or specify the intended action (e.g., 'Show total sales in 2024').")
    if not any(t in q.lower() for t in ("date", "range", "last", "month", "year", "from", "to")):
        suggestions.append("If relevant, include a date range or timeframe (e.g., 'last month').")

    passed = len(suggestions) == 0
    return QueryEvaluation(result="pass" if passed else "fail", rating=None, suggestions=[] if passed else suggestions)

tools.append(qualify_query)
