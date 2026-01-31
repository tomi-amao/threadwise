"""Sub-agents for query processing and validation.

Contains specialized agents for query qualification, prompt selection, etc.
"""

from typing import Literal

from langchain.tools import tool, ToolRuntime
from langchain.agents import create_agent
from pydantic import BaseModel, Field

from ..core.config import get_chat_model, get_local_llm


# =============================================================================
# PYDANTIC MODELS
# =============================================================================


class QueryEvaluation(BaseModel):
    """Evaluate the quality of the query."""
    rating: int | None = Field(
        description="The rating of the product", 
        ge=1, 
        le=5
    )
    result: Literal["pass", "fail"] = Field(
        description="The result of whether the query is detailed or not."
    )
    suggestions: list[str] = Field(
        description="Query suggestions based on available data."
    )


# =============================================================================
# SUB-AGENTS
# =============================================================================

# Model for sub-agents
model = get_chat_model("google_genai:gemini-2.5-flash-lite")

# Query qualification agent
qualify_query_agent = create_agent(
    model, 
    system_prompt="Evaluate whether the query is detailed enough.", 
    response_format=QueryEvaluation
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
    result = qualify_query_agent.invoke({
        "messages": [{"role": "user", "content": query}]
    })
    print("Query Qualification Result:", result["messages"][-1].content)
    return result["messages"][-1].content
