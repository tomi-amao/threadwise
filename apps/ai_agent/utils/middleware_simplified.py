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

Design Pattern:
- Single @before_model middleware for classification + validation (only for financial reports)
- Single @wrap_model_call for routing and tool/prompt injection
"""

import json
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
from .prompts import (
    validation_prompt, 
    sql_system_prompt, 
    generic_system_prompt,
    analytics_system_prompt,  # New prompt for database analytics
    check_financial_prompt,
    validate_financial_prompt_against_database,
)

# Configure logging
logger = logging.getLogger(__name__)




class QueryClassificationResult(BaseModel):
    """Combined output for query classification and quality grading."""
    
    query_type: Literal["financial_report", "database_analytics", "generic"] = Field(
        description="Type of query: 'financial_report' for P&L/BS/CF, 'database_analytics' for data exploration, 'generic' for conversation"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score for classification (0.0-1.0)")
    quality_result: Literal["pass", "fail", "n/a"] = Field(
        description="'pass' if query is detailed enough, 'fail' if needs clarification, 'n/a' if not financial_report"
    )
    quality_rating: int | None = Field(default=None, ge=0, le=5, description="Quality rating 0-5, only for financial reports (0 if not applicable)")
    suggestions: list[str] = Field(default_factory=list, description="Actionable suggestions if quality failed")
    example_queries: list[str] = Field(default_factory=list, description="Example valid queries based on database schema")
    reasoning: str = Field(description="Brief explanation of the classification")


class QueryTypeClassification(BaseModel):
    """Structured output for query type classification."""
    
    query_type: Literal["financial_report", "database_analytics", "generic"] = Field(
        description="Type of query: financial_report, database_analytics, or generic"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score (0.0-1.0)")
    reasoning: str = Field(description="Brief explanation of the classification")

class ValidateFinancialQuery(BaseModel):
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
    missing_information: list[str] = Field(default_factory=list, description="List of missing information if any")
    clarification_questions: list[str] = Field(default_factory=list, description="Clarification questions to ask the user")
    suggestions: list[str] = Field(default_factory=list, description="Suggested alternative queries based on available data")

from pydantic import BaseModel, Field
from typing import List, Literal


class Suggestion(BaseModel):
    description: str = Field(
        ...,
        description="Human-readable explanation of a suggested alternative query"
    )
    example_query: str = Field(
        ...,
        description="An example of a rewritten user query grounded in available data"
    )

class QueryState(AgentState):  
    """Custom state schema for the agent with query classification fields.
    
    Note: AgentState is a TypedDict, so we use annotation-only syntax without defaults.
    Use state.get("field", default) to access with defaults.
    """
    query_type: Literal["financial_report", "database_analytics", "generic"] | None  # Type of query
    is_query_quality_passed: bool | None  # Whether financial report query passed quality check
    query_suggestions: list[Suggestion] | list[str] |None  # Suggestions if quality failed
    issues: list[str] | None  # Example queries for guidance


class PreFlightValidationResult(BaseModel):
    status: Literal["pass", "partial", "fail"] = Field(
        ...,
        description="Overall validation outcome"
    )

    temporal_coverage: Literal["full", "partial", "none"] = Field(
        ...,
        description="Coverage of the requested time range based on available data"
    )

    issues: List[str] = Field(
        default_factory=list,
        description="Concrete reasons why the query is partially valid or invalid"
    )

    suggestions: List[Suggestion] = Field(
        default_factory=list,
        description="Suggested alternative queries based on available data"
    )



# Initialize models for classification
_classification_model = get_local_llm("qwen/qwen3-vl-4b")
# _classification_model = get_chat_model("gemini-2.5-flash")
_query_classifier = _classification_model.with_structured_output(QueryClassificationResult)
_type_classifier = _classification_model.with_structured_output(QueryTypeClassification)
# Validation agent has SQL tools to inspect database schema for grounding suggestions
_validation_agent = create_agent(_classification_model, system_prompt=check_financial_prompt, response_format=ValidateFinancialQuery)
_validation_agent_with_tools = create_agent(_classification_model, tools=sql_tools, system_prompt=validate_financial_prompt_against_database)

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
async def classify_query(state: QueryState, runtime: Runtime) -> dict[str, Any] | None:
    """Combined middleware: Classify query type AND grade quality (only for financial reports).
    
    This middleware classifies queries into three categories:
    1. financial_report: P&L, Balance Sheet, Cash Flow → Requires validation
    2. database_analytics: Data exploration queries → No validation needed
    3. generic: Conversational queries → No validation needed
    
    Only financial reports go through quality grading.
    
    Returns:
        dict with state updates including:
        - query_type: str
        - is_query_quality_passed: bool | None
        - query_suggestions: list[str] (if failed)
        - example_queries: list[str] (if failed)
        - database_context: str (cached schema info)
    """
    logger.info("=== Running Query Classification Middleware ===")

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
        return {"query_type": "generic", "is_query_quality_passed": True}
    
    logger.info(f"Processing query: {user_query[:100]}...")

    try:
        # Step 1: Classify query type
        classification = await _classify_query_type(user_query)
        query_type = classification["query_type"]
        
        logger.info(f"Query classified as: {query_type.upper()} (confidence: {classification['confidence']:.2f})")
        logger.debug(f"Reasoning: {classification.get('reasoning', 'N/A')}")
        
        # Step 2: Only validate quality for FINANCIAL REPORTS
        if query_type == "financial_report":
            logger.info("Financial report detected - running quality validation...")
            quality_result = await _validate_financial_query(user_query)
            print(f"Result from validate financial query: {quality_result}")
            logger.info(f"Quality validation status result: {quality_result.get('status')}")
            return {
                "query_type": "financial_report",
                "is_query_quality_passed": quality_result["status"],
                "query_suggestions": quality_result["query_suggestions"],
            }
        
        # Database analytics and generic queries skip validation
        logger.info(f"{query_type.upper()} query - skipping validation")
        return {
            "query_type": query_type,
            "financial_confidence": classification["confidence"],
            "is_query_quality_passed": True,  # Always pass - no validation needed
            "query_suggestions": None,
            "example_queries": None,
        }
        
    except Exception as e:
        logger.error(f"Error in query classification/grading: {e}", exc_info=True)
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
        dict with 'query_type' (str) and 'confidence' (float)
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

    result = await _type_classifier.ainvoke([
        {"role": "system", "content": "You classify queries into financial reports, data analytics, or generic conversation. Be precise and consider the user's intent."},
        {"role": "user", "content": classification_prompt},
    ])
    
    # Handle both structured output and dict responses
    if isinstance(result, dict):
        return {
            "query_type": result.get('query_type', 'generic'),
            "confidence": result.get('confidence', 0.5),
            "reasoning": result.get('reasoning', ''),
        }
    return {
        "query_type": getattr(result, 'query_type', 'generic'),
        "confidence": getattr(result, 'confidence', 0.5),
        "reasoning": getattr(result, 'reasoning', ''),
    }


async def _validate_financial_query(user_query: str) -> dict[str, Any]:
    """Validate the quality of a financial report query.
    """
    logger.info("Running validation agent")
    
    # Use the validation agent to check query quality
    query_validation = await _validation_agent.ainvoke({
        "messages": [{"role": "user", "content": user_query}]
    })
    
    validation_result = query_validation["structured_response"]
    logger.info(f"Validation agent completed: {validation_result}")

    if validation_result.missing_information:
        logging.info("Query validation failed - missing information detected")
        return {
            "query_suggestions": validation_result.clarification_questions,
            "issues": validation_result.missing_information,
            "status": "fail"
        }    
    print("Validation Status",validation_result.status)
    print("Validation clarification",validation_result.clarification_questions)
    last_message = query_validation.get("messages", [])[-1] if query_validation.get("messages") else None
    validation_text = getattr(last_message, 'text', str(last_message)) if last_message else ""
    
    logger.debug(f"Validation agent response: {validation_text[:300]}...")
    
    # if validation_result.status == "clarification_required":
    logger.info("Query requires clarification")
    validation_result_with_tools = await _validation_agent_with_tools.ainvoke({
        "messages": [{"role": "user", "content": 
                        "Help me improve this query by addressing the problems with it:" + 
                        "\n" + user_query + 
                        "These are the issues found: " +
                        "\n" + ", ".join(validation_result.missing_information) +
                        "\nProvide suggestions based on actual data in the database by querying it."
                        }]
    })
    print("Validation with tools",type(validation_result_with_tools))
    last_message = validation_result_with_tools["messages"][-1].content
    last_message_data = json.loads(last_message)
    suggestions = []
    print(json.loads(last_message))
    try:
        suggestions_data = json.loads(last_message)
        for item in suggestions_data.get("suggestions", []):
            suggestions.append({"description": item.get("description", ""), "example_query": item.get("example_query", "")})
    except json.JSONDecodeError:
        logger.error("Failed to parse suggestions from validation with tools response", exc_info=True)
    print("Suggestions",suggestions)
    print("Issues", last_message_data.get("issues", []))
    print("Status after checking with database", last_message_data.get("status", []))

    return {
        "status": last_message_data.get("status", []),
        "query_suggestions": suggestions,
        "issues": last_message_data.get("issues", []),
        "is_query_quality_passed": last_message_data.get("status", "fail")
    }

    




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
       - System prompt: query_suggestion_prompt (clarification helper)
       - Tools: sql_tools (to provide data-grounded suggestions)
       - Context: Includes suggestions and example queries from validation
    
    Note: As per user instruction, this async function uses await with handler
    and intellisense errors can be ignored as it works correctly at runtime.
    """
    query_type = request.state.get("query_type", "generic")
    query_quality_passed = request.state.get("is_query_quality_passed", True)
    
    logger.info(f"=== Routing Query ===")
    logger.info(f"  query_type: {query_type}")
    logger.info(f"  quality_passed: {query_quality_passed}")
    
    # PATH 1: Generic queries → No SQL tools
    if query_type == "generic":
        logger.info("→ Routing to GENERIC handler")
        return await handler(request.override(
            system_prompt=generic_system_prompt,
            tools=[],  # No SQL tools for generic queries
        ))
    
    # PATH 2: Database analytics → SQL tools with flexible prompt
    if query_type == "database_analytics":
        logger.info("→ Routing to DATABASE ANALYTICS handler")
        return await handler(request.override(
            system_prompt=analytics_system_prompt,  # New flexible analytics prompt
            tools=sql_tools,  # SQL tools for data exploration
        ))
    
    # PATH 3: Financial reports that passed → Strict financial prompt
    if query_type == "financial_report" and query_quality_passed in ["pass", "partial"]:
        logger.info("→ Routing to FINANCIAL REPORT handler (quality passed)")
        return await handler(request.override(
            system_prompt=sql_system_prompt,  # Strict financial reporting prompt
            tools=sql_tools,  # SQL tools for formal reports
        ))
    
    # PATH 4: Financial reports that failed → Suggestions
    logger.info("→ Routing to SUGGESTION handler (quality failed)")
    
    # Build clarification context from state
    suggestions = request.state.get("query_suggestions", [])
    issues = request.state.get("issues", [])
    print("Issues in routing",issues)
    print("Suggestions in routing",suggestions)
    print("Messages in routing",request.state.get("messages", []))

        
    # Create modified messages with context injected as a system message
    messages = list(request.state.get("messages", []))
    
    # Format issues - ensure they're strings
    formatted_issues = [str(issue) for issue in issues]
    
    # Format suggestions - extract description from dict if needed
    formatted_suggestions = []
    for sug in suggestions:
        if isinstance(sug, dict):
            formatted_suggestions.append(f"{sug.get('description', '')} Example: {sug.get('example_query', '')}")
        else:
            formatted_suggestions.append(str(sug))
    
    query_suggestion_prompt =f""" You Financial assistant. The user asked a financial/accounting question, but it needs more detail before we can generate an accurate report.
    The following has been identified as issues with the query:
    issues: {', '.join(formatted_issues)}
    The following has been gathered to improve the query:
    suggestions: {'; '.join(formatted_suggestions)}

    Your job is to inform the user about these issues and advice them on refining their query accordingly, using the suggestions and reasoning provided.
    """

    return await handler(request.override(
        system_prompt=query_suggestion_prompt,
        messages=messages,
        tools=[]
        
    ))


# ============================================================================
# MIDDLEWARE CHAIN EXPORT
# ============================================================================
# 
# The middleware executes in this order:
#
# 1. classify_and_grade_query (@before_model):
#    - Classifies queries into THREE categories:
#      * financial_report: P&L, Balance Sheet, Cash Flow (needs validation)
#      * database_analytics: Data exploration queries (no validation)
#      * generic: Conversational queries (no database access)
#    - Only financial_report queries go through quality grading
#    - Sets state: query_type, is_query_quality_passed, suggestions, etc.
#
# 2. route_and_configure (@wrap_model_call):
#    - Reads classification state
#    - Routes to appropriate handler:
#      * generic → generic_system_prompt, no tools
#      * database_analytics → analytics_system_prompt, SQL tools
#      * financial_report (passed) → sql_system_prompt, SQL tools
#      * financial_report (failed) → query_suggestion_prompt, SQL tools + context
#
# Benefits:
# - Single LLM call for classification (efficient)
# - Validation only for financial reports (focused quality control)
# - Flexible data exploration without validation overhead
# - Data-grounded suggestions when validation fails
#
