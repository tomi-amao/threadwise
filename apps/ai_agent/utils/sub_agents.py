from typing import Literal, TypedDict
from langchain.tools import tool
from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from .prompts import available_prompts
from .settings import get_local_llm

class PromptDecision(TypedDict):
    """Analysis of a product review."""
    prompt: str 
    
model = get_local_llm(model_name="qwen/qwen3-vl-4b")

prompt_agent_system = f"""Here are a list of prompts. Decide which prompt to use based on context relevance
{', '.join([f'"{key}"' for key in available_prompts.keys()])}.
"""
subagent1 = create_agent(model, system_prompt="Refine and improve user queries for better understanding.")
prompt_agent = create_agent(model, system_prompt=prompt_agent_system, response_format=ToolStrategy(PromptDecision))

@tool(
    "refine_query_subagent1",
    description="Use this tool to refine and improve user queries for better understanding by calling Subagent 1.",
)
def refine_query_subagent1(query: str):
    result = subagent1.invoke({
        "messages": [{"role": "user", "content": query}]
    })
    return result["messages"][-1].content

