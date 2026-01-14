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
from langchain.agents.middleware import (
    SummarizationMiddleware, 
    LLMToolSelectorMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from utils.workflow import middleware_chain, all_workflow_tools, WorkflowState
from utils.middleware_simplified import classify_query, route_and_configure


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

# Structured workflow middleware chain:
# 1. apply_workflow_step: State machine that routes through:
#    - query_classifier → classify query type
#    - database_inspector → validate DB schema (financial reports only)
#    - quality_gate → check query detail (financial reports only)
#    - executor → execute with appropriate prompt/tools
# 2. model_call_limit: Prevent infinite loops from repeated model calls
# 3. tool_call_limit: Prevent excessive database queries
# 4. summarize_middleware: Summarize conversation to manage context length
middleware = [
    *middleware_chain,      # Workflow state machine (single @wrap_model_call middleware)
    model_call_limit,       # Limit model invocations to prevent loops
    tool_call_limit,        # Limit tool calls to prevent excessive queries
    summarize_middleware,   # Summarize conversation to manage context length
]

middleware_simplified = [
    classify_query,
    route_and_configure
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



