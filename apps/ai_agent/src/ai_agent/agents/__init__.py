"""Agents module for ThreadWise AI Agent.

Contains LangGraph agents, middleware, prompts, and graph configurations.
"""

from .prompts import (
    sql_system_prompt,
    generic_system_prompt,
    analytics_system_prompt,
    available_prompts,
    income_statement_prompt,
    balance_sheet_prompt,
    cash_flow_statement_prompt,
    report_type_prompts,
    invoice_extraction_prompt,
    check_financial_prompt,
    validate_financial_prompt_against_database,
)
from .middleware import (
    classify_query,
    route_and_configure,
    QueryState,
    QueryTypeClassification,
    FinancialQueryValidation,
)

# Import agent graphs (lazy to avoid circular imports)
# Use: from ai_agent.agents.graph_agent import agent
# Use: from ai_agent.agents.agent import agent

__all__ = [
    # Prompts
    "sql_system_prompt",
    "generic_system_prompt",
    "analytics_system_prompt",
    "available_prompts",
    "income_statement_prompt",
    "balance_sheet_prompt",
    "cash_flow_statement_prompt",
    "report_type_prompts",
    "invoice_extraction_prompt",
    "check_financial_prompt",
    "validate_financial_prompt_against_database",
    # Middleware
    "classify_query",
    "route_and_configure",
    "QueryState",
    "QueryTypeClassification",
    "FinancialQueryValidation",
]
