from typing import Literal, TypedDict
from langchain.tools import tool
from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from pydantic import BaseModel, Field
from .prompts import available_prompts
from .settings import get_chat_model, get_local_llm

from langchain.tools import tool, ToolRuntime


class QueryEvaluation(BaseModel):
    """Evaluate the quality of the query"""
    rating: int | None = Field(description="The rating of the product", ge=1, le=5)
    result: Literal["pass", "fail"] = Field(description="The result of whether the query is detailed or not.")
    suggestions: list[str] = Field(description="Query suggestions based on available data.")
    
model = get_chat_model("google_genai:gemini-2.5-flash-lite")

prompt_agent_system = f"""Here are a list of prompts. Decide which prompt to use based on context relevance
{', '.join([f'"{key}"' for key in available_prompts.keys()])}.
"""
qualify_query_agent = create_agent(model, system_prompt="Evaluate whether the query is detailed enough.", response_format=QueryEvaluation)



@tool(
    "query_qualifier_agent",
    description="Use this tool agent when wanting to qualify the query the of the human's query. Always use this agent to determine whether the query is detailed enough.",
)
def qualify_query(query: str, request, runtime: ToolRuntime):
    """Validate whether a user query is specific enough for the agent. Always use this tool to validate the query before proceeding."""
    result = qualify_query_agent.invoke({
        "messages": [{"role": "user", "content": query}]
    })
    print("Query Qualification Result:", result["messages"][-1].content)
    return result["messages"][-1].content

