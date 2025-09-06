"""LangGraph Financial AI Agent.

Multi-node graph for financial data analysis and reporting.
"""

from langgraph.graph import StateGraph

from utils.nodes import analyze_question, generate_response
from utils.state import State, Context
from utils.settings import get_local_llm
from langgraph.prebuilt import create_react_agent
from utils.tools import tools
from utils.prompts import sql_system_prompt

model = get_local_llm()
# Define the graph
# graph = (
#     StateGraph(State, context_schema=Context)
#     .add_node("analyze", analyze_question)
#     .add_node("respond", generate_response)
#     .add_edge("__start__", "analyze")
#     .add_edge("analyze", "respond")
#     .compile(name="threadwise-financial-agent")
# )

agent = create_react_agent(
    model,
    tools,
    prompt=sql_system_prompt,
)