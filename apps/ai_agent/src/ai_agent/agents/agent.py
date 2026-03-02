"""LangGraph Financial AI Agent.

Multi-node graph for financial data analysis and reporting.
All heavy initialization is deferred to first request via lazy singletons.
"""

from functools import lru_cache
from typing import Annotated, Sequence
from langgraph.graph.ui import AnyUIMessage, ui_message_reducer

from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    SummarizationMiddleware,
    ToolCallLimitMiddleware,
)

# Import from package modules (relative imports)
from .middleware import classify_query, route_and_configure
from ..core import CustomContext, CustomState, get_chat_model, get_local_llm, State, Context
from ..tools.sql_tools import get_sql_tools


# Custom state schema with UI support for generative UI
class FinancialAgentState(AgentState):
    """State schema for the financial agent with UI message support."""
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]


# =============================================================================
# LAZY LLM AND MIDDLEWARE INITIALIZATION
# =============================================================================


@lru_cache(maxsize=1)
def _get_helper_model():
    """Get or create the helper model (lazy singleton)."""
    return get_local_llm("qwen/qwen3-vl-4b")


@lru_cache(maxsize=1)
def _get_model():
    """Get or create the main model (lazy singleton)."""
    return get_local_llm("qwen/qwen3-vl-4b")


@lru_cache(maxsize=1)
def _get_middleware():
    """Build the middleware stack (lazy singleton)."""
    summarize_middleware = SummarizationMiddleware(
        model=_get_helper_model(),
        trigger=("tokens", 4000),
        keep=("messages", 20),
    )
    model_call_limit = ModelCallLimitMiddleware(
        run_limit=40,
        exit_behavior='end',
    )
    tool_call_limit = ToolCallLimitMiddleware(
        run_limit=40,
        exit_behavior='end',
    )
    return [
        classify_query,
        route_and_configure,
        model_call_limit,
        tool_call_limit,
        summarize_middleware,
    ]


agent = create_agent(
    _get_model(),
    tools=get_sql_tools(),
    state_schema=FinancialAgentState,
)
