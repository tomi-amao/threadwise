"""LangGraph Financial AI Agent.

Multi-node graph for financial data analysis and reporting.
"""

from langgraph.graph import StateGraph

from utils.nodes import analyze_question, generate_response
from utils.state import State, Context
from utils.settings import CustomContext, CustomState, get_chat_model, get_local_llm
from langchain.agents import create_agent, AgentState
from utils.tools import tools, sql_tools
from utils.prompts import dynamic_system_prompt, sql_system_prompt
from langchain.agents.middleware import SummarizationMiddleware, LLMToolSelectorMiddleware
from utils.middleware import classify_and_grade_query, route_and_configure


# model = get_chat_model("gemini-2.5-flash")
helper_model = get_local_llm("qwen/qwen3-vl-4b")    
model = get_local_llm("mistralai/ministral-3-14b-reasoning")    
# Define the graph
# graph = (
#     StateGraph(State, context_schema=Context)
#     .add_node("analyze", analyze_question)
#     .add_node("respond", generate_response)
#     .add_edge("__start__", "analyze")
#     .add_edge("analyze", "respond")
#     .compile(name="threadwise-financial-agent")
# )
summarize_middleware = SummarizationMiddleware(
    model=helper_model,
    trigger=("tokens", 4000),
    keep=("messages", 20),
)

# Refactored middleware chain:
# 1. classify_and_grade_query: Single pass for financial classification + quality grading
# 2. route_and_configure: Routes to appropriate prompt/tools based on classification
middleware = [
    classify_and_grade_query,  # @before_model: Classify financial + grade quality in one pass
    route_and_configure,       # @wrap_model_call: Route to correct prompt/tools
    summarize_middleware,      # Summarize conversation to manage context length
]



agent = create_agent(
    model,
    tools=sql_tools,  # Pass SQL tools - middleware will inject/remove them dynamically based on query type
    system_prompt=sql_system_prompt,
    middleware=middleware,
    # state_schema=QueryState,
    # context_schema=CustomContext,
)



