"""Middleware for query validation and routing in the ThreadWise Financial Agent.

This module implements a middleware chain that:
1. Classifies queries and grades quality in a single pass:
   - Determines if query is financial or non-financial
   - For financial queries, grades quality using SQL tools to check database context
2. Routes to appropriate handlers based on classification:
   - Non-financial: Generic prompt, no SQL tools
   - Financial + passed quality: SQL prompt with SQL tools for data retrieval
   - Financial + failed quality: Suggestion prompt with SQL tools for context-aware examples

Design Pattern:
- Single @before_model middleware for classification + grading (reduces LLM calls)
- Single @wrap_model_call for routing and tool/prompt injection
"""

import logging
from langchain.agents.middleware import (
    ModelRequest, 
    AgentMiddleware, 
    before_model, 
    after_model, 
    AgentState, 
    wrap_model_call, 
    ModelResponse,
)
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
from pydantic import BaseModel, Field
from typing import Any, Literal, Optional, Union
from typing_extensions import TypedDict
from langgraph.runtime import Runtime
from typing import Callable

from .settings import get_local_llm, get_chat_model
from .tools import sql_tools

from langchain.agents import create_agent
from .prompts import validation_prompt, sql_system_prompt, query_suggestion_prompt, generic_system_prompt

# Configure logging
logger = logging.getLogger(__name__)


class QueryState(AgentState):  
    """Custom state schema for the agent with query classification fields.
    
    Note: AgentState is a TypedDict, so we use annotation-only syntax without defaults.
    Use state.get("field", default) to access with defaults.
    """
    is_financial_query: bool | None  # Whether the query is financial/accounting related
    is_query_quality_passed: bool | None  # Whether the query passed quality check
    query_suggestions: list[str] | None  # Suggestions if query quality failed
    example_queries: list[str] | None  # Example queries for guidance
    financial_confidence: float | None  # Confidence score for financial classification
    database_context: str | None  # Cached database schema info for suggestions


class QueryClassificationResult(BaseModel):
    """Combined output for financial classification AND quality grading.
    
    This model is used when the query IS financial - we classify and grade in one pass.
    """
    is_financial: bool = Field(description="True if query is related to finance/accounting")
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score for financial classification (0.0-1.0)")
    quality_result: Literal["pass", "fail", "n/a"] = Field(
        description="'pass' if query is detailed enough, 'fail' if needs clarification, 'n/a' if not financial"
    )
    quality_rating: int | None = Field(default=None, ge=1, le=5, description="Quality rating 1-5, null if not financial")
    suggestions: list[str] = Field(default_factory=list, description="Actionable suggestions if quality failed")
    example_queries: list[str] = Field(default_factory=list, description="Example valid queries based on database schema")
    reasoning: str = Field(description="Brief explanation of the classification and quality assessment")


class FinancialRelevance(BaseModel):
    """Structured output for quick financial topic classification (fallback)."""
    
    is_financial: bool = Field(description="True if query is related to finance/accounting")
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score (0.0-1.0)")
    reasoning: str = Field(description="Brief explanation of the determination")


# Initialize models for classification
_classification_model = get_local_llm("mistralai/ministral-3-14b-reasoning")
# _classification_model = get_chat_model("gemini-2.5-flash")
_query_classifier = _classification_model.with_structured_output(QueryClassificationResult)
_financial_classifier = _classification_model.with_structured_output(FinancialRelevance)
# Validation agent has SQL tools to inspect database schema for grounding suggestions
_validation_agent = create_agent(_classification_model, system_prompt=validation_prompt, tools=sql_tools)


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
    last_msg = messages[-1]
    return isinstance(last_msg, (ToolMessage, AIMessage))


def _extract_query_text(human_msg: HumanMessage) -> str:
    """Extract text content from a HumanMessage (handles both string and list content)."""
    raw_content = human_msg.content
    if isinstance(raw_content, list):
        return " ".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in raw_content
        )
    return str(raw_content)


@before_model(state_schema=QueryState, can_jump_to=["end", "model"])
async def classify_and_grade_query(state: QueryState, runtime: Runtime) -> dict[str, Any] | None:
    """Combined middleware: Classify if query is financial AND grade quality in one pass.
    
    This middleware does two things:
    1. Determines if the query is financial/accounting related
    2. If financial, uses SQL tools to grade query quality against the actual database schema
    
    Flow:
    - Non-financial queries → Set is_financial_query=False, skip quality check
    - Financial queries → Use validation agent (with SQL tools) to grade quality
    
    Returns:
        dict with state updates including:
        - is_financial_query: bool
        - is_query_quality_passed: bool | None
        - query_suggestions: list[str] (if failed)
        - example_queries: list[str] (if failed)
        - database_context: str (cached schema info for suggestions)
    """
    logger.info("=== Running Query Classification & Quality Grading Middleware ===")

    messages = state.get("messages", [])
    
    # Skip if this is a tool response or continuation (agent is mid-conversation)
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
        return {"is_financial_query": False, "is_query_quality_passed": False}
    
    logger.info(f"Processing query: {user_query[:100]}...")

    # Step 1: Quick financial classification first
    try:
        classification = await _classify_financial_relevance(user_query)
        
        if not classification["is_financial"]:
            logger.info(f"Query classified as NON-FINANCIAL (confidence: {classification['confidence']:.2f})")
            return {
                "is_financial_query": False,
                "financial_confidence": classification["confidence"],
                "is_query_quality_passed": True,  # Mark as passed so it routes to generic handler
                "query_suggestions": None,
                "example_queries": None,
            }
        
        logger.info(f"Query classified as FINANCIAL (confidence: {classification['confidence']:.2f})")
        
        # Step 2: For financial queries, grade quality using validation agent with SQL tools
        quality_result = await _grade_query_quality(user_query)
        
        return {
            "is_financial_query": True,
            "financial_confidence": classification["confidence"],
            "is_query_quality_passed": quality_result["passed"],
            "query_suggestions": quality_result.get("suggestions"),
            "example_queries": quality_result.get("example_queries"),
            "database_context": quality_result.get("database_context"),
        }
        
    except Exception as e:
        logger.error(f"Error in query classification/grading: {e}", exc_info=True)
        # Default to financial + passed if classification fails (don't block user)
        return {
            "is_financial_query": True,
            "financial_confidence": 0.5,
            "is_query_quality_passed": True,
        }


async def _classify_financial_relevance(user_query: str) -> dict[str, Any]:
    """Classify if a query is financial/accounting related.
    
    Returns:
        dict with 'is_financial' (bool) and 'confidence' (float)
    """
    relevance_prompt = f"""Determine if this user query is related to financial or accounting topics:

Query: "{user_query}"

Consider the following as financial/accounting topics:
- Financial statements, balance sheets, income statements, cash flow
- Revenue, expenses, profits, losses
- Budgeting, forecasting, financial planning
- Accounting entries, transactions, bookkeeping
- Financial metrics, KPIs, ratios
- Business performance analysis
- Investment analysis, ROI calculations
- Tax-related queries
- Banking, payments, financial services
- Cost analysis, pricing
- Financial reporting and compliance

Also consider general business/operational queries that might need financial data.
Return your assessment with high confidence (>0.8) only if clearly financial/accounting-related."""

    result = await _financial_classifier.ainvoke([
        {"role": "system", "content": "You are a financial topic classifier. Analyze queries to determine if they relate to finance or accounting."},
        {"role": "user", "content": relevance_prompt},
    ])
    
    # Handle both structured output and dict responses
    if isinstance(result, dict):
        return {
            "is_financial": result.get('is_financial', False),
            "confidence": result.get('confidence', 0.0),
        }
    return {
        "is_financial": getattr(result, 'is_financial', False),
        "confidence": getattr(result, 'confidence', 0.0),
    }


async def _grade_query_quality(user_query: str) -> dict[str, Any]:
    """Grade the quality of a financial query using the validation agent with SQL tools.
    
    The validation agent uses SQL tools to:
    - Inspect available schemas, tables, and columns
    - Check what financial entities, time periods and metrics exist
    - Ground suggestions in actual database structure
    
    Returns:
        dict with:
        - 'passed': bool
        - 'suggestions': list[str] (if failed)
        - 'example_queries': list[str] (if failed)
        - 'database_context': str (schema info for later use)
    """
    logger.info("Running validation agent with SQL tools to grade query quality...")
    
    # Use the validation agent which has SQL tools to inspect the database
    validation_result = await _validation_agent.ainvoke({
        "messages": [{"role": "user", "content": user_query}]
    })
    
    last_message = validation_result.get("messages", [])[-1] if validation_result.get("messages") else None
    validation_text = getattr(last_message, 'text', str(last_message)) if last_message else ""
    
    logger.debug(f"Validation agent response: {validation_text[:300]}...")
    
    # Parse the validation result into structured format
    structured_result = await _query_classifier.ainvoke([
        {"role": "system", "content": """Extract the query evaluation result as structured data.
        
Focus on the quality_result field:
- 'pass': Query has enough detail (entity, time period, report type specified)
- 'fail': Query is too vague or missing required context
Make sure the confidence is a float between 0.0 and 1.0.
         

If the validation found issues, extract the suggestions and example queries."""},
        {"role": "user", "content": f"Validation agent response:\n{validation_text}\n\nOriginal query: {user_query}"},
    ])
    
    logger.info(f"Structured quality result: {structured_result}")
    
    # Parse structured output
    if isinstance(structured_result, dict):
        quality_result = structured_result.get('quality_result', 'pass')
        suggestions = structured_result.get('suggestions', [])
        example_queries = structured_result.get('example_queries', [])
    else:
        quality_result = getattr(structured_result, 'quality_result', 'pass')
        suggestions = getattr(structured_result, 'suggestions', [])
        example_queries = getattr(structured_result, 'example_queries', [])
    
    passed = quality_result == "pass"
    
    return {
        "passed": passed,
        "suggestions": suggestions if not passed else None,
        "example_queries": example_queries if not passed else None,
        "database_context": validation_text,  # Cache for later use in suggestions
    }


def _build_clarification_context(
    suggestions: list[str] | None, 
    example_queries: list[str] | None,
    database_context: str | None = None
) -> str:
    """Build context message for the model when query quality failed.
    
    This provides the model with:
    - The specific issues with the query
    - Database-grounded suggestions for improvement
    - Example queries that would work with the available schema
    """
    parts = ["⚠️ **Query Quality Check Failed**\n"]
    
    if suggestions:
        parts.append("The user's query needs clarification:\n")
        parts.extend(f"- {s}" for s in suggestions)
        parts.append("")
    
    if example_queries:
        parts.append("\nDatabase-grounded example queries:\n")
        parts.extend(f"- {eq}" for eq in example_queries)
        parts.append("")
    
    if database_context:
        parts.append(f"\nDatabase context from validation:\n{database_context[:500]}...")
    
    parts.append("\nUse this context to help the user refine their query.")
    
    return "\n".join(parts)


@wrap_model_call(state_schema=QueryState)
async def route_and_configure(
    request: ModelRequest,
    handler: Callable[[ModelRequest], ModelResponse],
) -> ModelResponse:
    """Route queries and configure model based on classification results.
    
    This middleware handles three distinct paths:
    
    1. NON-FINANCIAL QUERIES:
       - System prompt: generic_system_prompt
       - Tools: None (no SQL tools needed)
       - The model responds as a general assistant
    
    2. FINANCIAL QUERIES - QUALITY PASSED:
       - System prompt: sql_system_prompt (financial reporting expert)
       - Tools: sql_tools (for data retrieval and report generation)
       - The model can query the database and generate reports
    
    3. FINANCIAL QUERIES - QUALITY FAILED:
       - System prompt: query_suggestion_prompt (clarification helper)
       - Tools: sql_tools (to provide data-grounded suggestions)
       - Context: Includes suggestions and example queries from validation
       - The model helps the user refine their query with concrete examples
    
    Note: As per user instruction, this async function uses await with handler
    and intellisense errors can be ignored as it works correctly at runtime.
    """
    is_financial_query = request.state.get("is_financial_query", False)
    query_quality_passed = request.state.get("is_query_quality_passed", None)
    
    logger.info(f"=== Routing Query ===")
    logger.info(f"  is_financial: {is_financial_query}")
    logger.info(f"  quality_passed: {query_quality_passed}")
    
    # PATH 1: Non-financial queries → Generic prompt, no SQL tools
    if not is_financial_query:
        logger.info("→ Routing to GENERIC handler (non-financial query)")
        return await handler(request.override(
            system_prompt=generic_system_prompt,
            tools=[],  # No SQL tools for non-financial queries
        ))
    
    # PATH 2: Financial queries that passed quality → SQL prompt with tools
    if query_quality_passed is True:
        logger.info("→ Routing to SQL FINANCIAL handler (quality passed)")
        return await handler(request.override(
            system_prompt=sql_system_prompt,
            tools=sql_tools,  # Full SQL toolkit for data retrieval
        ))
    
    # PATH 3: Financial queries that failed quality → Suggestion prompt with tools + context
    logger.info("→ Routing to SUGGESTION handler (quality failed)")
    
    # Build clarification context from state
    suggestions = request.state.get("query_suggestions", [])
    example_queries = request.state.get("example_queries", [])
    database_context = request.state.get("database_context")
    
    # Inject clarification context into the message history
    clarification = _build_clarification_context(suggestions, example_queries, database_context)
    
    # Create modified messages with context injected as a system message
    messages = list(request.state.get("messages", []))
    messages.insert(0, SystemMessage(content=clarification))
    
    return await handler(request.override(
        system_prompt=query_suggestion_prompt,
        tools=sql_tools,  # SQL tools so model can provide grounded suggestions
        messages=messages,
    ))


# ============================================================================
# MIDDLEWARE CHAIN EXPORT
# ============================================================================
# 
# The middleware executes in this order:
#
# 1. classify_and_grade_query (@before_model):
#    - Determines if query is financial or non-financial
#    - For financial queries, grades quality using SQL tools
#    - Sets state: is_financial_query, is_query_quality_passed, suggestions, etc.
#
# 2. route_and_configure (@wrap_model_call):
#    - Reads classification state
#    - Configures system prompt and tools based on query type/quality
#    - Injects clarification context for failed queries
#
# This two-middleware design minimizes LLM calls while providing:
# - Clear separation of concerns (classify vs route)
# - Tool access at the right stages
# - Data-grounded suggestions for vague queries
#
middleware_chain = [
    classify_and_grade_query,  # Combined: classify + grade in one pass
    route_and_configure,       # Route to appropriate prompt/tools
]