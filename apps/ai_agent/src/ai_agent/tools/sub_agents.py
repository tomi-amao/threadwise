"""Sub-agents for query processing and validation.

Contains specialized agents for query qualification, prompt selection, etc.
All agent creation is deferred to first use to avoid blocking startup.
"""

from functools import lru_cache
from typing import Literal

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from pydantic import BaseModel, Field

from ..core.config import get_chat_model

# =============================================================================
# PYDANTIC MODELS
# =============================================================================


class QueryEvaluation(BaseModel):
    """Evaluate the quality of the query."""

    rating: int | None = Field(description="The rating of the product", ge=1, le=5)
    result: Literal["pass", "fail"] = Field(
        description="The result of whether the query is detailed or not."
    )
    suggestions: list[str] = Field(
        description="Query suggestions based on available data."
    )


# =============================================================================
# LAZY SUB-AGENT INITIALIZATION
# =============================================================================


@lru_cache(maxsize=1)
def _get_sub_agent_model():
    """Get or create the sub-agent model (lazy singleton)."""
    return get_chat_model("google_genai:gemini-2.5-flash-lite")


@lru_cache(maxsize=1)
def _get_qualify_query_agent():
    """Get or create the query qualification agent (lazy singleton)."""
    return create_agent(
        _get_sub_agent_model(),
        system_prompt="Evaluate whether the query is detailed enough.",
        response_format=QueryEvaluation,
    )


# =============================================================================
# TOOLS
# =============================================================================


@tool(
    "query_qualifier_agent",
    description="Use this tool agent when wanting to qualify the query the of the human's query. Always use this agent to determine whether the query is detailed enough.",
)
def qualify_query(query: str, request, runtime: ToolRuntime):
    """Validate whether a user query is specific enough for the agent.

    Always use this tool to validate the query before proceeding.

    Args:
        query: The user's query to validate
        request: The request object
        runtime: Tool runtime context

    Returns:
        Query qualification result with suggestions
    """
    qualify_query_agent = _get_qualify_query_agent()
    result = qualify_query_agent.invoke(
        {"messages": [{"role": "user", "content": query}]}
    )
    print("Query Qualification Result:", result["messages"][-1].content)
    return result["messages"][-1].content
