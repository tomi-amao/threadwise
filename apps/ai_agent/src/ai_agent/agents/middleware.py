"""Middleware for query validation and routing in the ThreadWise Financial Agent.

This module implements a middleware chain that:
1. Classifies queries into three categories:
   - Financial Reports: P&L, Balance Sheet, Cash Flow (requires strict validation)
   - Database Analytics: Data exploration queries (flexible, no validation)
   - Generic: Conversational queries (no database access)
2. Routes to appropriate handlers based on classification:
   - Generic: Generic prompt, no SQL tools
   - Database Analytics: Analytics prompt with SQL tools for flexible queries
   - Financial Report (passed quality): SQL financial prompt with tools
   - Financial Report (failed quality): Suggestion prompt with tools for guidance
"""

import json
import logging
from functools import lru_cache
from typing import Any, Callable, List, Literal, Optional

from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentState,
    ModelRequest,
    ModelResponse,
    before_model,
    wrap_model_call,
)
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field

from .prompts import (
    analytics_system_prompt,
    check_financial_prompt,
    generic_system_prompt,
    sql_system_prompt,
    validate_financial_prompt_against_database,
)
from ..core.config import get_local_llm
from ..tools.sql_tools import get_sql_tools

# Configure logging
logger = logging.getLogger(__name__)


# =============================================================================
# PYDANTIC MODELS
# =============================================================================


class QueryTypeClassification(BaseModel):
    """Structured output for query type classification."""

    query_type: Literal["financial_report", "database_analytics", "generic"] = Field(
        description="Type of query: financial_report, database_analytics, or generic"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score (0.0-1.0)")
    reasoning: str = Field(description="Brief explanation of the classification")


class FinancialQueryValidation(BaseModel):
    """Structured output for financial query validation."""

    status: Literal["pass", "fail", "clarification_required"] = Field(
        description="'pass' if query is detailed enough, 'fail' if needs clarification"
    )
    intent_clarity: Literal["pass", "fail"] = Field(
        description="'pass' if intent is clear, 'fail' if vague"
    )
    temporal_scope: Literal["pass", "fail"] = Field(
        description="'pass' if temporal scope is clear, 'fail' if ambiguous"
    )
    missing_information: List[str] = Field(
        default_factory=list, description="List of missing information if any"
    )
    clarification_questions: List[str] = Field(
        default_factory=list, description="Clarification questions to ask the user"
    )
    suggestions: List[str] = Field(
        default_factory=list, description="Suggested alternative queries based on available data"
    )


class Suggestion(BaseModel):
    """Suggestion for improving a query."""

    description: str = Field(
        ..., description="Human-readable explanation of a suggested alternative query"
    )
    example_query: str = Field(
        ..., description="An example of a rewritten user query grounded in available data"
    )


class QueryState(AgentState):
    """Custom state schema for the agent with query classification fields.

    Note: AgentState is a TypedDict, so we use annotation-only syntax without defaults.
    Use state.get("field", default) to access with defaults.
    """

    query_type: Literal["financial_report", "database_analytics", "generic"] | None
    is_query_quality_passed: bool | None
    query_suggestions: List[Suggestion] | List[str] | None
    issues: List[str] | None


# =============================================================================
# LAZY MODEL INITIALIZATION
# =============================================================================


@lru_cache(maxsize=1)
def _get_classification_model():
    """Get or create the classification model (lazy singleton)."""
    return get_local_llm("qwen/qwen3-vl-4b")


@lru_cache(maxsize=1)
def _get_type_classifier():
    """Get or create the type classifier with structured output (lazy singleton)."""
    return _get_classification_model().with_structured_output(QueryTypeClassification)


@lru_cache(maxsize=1)
def _get_validation_agent():
    """Get or create the validation agent (lazy singleton)."""
    return create_agent(
        _get_classification_model(),
        system_prompt=check_financial_prompt,
        response_format=FinancialQueryValidation,
    )


@lru_cache(maxsize=1)
def _get_validation_agent_with_tools():
    """Get or create the validation agent with SQL tools (lazy singleton)."""
    return create_agent(
        _get_classification_model(),
        tools=get_sql_tools(),
        system_prompt=validate_financial_prompt_against_database,
    )


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def _get_last_human_message(messages: list) -> Optional[HumanMessage]:
    """Extract the last human message from the message list."""
    for msg in reversed(messages):
        if isinstance(msg, HumanMessage):
            return msg
    return None


def _is_tool_response_context(messages: list) -> bool:
    """Check if the last message is a tool response (skip validation in this case)."""
    if not messages:
        return False
    return isinstance(messages[-1], (ToolMessage, AIMessage))


def _extract_query_text(human_msg: HumanMessage) -> str:
    """Extract text content from a HumanMessage (handles both string and list content)."""
    raw_content = human_msg.content
    if isinstance(raw_content, list):
        return " ".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in raw_content
        )
    return str(raw_content)


# =============================================================================
# CLASSIFICATION MIDDLEWARE
# =============================================================================


@before_model(state_schema=QueryState, can_jump_to=["end", "model"])
async def classify_query(state: QueryState, runtime: Runtime) -> dict[str, Any] | None:
    """Classify query type and validate quality for financial reports.

    This middleware classifies queries into three categories:
    1. financial_report: P&L, Balance Sheet, Cash Flow → Requires validation
    2. database_analytics: Data exploration queries → No validation needed
    3. generic: Conversational queries → No validation needed

    Only financial reports go through quality validation.

    Returns:
        dict with state updates including:
        - query_type: str
        - is_query_quality_passed: bool | None
        - query_suggestions: list[Suggestion] (if failed)
        - issues: list[str] (if failed)
    """
    logger.info("=== Running Query Classification Middleware ===")

    messages = state.get("messages", [])

    # Skip if this is a tool response or continuation
    if _is_tool_response_context(messages):
        logger.debug("Skipping classification - tool response context detected")
        return None

    # Get the last human message
    human_msg = _get_last_human_message(messages)
    if not human_msg:
        logger.debug("No human message found, skipping classification")
        return None

    user_query = _extract_query_text(human_msg)

    if not user_query or not user_query.strip():
        logger.warning("Empty query received")
        return {"query_type": "generic", "is_query_quality_passed": True}

    logger.info(f"Processing query: {user_query[:100]}...")

    try:
        # Step 1: Classify query type
        classification = await _classify_query_type(user_query)
        query_type = classification["query_type"]

        logger.info(
            f"Query classified as: {query_type.upper()} "
            f"(confidence: {classification['confidence']:.2f})"
        )
        logger.debug(f"Reasoning: {classification.get('reasoning', 'N/A')}")

        # Step 2: Only validate quality for FINANCIAL REPORTS
        if query_type == "financial_report":
            logger.info("Financial report detected - running quality validation...")
            quality_result = await _validate_financial_query(user_query)
            logger.info(f"Quality validation result: {quality_result.get('status')}")
            
            return {
                "query_type": "financial_report",
                "is_query_quality_passed": quality_result["status"],
                "query_suggestions": quality_result["query_suggestions"],
                "issues": quality_result["issues"],
            }

        # Database analytics and generic queries skip validation
        logger.info(f"{query_type.upper()} query - skipping validation")
        return {
            "query_type": query_type,
            "financial_confidence": classification["confidence"],
            "is_query_quality_passed": True,
            "query_suggestions": None,
            "issues": None,
        }

    except Exception as e:
        logger.error(f"Error in query classification: {e}", exc_info=True)
        # Default to database_analytics if classification fails (safe fallback with SQL tools)
        return {
            "query_type": "database_analytics",
            "financial_confidence": 0.5,
            "is_query_quality_passed": True,
        }


async def _classify_query_type(user_query: str) -> dict[str, Any]:
    """Classify query into financial_report, database_analytics, or generic.

    Financial reports: P&L, Balance Sheet, Cash Flow - need strict validation
    Database analytics: Data exploration (top customers, sales trends) - need SQL but flexible
    Generic: Conversational, explanations, non-data queries

    Returns:
        dict with 'query_type' (str), 'confidence' (float), and 'reasoning' (str)
    """
    classification_prompt = f"""Analyze this query and classify it into ONE of three categories:

Query: "{user_query}"

**Classification Categories:**

1. **financial_report**: Requests for formal financial statements
   - Income Statement, P&L, Profit and Loss
   - Balance Sheet, Statement of Financial Position
   - Cash Flow Statement, Statement of Cash Flows
   - These require specific time periods and entity context

2. **database_analytics**: Data exploration and business intelligence queries
   - "Who ordered the most in March?"
   - "Show top 10 customers by revenue"
   - "What products sold best last quarter?"
   - "Compare sales between regions"
   - "List all customers who spent over $1000"
   - "What is the average order value?"
   - These are flexible SQL queries for insights and data exploration

3. **generic**: Non-data queries and conversational questions
   - Explanations of financial concepts
   - General business advice
   - Questions about how to use the system
   - Casual conversation
   - No database access needed
   - Examples: "What is the difference between revenue and profit?", "How do I read a cash flow statement?"

**Classification Rules:**
- If asking for a specific financial REPORT/STATEMENT → financial_report
- If asking to EXPLORE/ANALYZE/QUERY the data → database_analytics  
- If asking for EXPLANATION/ADVICE/GENERAL HELP → generic

Return:
- query_type: One of the three categories (financial_report, database_analytics, or generic)
- confidence: 0.0 to 1.0
- reasoning: Brief explanation of why you chose this category"""

    result = await _get_type_classifier().ainvoke([
        {
            "role": "system",
            "content": "You classify queries into financial reports, data analytics, or generic conversation. Be precise and consider the user's intent.",
        },
        {"role": "user", "content": classification_prompt},
    ])

    # Handle both structured output and dict responses
    if isinstance(result, dict):
        return {
            "query_type": result.get("query_type", "generic"),
            "confidence": result.get("confidence", 0.5),
            "reasoning": result.get("reasoning", ""),
        }
    
    return {
        "query_type": getattr(result, "query_type", "generic"),
        "confidence": getattr(result, "confidence", 0.5),
        "reasoning": getattr(result, "reasoning", ""),
    }


async def _validate_financial_query(user_query: str) -> dict[str, Any]:
    """Validate the quality of a financial report query.

    This function:
    1. Checks if the query has missing information (entity, time period, etc.)
    2. If missing info is found, queries the database to provide grounded suggestions
    3. Returns validation status, issues, and suggestions

    Returns:
        dict with:
        - status: "pass", "partial", or "fail"
        - query_suggestions: List[Suggestion] objects with descriptions and examples
        - issues: List[str] of identified problems
    """
    logger.info("Running initial validation check")

    # Step 1: Basic validation without database context
    initial_validation = await _get_validation_agent().ainvoke({
        "messages": [{"role": "user", "content": user_query}]
    })

    validation_result = initial_validation["structured_response"]
    logger.info(f"Initial validation completed: status={validation_result.status}")

    # If query is invalid, return immediately
    if validation_result.missing_information:
        logging.info("Query validation failed - missing information detected")
        return {
            "status": "fail",
            "query_suggestions": validation_result.clarification_questions,
            "issues": validation_result.missing_information,
        }

    # Step 2: Query has issues - get database-grounded suggestions
    logger.info("Query requires clarification - fetching database-grounded suggestions")
    
    validation_prompt = (
        f"Help me improve this query by addressing the problems with it:\n"
        f"{user_query}\n\n"
        f"These are the issues found:\n"
        f"{', '.join(validation_result.missing_information)}\n\n"
        f"Provide suggestions based on actual data in the database by querying it."
    )

    database_validation = await _get_validation_agent_with_tools().ainvoke({
        "messages": [{"role": "user", "content": validation_prompt}]
    })

    # Parse the last message content
    last_message_content = database_validation["messages"][-1].content
    
    try:
        validation_data = json.loads(last_message_content)
    except json.JSONDecodeError:
        logger.error("Failed to parse validation response as JSON", exc_info=True)
        return {
            "status": "fail",
            "query_suggestions": validation_result.clarification_questions,
            "issues": validation_result.missing_information,
        }

    # Extract and format suggestions
    suggestions = []
    for item in validation_data.get("suggestions", []):
        suggestions.append({
            "description": item.get("description", ""),
            "example_query": item.get("example_query", ""),
        })

    logger.info(f"Validation complete: status={validation_data.get('status')}, "
                f"{len(suggestions)} suggestions generated")

    return {
        "status": validation_data.get("status", "fail"),
        "query_suggestions": suggestions,
        "issues": validation_data.get("issues", validation_result.missing_information),
    }


# =============================================================================
# ROUTING MIDDLEWARE
# =============================================================================


def _format_suggestions_for_prompt(suggestions: List[dict]) -> List[str]:
    """Format suggestion dicts into readable strings for the prompt."""
    formatted = []
    for sug in suggestions:
        if isinstance(sug, dict):
            desc = sug.get("description", "")
            example = sug.get("example_query", "")
            formatted.append(f"{desc} Example: {example}")
        else:
            formatted.append(str(sug))
    return formatted


@wrap_model_call(state_schema=QueryState)
async def route_and_configure(
    request: ModelRequest,
    handler: Callable[[ModelRequest], ModelResponse],
) -> ModelResponse:
    """Route queries and configure model based on classification results.

    This middleware handles FOUR distinct paths:

    1. GENERIC QUERIES:
       - System prompt: generic_system_prompt
       - Tools: None (no SQL tools needed)
       - For explanations, advice, casual conversation

    2. DATABASE ANALYTICS QUERIES:
       - System prompt: analytics_system_prompt (data exploration expert)
       - Tools: sql_tools (for flexible data queries)
       - For "who ordered the most", "top 10 customers", etc.

    3. FINANCIAL REPORTS - QUALITY PASSED:
       - System prompt: sql_system_prompt (strict financial reporting)
       - Tools: sql_tools (for formal report generation)
       - For P&L, Balance Sheet, Cash Flow with proper context

    4. FINANCIAL REPORTS - QUALITY FAILED:
       - System prompt: Dynamic clarification prompt
       - Tools: None (suggestions only, no SQL execution)
       - Context: Includes suggestions and issues from validation
    """
    query_type = request.state.get("query_type", "generic")
    query_quality_passed = request.state.get("is_query_quality_passed", True)

    logger.info("=== Routing Query ===")
    logger.info(f"  query_type: {query_type}")
    logger.info(f"  quality_passed: {query_quality_passed}")

    # PATH 1: Generic queries → No SQL tools
    if query_type == "generic":
        logger.info("→ Routing to GENERIC handler")
        return await handler(
            request.override(
                system_prompt=generic_system_prompt,
                tools=[],
            )
        )

    # PATH 2: Database analytics → SQL tools with flexible prompt
    if query_type == "database_analytics":
        logger.info("→ Routing to DATABASE ANALYTICS handler")
        return await handler(
            request.override(
                system_prompt=analytics_system_prompt,
                tools=get_sql_tools(),
            )
        )

    # PATH 3: Financial reports that passed → Strict financial prompt
    if query_type == "financial_report" and query_quality_passed in ["pass", "partial"]:
        logger.info("→ Routing to FINANCIAL REPORT handler (quality passed)")
        return await handler(
            request.override(
                system_prompt=sql_system_prompt,
                tools=get_sql_tools(),
            )
        )

    # PATH 4: Financial reports that failed → Suggestions
    logger.info("→ Routing to SUGGESTION handler (quality failed)")

    # Build clarification context from state
    suggestions = request.state.get("query_suggestions", [])
    issues = request.state.get("issues", [])

    # Format for the prompt
    formatted_issues = [str(issue) for issue in issues]
    formatted_suggestions = _format_suggestions_for_prompt(suggestions)

    clarification_prompt = f"""You are a Financial assistant. The user asked a financial/accounting question, but it needs more detail before we can generate an accurate report.

The following issues have been identified with the query:
{', '.join(formatted_issues)}

The following suggestions have been gathered to improve the query:
{'; '.join(formatted_suggestions)}

Your job is to inform the user about these issues and advise them on refining their query accordingly, using the suggestions and reasoning provided."""

    return await handler(
        request.override(
            system_prompt=clarification_prompt,
            messages=list(request.state.get("messages", [])),
            tools=[],
        )
    )
