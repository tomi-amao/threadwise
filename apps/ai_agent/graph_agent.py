"""LangGraph Financial AI Agent with Custom Nodes.

This module implements a custom graph-based agent for financial data analysis
and reporting using LangGraph's StateGraph API with dedicated nodes for:
- Query classification (generic, analytics, financial_report)
- Query validation (for financial reports)
- SQL execution (for analytics and reports)
- Generative UI (charts, tables, metrics)

Architecture:
    START → classify_query → [route based on type]
    
    Generic:          generic_response → END
    Analytics:        analytics_agent → push_ui → END
    Financial Report: validate_query → [route based on validation]
        - Passed:     execute_report → push_ui → END
        - Failed:     clarify_query → END
"""

import json
import logging
import uuid
from typing import Annotated, Any, Literal, Sequence

from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.messages import BaseMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.ui import AnyUIMessage, push_ui_message, ui_message_reducer
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, Field

from utils.prompts import (
    analytics_system_prompt,
    check_financial_prompt,
    generic_system_prompt,
    sql_system_prompt,
    validate_financial_prompt_against_database,
)
from utils.settings import get_local_llm, get_chat_model
from utils.tools import sql_tools, toolkit

# Configure logging
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


# =============================================================================
# STATE SCHEMA
# =============================================================================


class FinancialAgentState:
    """State schema for the financial agent graph.
    
    This TypedDict defines all state fields that flow through the graph.
    """
    messages: Annotated[Sequence[BaseMessage], add_messages]
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]
    query_type: Literal["financial_report", "database_analytics", "generic"] | None
    is_query_valid: bool | None
    validation_issues: list[str] | None
    validation_suggestions: list[dict] | None
    sql_result: str | None


# Use TypedDict for proper LangGraph compatibility
from typing import TypedDict

class AgentState(TypedDict):
    """State schema for the financial agent graph."""
    messages: Annotated[Sequence[BaseMessage], add_messages]
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]
    query_type: str | None
    is_query_valid: bool | None
    validation_issues: list[str] | None
    validation_suggestions: list[dict] | None
    sql_result: str | None


# =============================================================================
# PYDANTIC MODELS FOR STRUCTURED OUTPUT
# =============================================================================


class QueryClassification(BaseModel):
    """Structured output for query classification."""
    query_type: Literal["financial_report", "database_analytics", "generic"] = Field(
        description="Type of query: financial_report, database_analytics, or generic"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score")
    reasoning: str = Field(description="Brief explanation of classification")


class FinancialQueryValidation(BaseModel):
    """Structured output for financial query validation."""
    status: Literal["pass", "fail"] = Field(
        description="'pass' if query is complete, 'fail' if needs clarification"
    )
    missing_information: list[str] = Field(
        default_factory=list, 
        description="List of missing information"
    )
    suggestions: list[str] = Field(
        default_factory=list,
        description="Suggestions to improve the query"
    )


# =============================================================================
# LLM INITIALIZATION
# =============================================================================


# Use the same model configuration as the original agent
model = get_local_llm("qwen/qwen3-vl-4b")
chat_model = get_chat_model()

# Classifier with structured output
classifier = model.with_structured_output(QueryClassification)

# Validator with structured output
validator_model = model.with_structured_output(FinancialQueryValidation)



# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def get_last_human_message(messages: Sequence[BaseMessage]) -> HumanMessage | None:
    """Extract the last human message from the message list."""
    for msg in reversed(messages):
        if isinstance(msg, HumanMessage):
            return msg
    return None


def extract_query_text(human_msg: HumanMessage) -> str:
    """Extract text content from a HumanMessage."""
    content = human_msg.content
    if isinstance(content, list):
        return " ".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )
    return str(content)


def is_tool_continuation(messages: Sequence[BaseMessage]) -> bool:
    """Check if this is a tool response continuation (skip classification)."""
    if not messages:
        return False
    from langchain_core.messages import ToolMessage
    return isinstance(messages[-1], (ToolMessage, AIMessage))


# =============================================================================
# NODE FUNCTIONS
# =============================================================================


async def classify_query_node(state: AgentState) -> dict[str, Any]:
    """Classify the user query into one of three categories.
    
    Categories:
    - financial_report: P&L, Balance Sheet, Cash Flow statements
    - database_analytics: Data exploration (top customers, trends, etc.)
    - generic: Conversational, explanations, advice
    
    Returns updated state with query_type set.
    """
    logger.info("=== CLASSIFY QUERY NODE ===")
    
    messages = state.get("messages", [])
    
    # Skip classification on tool continuations
    if is_tool_continuation(messages):
        logger.info("Tool continuation detected - skipping classification")
        return {}
    
    human_msg = get_last_human_message(messages)
    if not human_msg:
        logger.warning("No human message found")
        return {"query_type": "generic"}
    
    user_query = extract_query_text(human_msg)
    logger.info(f"Classifying query: {user_query[:100]}...")
    
    classification_prompt = f"""Analyze this query and classify it into ONE of three categories:

Query: "{user_query}"

**Categories:**

1. **financial_report**: Formal financial statements
   - Income Statement, P&L, Profit and Loss
   - Balance Sheet, Statement of Financial Position
   - Cash Flow Statement
   - Require specific time periods and entity context

2. **database_analytics**: Data exploration and business intelligence
   - "Who ordered the most in March?"
   - "Show top 10 customers by revenue"
   - "What products sold best?"
   - Flexible SQL queries for insights

3. **generic**: Non-data queries and conversation
   - Explanations of financial concepts
   - General business advice
   - Questions about system usage
   - No database access needed

**Rules:**
- Financial REPORT/STATEMENT request → financial_report
- Data EXPLORATION/ANALYSIS → database_analytics  
- EXPLANATION/ADVICE/HELP → generic"""

    try:
        result = await classifier.ainvoke([
            {"role": "system", "content": "Classify queries precisely."},
            {"role": "user", "content": classification_prompt},
        ])
        
        # Handle both Pydantic model and dict responses
        if isinstance(result, dict):
            query_type = result.get('query_type', 'generic')
        else:
            query_type = getattr(result, 'query_type', 'generic')
        
        logger.info(f"Query classified as: {query_type}")
        
        return {"query_type": query_type}
        
    except Exception as e:
        logger.error(f"Classification error: {e}")
        return {"query_type": "database_analytics"}  # Safe fallback


async def validate_financial_query_node(state: AgentState) -> dict[str, Any]:
    """Validate that a financial report query has all required information.
    
    Checks for:
    - Clear report type (P&L, Balance Sheet, Cash Flow)
    - Entity specification
    - Time period specification
    
    Returns validation status and any issues/suggestions.
    """
    logger.info("=== VALIDATE FINANCIAL QUERY NODE ===")
    
    messages = state.get("messages", [])
    human_msg = get_last_human_message(messages)
    
    if not human_msg:
        return {"is_query_valid": False, "validation_issues": ["No query found"]}
    
    user_query = extract_query_text(human_msg)
    
    validation_prompt = f"""Validate this financial report query:

Query: "{user_query}"

Check if the query includes:
1. Report type (Income Statement/P&L, Balance Sheet, Cash Flow)
2. Entity/company name (or if there's only one entity, accept it)
3. Time period (date range, quarter, month, year, or "as of" date)

If ANY of these are missing, status should be "fail".
Provide specific suggestions for what information is needed."""

    try:
        result = await validator_model.ainvoke([
            {"role": "system", "content": check_financial_prompt},
            {"role": "user", "content": validation_prompt},
        ])
        
        # Handle both Pydantic model and dict responses
        if isinstance(result, dict):
            status = result.get('status', 'fail')
            missing = result.get('missing_information', [])
            suggestions = result.get('suggestions', [])
        else:
            status = getattr(result, 'status', 'fail')
            missing = getattr(result, 'missing_information', [])
            suggestions = getattr(result, 'suggestions', [])
        
        is_valid = status == "pass"
        logger.info(f"Validation result: {'PASS' if is_valid else 'FAIL'}")
        
        return {
            "is_query_valid": is_valid,
            "validation_issues": missing if not is_valid else None,
            "validation_suggestions": [{"description": s} for s in suggestions] if suggestions else None,
        }
        
    except Exception as e:
        logger.error(f"Validation error: {e}")
        return {"is_query_valid": True}  # Optimistic fallback


async def generic_response_node(state: AgentState) -> dict[str, Any]:
    """Handle generic/conversational queries without database access.
    
    Uses a general-purpose prompt to provide helpful responses about
    financial concepts, advice, or system usage.
    """
    logger.info("=== GENERIC RESPONSE NODE ===")
    
    messages = state.get("messages", [])
    
    response = await model.ainvoke([
        {"role": "system", "content": generic_system_prompt},
        *[{"role": "user" if isinstance(m, HumanMessage) else "assistant", 
           "content": m.content} for m in messages[-5:]]  # Last 5 messages for context
    ])
    
    ai_message = AIMessage(content=response.content, id=str(uuid.uuid4()))
    
    return {"messages": [ai_message]}


async def analytics_agent_node(state: AgentState) -> dict[str, Any]:
    """Handle data analytics queries with SQL tools.
    
    Uses create_agent internally for flexible data exploration queries.
    This node can execute SQL and generate visualizations.
    """
    logger.info("=== ANALYTICS AGENT NODE ===")
    
    
    # Create a sub-agent for analytics with SQL tools
    analytics_agent = create_agent(
        model,
        tools=sql_tools,
        system_prompt=analytics_system_prompt,
    )
    
    messages = state.get("messages", [])
    
    # Run the analytics agent - cast to list for compatibility
    result = await analytics_agent.ainvoke({"messages": list(messages)})  # type: ignore
    
    # Extract the response
    new_messages = result.get("messages", [])
    
    # Get the last AI message for potential visualization
    last_ai_msg = None
    for msg in reversed(new_messages):
        if isinstance(msg, AIMessage):
            last_ai_msg = msg
            break
    
    return {"messages": new_messages}


async def execute_report_node(state: AgentState) -> dict[str, Any]:
    """Execute a validated financial report query.
    
    Uses create_agent with SQL tools and the strict financial reporting prompt
    to generate formal financial statements.
    """
    logger.info("=== EXECUTE REPORT NODE ===")
    
    # Create a sub-agent for financial reporting
    report_agent = create_agent(
        model,
        tools=sql_tools,
        system_prompt=sql_system_prompt,
    )
    
    messages = state.get("messages", [])
    last_msg = get_last_human_message(messages)
    human_msg = last_msg.content
    print("Messages in execute_report_node:", human_msg, type(last_msg))
    
    # Run the report agent - cast to list for compatibility
    result = await report_agent.ainvoke({"messages": [{"role": "user", "content": human_msg}]})  # type: ignore
    
    new_messages = result.get("messages", [])
    
    return {"messages": new_messages}


async def clarify_query_node(state: AgentState) -> dict[str, Any]:
    """Ask the user for clarification when a financial query is incomplete.
    
    Uses the validation issues and suggestions to construct a helpful
    clarification message.
    """
    logger.info("=== CLARIFY QUERY NODE ===")
    
    issues = state.get("validation_issues", [])
    suggestions = state.get("validation_suggestions", [])
    
    # Format issues and suggestions
    issues_text = "\n".join(f"- {issue}" for issue in issues) if issues else "The query needs more details."
    
    suggestions_text = ""
    if suggestions:
        suggestions_text = "\n\nHere are some suggestions:\n" + "\n".join(
            f"- {s.get('description', s)}" for s in suggestions
        )
    
    clarification_prompt = f"""You are a financial assistant. The user asked a question, but it needs more detail.

Issues identified:
{issues_text}
{suggestions_text}

Politely ask the user to provide the missing information. Be specific about what you need."""

    messages = state.get("messages", [])
    
    response = await model.ainvoke([
        {"role": "system", "content": clarification_prompt},
        *[{"role": "user" if isinstance(m, HumanMessage) else "assistant", 
           "content": m.content} for m in messages[-3:]]
    ])
    
    ai_message = AIMessage(content=response.content, id=str(uuid.uuid4()))
    
    return {"messages": [ai_message]}


async def push_visualization_node(state: AgentState) -> dict[str, Any]:
    """Push UI visualization components based on SQL results.
    
    Analyzes the last response and pushes appropriate charts/tables
    using LangGraph's generative UI system via push_ui_message.
    
    This node uses the LLM to decide what visualization to create based
    on the data returned from analytics or report queries.
    """
    logger.info("=== PUSH VISUALIZATION NODE ===")
    
    messages = state.get("messages", [])
    
    # Find the last AI message with content
    last_ai_msg = None
    for msg in reversed(messages):
        if isinstance(msg, AIMessage) and msg.content:
            last_ai_msg = msg
            break
    
    if not last_ai_msg:
        return {}
    
    # Extract content as string
    content = last_ai_msg.content
    if isinstance(content, list):
        content_str = " ".join(str(c) for c in content)
    else:
        content_str = str(content)
    
    # Use LLM to analyze response and extract visualization data
    viz_analysis_prompt = """Analyze the following AI response and determine if it contains data that should be visualized.

Response:
{content}

If the response contains:
1. Numerical data comparisons (bar chart)
2. Distribution/percentage data (pie chart)  
3. Key metrics/totals (metric card)
4. Time series data (line chart)
5. Tabular data (table)

Extract the data and return JSON in this format:
{{
    "should_visualize": true/false,
    "chart_type": "bar" | "pie" | "metric" | "line" | "table",
    "title": "Chart title",
    "data": [
        {{"label": "Item name", "value": 123.45}}
    ],
    "format": "currency" | "number" | "percentage"
}}

If no visualization is appropriate, return {{"should_visualize": false}}.
Return ONLY valid JSON, no explanation."""

    try:
        viz_response = await model.ainvoke([
            {"role": "system", "content": "You are a data visualization expert. Extract chart data from responses."},
            {"role": "user", "content": viz_analysis_prompt.format(content=content_str[:2000])},
        ])
        
        # Parse the visualization response
        viz_content = viz_response.content
        if isinstance(viz_content, list):
            viz_text = " ".join(str(c) for c in viz_content)
        else:
            viz_text = str(viz_content)
        
        # Try to extract JSON from the response
        import re
        json_match = re.search(r'\{.*\}', viz_text, re.DOTALL)
        if not json_match:
            logger.info("No JSON found in visualization analysis")
            return {}
        
        viz_config = json.loads(json_match.group())
        
        if not viz_config.get("should_visualize", False):
            logger.info("No visualization needed for this response")
            return {}
        
        chart_type = viz_config.get("chart_type", "bar")
        title = viz_config.get("title", "Data Visualization")
        data = viz_config.get("data", [])
        format_type = viz_config.get("format", "number")
        
        if not data:
            logger.info("No data extracted for visualization")
            return {}
        
        # Push the UI message for the appropriate chart type
        # Use the message parameter to associate UI with the AI message
        logger.info(f"Pushing {chart_type} visualization: {title}")
        
        if chart_type == "metric":
            # For metric cards, use the first data item
            item = data[0] if data else {"label": "Value", "value": 0}
            push_ui_message(
                "metric-card",
                props={
                    "title": item.get("label", title),
                    "value": item.get("value", 0),
                    "format": format_type,
                    "trend": None,  # Could be extracted if available
                },
                message=last_ai_msg,  # Associates UI with AI message
            )
        elif chart_type == "bar":
            push_ui_message(
                "bar-chart",
                props={
                    "title": title,
                    "data": data,
                    "format": format_type,
                },
                message=last_ai_msg,
            )
        elif chart_type == "pie":
            push_ui_message(
                "pie-chart",
                props={
                    "title": title,
                    "data": data,
                    "format": format_type,
                },
                message=last_ai_msg,
            )
        elif chart_type == "table":
            push_ui_message(
                "financial-table",
                props={
                    "title": title,
                    "data": data,
                    "format": format_type,
                },
                message=last_ai_msg,
            )
        elif chart_type == "line":
            push_ui_message(
                "bar-chart",  # Fallback to bar for now
                props={
                    "title": title,
                    "data": data,
                    "format": format_type,
                },
                message=last_ai_msg,
            )
        
        logger.info(f"Successfully pushed {chart_type} UI message")
        return {}
        
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse visualization JSON: {e}")
        return {}
    except Exception as e:
        logger.error(f"Error in push_visualization_node: {e}")
        return {}


# =============================================================================
# ROUTING FUNCTIONS
# =============================================================================


def route_by_query_type(state: AgentState) -> Literal["generic_response", "analytics_agent", "validate_financial"]:
    """Route to appropriate handler based on query classification."""
    query_type = state.get("query_type", "generic")
    
    logger.info(f"Routing based on query_type: {query_type}")
    
    if query_type == "generic":
        return "generic_response"
    elif query_type == "database_analytics":
        return "analytics_agent"
    else:  # financial_report
        return "validate_financial"


def route_by_validation(state: AgentState) -> Literal["execute_report", "clarify_query"]:
    """Route based on whether the financial query passed validation."""
    is_valid = state.get("is_query_valid", False)
    
    logger.info(f"Routing based on validation: {'PASS' if is_valid else 'FAIL'}")
    
    if is_valid:
        return "execute_report"
    else:
        return "clarify_query"


# =============================================================================
# GRAPH CONSTRUCTION
# =============================================================================


def create_financial_agent_graph() -> StateGraph:
    """Create and compile the financial agent graph.
    
    Graph structure:
        START → classify_query
        classify_query → [route_by_query_type]
            → generic_response → END
            → analytics_agent → push_visualization → END
            → validate_financial → [route_by_validation]
                → execute_report → push_visualization → END
                → clarify_query → END
    """
    
    # Create the graph with our state schema
    builder = StateGraph(AgentState)
    
    # Add all nodes
    builder.add_node("classify_query", classify_query_node)
    builder.add_node("generic_response", generic_response_node)
    builder.add_node("analytics_agent", analytics_agent_node)
    builder.add_node("validate_financial", validate_financial_query_node)
    builder.add_node("execute_report", execute_report_node)
    builder.add_node("clarify_query", clarify_query_node)
    builder.add_node("push_visualization", push_visualization_node)
    
    # Add edges
    builder.add_edge(START, "classify_query")
    
    # Conditional routing after classification
    builder.add_conditional_edges(
        "classify_query",
        route_by_query_type,
        {
            "generic_response": "generic_response",
            "analytics_agent": "analytics_agent",
            "validate_financial": "validate_financial",
        }
    )
    
    # Generic queries go straight to END
    builder.add_edge("generic_response", END)
    
    # Analytics queries go through visualization then END
    builder.add_edge("analytics_agent", "push_visualization")
    builder.add_edge("push_visualization", END)
    
    # Conditional routing after validation
    builder.add_conditional_edges(
        "validate_financial",
        route_by_validation,
        {
            "execute_report": "execute_report",
            "clarify_query": "clarify_query",
        }
    )
    
    # Report execution goes through visualization
    builder.add_edge("execute_report", "push_visualization")
    
    # Clarification goes straight to END
    builder.add_edge("clarify_query", END)
    
    return builder


# =============================================================================
# COMPILED AGENT
# =============================================================================


# Create and compile the graph
graph_builder = create_financial_agent_graph()
agent = graph_builder.compile(name="threadwise-financial-agent")


# =============================================================================
# EXPORTS
# =============================================================================

__all__ = ["agent", "AgentState", "create_financial_agent_graph"]
