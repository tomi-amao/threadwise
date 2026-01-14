"""LangGraph Financial AI Agent.

Multi-node graph for financial data analysis and reporting.
"""

from langgraph.graph import StateGraph

from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    SummarizationMiddleware,
    ToolCallLimitMiddleware,
)

from utils.middleware_simplified import classify_query, route_and_configure
from utils.nodes import analyze_question, generate_response
from utils.prompts import dynamic_system_prompt, sql_system_prompt
from utils.settings import CustomContext, CustomState, get_chat_model, get_local_llm
from utils.state import Context, State
from utils.tools import sql_tools, tools


# model = get_chat_model("gemini-2.5-flash")
helper_model = get_local_llm("qwen/qwen3-vl-4b")    
model = get_local_llm("qwen/qwen3-vl-4b")    
# Define the graph
# graph = (
#     StateGraph(State, context_schema=Context)
#     .add_node("analyze", analyze_question)
#     .add_node("respond", generate_response)
#     .add_edge("__start__", "analyze")
#     .add_edge("analyze", "respond")
#     .compile(name="threadwise-financial-agent")
# )

# Middleware for context management
summarize_middleware = SummarizationMiddleware(
    model=helper_model,
    trigger=("tokens", 4000),
    keep=("messages", 20),
)

# Middleware to prevent runaway loops
model_call_limit = ModelCallLimitMiddleware(
    run_limit=40,  # Maximum 10 model invocations (classifier + inspector + quality + executor + few retries)
    exit_behavior='end',  # Gracefully end execution when limit exceeded
)

tool_call_limit = ToolCallLimitMiddleware(
    run_limit=40,  # Maximum 12 tool calls (3 workflow tools + ~9 SQL queries max)
    exit_behavior='end',  # Gracefully end execution to prevent infinite loops
)

# Middleware for managing the agent's behavior:
# 1. classify_query: Classifies queries and validates financial reports
# 2. route_and_configure: Routes to appropriate handler with correct prompt/tools
# 3. model_call_limit: Prevents infinite loops from repeated model calls
# 4. tool_call_limit: Prevents excessive database queries
# 5. summarize_middleware: Summarizes conversation to manage context length
middleware = [
    classify_query,         # Classification and validation middleware
    route_and_configure,    # Routing and configuration middleware
    model_call_limit,       # Limit model invocations to prevent loops
    tool_call_limit,        # Limit tool calls to prevent excessive queries
    summarize_middleware,   # Summarize conversation to manage context length
]

middleware_simplified = [
    classify_query,
    route_and_configure,
]


agent = create_agent(
    model,
    # tools=all_workflow_tools,  # All tools needed for workflow (classification, inspection, quality, SQL)
    # system_prompt=sql_system_prompt,  # Default prompt (overridden by workflow at each step)
    middleware=middleware_simplified,
    tools=sql_tools,
    # state_schema=WorkflowState,  # Use WorkflowState for current_step tracking
    # context_schema=CustomContext,
)



