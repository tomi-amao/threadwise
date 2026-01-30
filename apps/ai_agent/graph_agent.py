"""LangGraph Ad-hoc Analytics Agent with Custom Nodes.

This module implements a custom graph-based agent for ad-hoc database exploration
and business intelligence using LangGraph's StateGraph API with dedicated nodes for:
- Query classification (analytics vs generic)
- Semantic search context retrieval
- Context sufficiency evaluation (LLM decides if context answers the query)
- SQL-based data exploration (insights, trends, comparisons)
- Document extraction from uploads
- Generative UI (charts, tables, metrics)

Architecture:
    START → classify_query → retrieve_context → evaluate_context_sufficiency
        → [route_by_context_sufficiency]
            → context_response → END  (if context is sufficient)
            → [route_by_query_type]   (if context not sufficient)
                → extract_document → END
                → generic_response → END
                → analytics_agent → push_visualization → END

Key Feature - Context Sufficiency Evaluation:
    After retrieving context from the vector store, an LLM evaluates whether
    the retrieved documents fully answer the user's question. If sufficient,
    the agent responds directly without needing database queries or additional
    processing. This enables faster responses for knowledge-based queries.

Capabilities:
- Insights & Trends: "What were our top-selling products last quarter?"
- Comparisons: "Compare sales between Q1 and Q2"
- Forecasting: "Based on current trends, what might next month look like?"
- Data Discovery: "What tables do we have?", "Show me sample customer data"
- Aggregations: "Total revenue by region", "Average order value"
- Anomaly Detection: "Are there unusual patterns in recent orders?"
- Knowledge Queries: Direct answers from embedded documents when context is sufficient
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
    generic_system_prompt,
    invoice_extraction_prompt,
)
from utils.settings import get_local_llm, get_chat_model
from utils.tools import sql_tools, toolkit

# Import embedding service for semantic search
from src.ai_agent.services.embedding_service import embedding_service

# Configure logging
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


# =============================================================================
# STATE SCHEMA
# =============================================================================


# Use TypedDict for proper LangGraph compatibility
from typing import TypedDict

class AgentState(TypedDict):
    """State schema for the ad-hoc analytics agent graph.
    
    This TypedDict defines all state fields that flow through the graph.
    Simplified to focus on analytics queries and document extraction.
    """
    messages: Annotated[Sequence[BaseMessage], add_messages]
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]
    query_type: Literal["analytics", "generic", "document_extraction"] | None
    sql_result: str | None
    # Document extraction fields
    has_file_attachment: bool | None
    extracted_document: dict | None
    model: str | None
    # Semantic search context
    retrieved_context: list[dict] | None
    # Context sufficiency evaluation
    context_sufficient: bool | None
    context_response: str | None  # Pre-generated response if context is sufficient


# =============================================================================
# PYDANTIC MODELS FOR STRUCTURED OUTPUT
# =============================================================================


class QueryClassification(BaseModel):
    """Structured output for query classification.
    
    Classifies user queries into:
    - analytics: Data exploration, insights, trends, comparisons, aggregations
    - generic: Conversational, explanations, advice, non-database queries
    - document_extraction: File attachments that need parsing
    """
    query_type: Literal["analytics", "generic", "document_extraction"] = Field(
        description="Type of query: analytics (data exploration), generic (conversational), or document_extraction (file uploads)"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score")
    reasoning: str = Field(description="Brief explanation of classification")


class ContextSufficiency(BaseModel):
    """Structured output for evaluating if retrieved context sufficiently answers the query.
    
    The LLM evaluates whether the retrieved documents provide enough information
    to answer the user's question directly, or if additional processing is needed.
    """
    is_sufficient: bool = Field(
        description="True if the retrieved context fully answers the user's query, False if more processing is needed"
    )
    confidence: float = Field(
        ge=0.0, le=1.0, 
        description="Confidence in the sufficiency assessment"
    )
    reasoning: str = Field(
        description="Brief explanation of why context is or isn't sufficient"
    )
    suggested_response: str | None = Field(
        default=None,
        description="If sufficient, a draft response based on the context. None if not sufficient."
    )


# Document category type for filtering - must match categories stored in vector DB
DocumentCategoryType = Literal[
    "invoice", "receipt", "credit_memo", "purchase_order",
    "bank_statement", "expense_report", "contract", "other"
]


class DocumentCategoryInference(BaseModel):
    """Structured output for inferring document category from user query.
    
    Used to filter hybrid search results by document_category metadata,
    improving search relevance by focusing on the right type of documents.
    """
    category: DocumentCategoryType | None = Field(
        default=None,
        description="The document category to filter by, or None if the query doesn't target a specific document type"
    )
    confidence: float = Field(
        ge=0.0, le=1.0,
        description="Confidence in the category inference"
    )
    reasoning: str = Field(
        description="Brief explanation of why this category was selected or why no filter applies"
    )


class ExtractedLineItem(BaseModel):
    """A single line item from an invoice or receipt."""
    description: str = Field(description="Product or service description")
    quantity: float | None = Field(default=None, description="Number of units")
    unit_price: float | None = Field(default=None, description="Price per unit")
    amount: float | None = Field(default=None, description="Total line amount")


class ExtractedDocumentData(BaseModel):
    """Structured output for document extraction from PDFs/images."""
    
    # Document classification
    document_category: Literal[
        "invoice", "receipt", "credit_memo", "purchase_order", 
        "bank_statement", "expense_report", "contract", "other"
    ] = Field(description="Type of financial document")
    
    # Vendor/Merchant information
    vendor_name: str | None = Field(default=None, description="Vendor or merchant name")
    vendor_address: str | None = Field(default=None, description="Vendor address")
    vendor_tax_id: str | None = Field(default=None, description="Vendor VAT/Tax ID")
    
    # Document identifiers
    invoice_number: str | None = Field(default=None, description="Invoice or document number")
    purchase_order_number: str | None = Field(default=None, description="Related PO number")
    reference_notes: str | None = Field(default=None, description="Additional references")
    
    # Dates
    invoice_date: str | None = Field(default=None, description="Document date (YYYY-MM-DD)")
    due_date: str | None = Field(default=None, description="Payment due date (YYYY-MM-DD)")
    payment_terms: str | None = Field(default=None, description="Payment terms (e.g., Net 30)")
    
    # Financial amounts
    currency: str = Field(default="USD", description="3-letter currency code")
    subtotal: float | None = Field(default=None, description="Amount before tax")
    tax_amount: float | None = Field(default=None, description="Tax/VAT amount")
    tax_rate: float | None = Field(default=None, description="Tax rate percentage")
    total_amount: float | None = Field(default=None, description="Final total amount")
    
    # Line items
    line_items: list[ExtractedLineItem] = Field(
        default_factory=list, 
        description="Individual line items from the document"
    )
    
    # Extraction metadata
    confidence_score: float = Field(
        ge=0.0, le=1.0, 
        description="Overall confidence in extraction accuracy"
    )
    extraction_notes: str | None = Field(
        default=None, 
        description="Notes about extraction quality or issues"
    )


# =============================================================================
# LLM INITIALIZATION
# =============================================================================


# Use the same model configuration as the original agent
local_model = get_local_llm("qwen/qwen3-vl-4b")
gemini = get_chat_model("google_genai:gemini-2.5-flash-lite")
model = local_model  # Default model

# Classifier with structured output for query routing
classifier = local_model.with_structured_output(QueryClassification)

# Context sufficiency evaluator - decides if retrieved context answers the query
context_evaluator = local_model.with_structured_output(ContextSufficiency)

# Document category inferrer - determines which category to filter by in search
category_inferrer = local_model.with_structured_output(DocumentCategoryInference)

# Document extractor uses multimodal-capable model for PDF/image processing


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


def has_file_attachment(human_msg: HumanMessage) -> bool:
    """Check if a HumanMessage contains a file attachment (PDF, image, etc.)."""
    content = human_msg.content
    if not isinstance(content, list):
        return False
    
    for block in content:
        if isinstance(block, dict):
            # Check for file type content blocks (LangChain multimodal format)
            block_type = block.get("type", "")
            if block_type in ("file", "image", "image_url"):
                return True
            # Check for inline base64 data
            if block.get("source_type") in ("base64", "url", "id"):
                return True
            # Check for data URLs in image_url format
            if block_type == "image_url" and block.get("image_url", {}).get("url"):
                return True
    return False


def extract_file_data(human_msg: HumanMessage) -> dict | None:
    """Extract file data from a HumanMessage for document processing.
    
    Returns a dict with file information:
    - type: "base64" or "url"
    - data: base64 string or URL
    - mime_type: MIME type of the file
    - filename: optional filename
    """
    content = human_msg.content
    if not isinstance(content, list):
        return None
    
    for block in content:
        if isinstance(block, dict) and block.get("type") != "text":
            block_type = block.get("type", "")
            # with open("message", "a" ) as f:
            #     f.write(f"The block type: {block_type}\n The mime type: {block.get('mime_type')}\n The data: {block.get('data')}\n")


            
            # Handle file type blocks
            if block_type == "file":
                source_type = block.get("source_type", "")
                if source_type == "base64":
                    return {
                        "type": "base64",
                        "data": block.get("data", ""),
                        "mime_type": block.get("mime_type", "application/pdf"),
                        "filename": block.get("extras", {}).get("filename", "document.pdf"),
                    }
                elif source_type == "url":
                    return {
                        "type": "url",
                        "data": block.get("url", ""),
                        "mime_type": block.get("mime_type", "application/pdf"),
                        "filename": block.get("extras", {}).get("filename"),
                    }
             
            # Handle image_url format (for images or converted PDF pages)
            elif block_type == "image":
                print(f"The block type: {block_type}")
            # if url.startswith("data:"):
                # Parse data URL
                # Format: data:mime_type;base64,data
                try:
                    # header, data = url.split(",", 1)
                    # mime_type = header.split(":")[1].split(";")[0]
                    return {
                        "type": "base64",
                        "url": f"data:{block.get('mime_type')};base64,{block.get('data')}",
                        "data": block.get("data"),
                        "mime_type": block.get("mime_type"),
                        "filename": None,
                    }
                except (IndexError, ValueError):
                    pass
            else:
                url = block.get("image_url", {}).get("url", "")
                return {
                    "type": "url",
                    "data": url,
                    "mime_type": "image/png",
                    "filename": None,
                }
    
    return None


# =============================================================================
# NODE FUNCTIONS
# =============================================================================


async def classify_query_node(state: AgentState) -> dict[str, Any]:
    """Classify the user query into one of three categories.
    
    Categories:
    - document_extraction: File attachments (PDFs, images) that need parsing
    - analytics: Data exploration, insights, trends, comparisons, forecasting
    - generic: Conversational, explanations, advice, non-database queries
    
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
        return {"query_type": "generic", "has_file_attachment": False}
    
    # Check for file attachments FIRST - route directly to document extraction
    if has_file_attachment(human_msg):
        logger.info("File attachment detected - routing to document extraction")
        return {
            "query_type": "document_extraction",
            "has_file_attachment": True,
        }
    
    user_query = extract_query_text(human_msg)
    logger.info(f"Classifying query: {user_query[:100]}...")
    
    classification_prompt = f"""Analyze this query and classify it into ONE of two categories:

Query: "{user_query}"

**Categories:**

1. **analytics**: Data exploration and business intelligence queries that require database access
   - Insights & Trends: "What were our top-selling products last quarter?"
   - Comparisons: "Compare sales between Q1 and Q2", "How does this month compare to last year?"
   - Rankings: "Show top 10 customers by revenue", "Who ordered the most in March?"
   - Aggregations: "Total revenue by region", "Average order value by segment"
   - Forecasting: "Based on current trends, what might next month look like?"
   - Data Discovery: "What tables do we have?", "Show me sample customer data"
   - Anomaly Detection: "Are there unusual patterns in recent orders?"
   - Any question that requires querying the database

2. **generic**: Non-data queries and conversation that don't need database access
   - Explanations of financial or business concepts
   - General business advice
   - Questions about how to use the system
   - Greetings, clarifications, follow-up conversation
   - Hypothetical questions not about actual data

**Rules:**
- If the query asks about ACTUAL DATA (customers, orders, sales, revenue, etc.) → analytics
- If the query is CONCEPTUAL, ADVICE, or CONVERSATIONAL → generic
- When in doubt, prefer analytics (we can always explain if no data is found)"""

    try:
        result = await classifier.ainvoke([
            {"role": "system", "content": "Classify queries precisely into analytics or generic."},
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
        return {"query_type": "analytics"}  # Safe fallback to analytics


async def generic_response_node(state: AgentState) -> dict[str, Any]:
    """Handle generic/conversational queries without database access.
    
    Uses a general-purpose prompt to provide helpful responses about
    financial concepts, advice, or system usage. Enriches response with
    relevant context from the vector store if available.
    """
    logger.info("=== GENERIC RESPONSE NODE ===")
    
    messages = state.get("messages", [])
    retrieved_context = state.get("retrieved_context")
    
    # Build system prompt with optional context
    system_content = generic_system_prompt
    if retrieved_context:
        context_str = format_retrieved_context(retrieved_context)
        system_content = f"{generic_system_prompt}\n\n{context_str}\n\nUse the above context to inform your response when relevant."
        logger.info(f"Including {len(retrieved_context)} context documents in generic response")
    
    response = await model.ainvoke([
        {"role": "system", "content": system_content},
        *[{"role": "user" if isinstance(m, HumanMessage) else "assistant", 
           "content": m.content} for m in messages[-5:]]  # Last 5 messages for context
    ])
    
    ai_message = AIMessage(content=response.content, id=str(uuid.uuid4()))
    
    return {"messages": [ai_message]}


async def analytics_agent_node(state: AgentState) -> dict[str, Any]:
    """Handle data analytics queries with SQL tools.
    
    Uses create_agent internally for flexible data exploration queries.
    This node can execute SQL and generate visualizations. Enriches
    queries with relevant context from the vector store.
    """
    logger.info("=== ANALYTICS AGENT NODE ===")
    
    retrieved_context = state.get("retrieved_context")
    
    # Build system prompt with optional context
    system_prompt = analytics_system_prompt
    if retrieved_context:
        context_str = format_retrieved_context(retrieved_context)
        system_prompt = f"{analytics_system_prompt}\n\n{context_str}\n\nUse the above context to inform your analysis when relevant."
        logger.info(f"Including {len(retrieved_context)} context documents in analytics")
    
    # Create a sub-agent for analytics with SQL tools
    analytics_agent = create_agent(
        model,
        tools=sql_tools,
        system_prompt=system_prompt,
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


async def infer_document_category_filter(user_query: str) -> dict[str, Any] | None:
    """Infer the document category to filter by based on the user's query.
    
    Uses an LLM to analyze the query and determine if it targets a specific
    type of document (invoice, receipt, contract, etc.). Returns a Pinecone
    filter dict if a category is identified with high confidence.
    
    Args:
        user_query: The user's search query
        
    Returns:
        Pinecone filter dict like {"document_category": {"$eq": "invoice"}}
        or None if no specific category is identified
    """
    inference_prompt = f"""Analyze this query and determine if it's looking for a specific type of document.

Query: "{user_query}"

**Available Document Categories:**
- invoice: Bills, invoices, billing documents
- receipt: Purchase receipts, payment confirmations
- credit_memo: Credit notes, refund documents
- purchase_order: POs, purchase requisitions
- bank_statement: Bank account statements, transaction histories
- expense_report: Expense claims, reimbursement requests
- contract: Agreements, contracts, legal documents
- other: Documents that don't fit other categories

**Rules:**
- If the query explicitly mentions a document type (e.g., "show my invoices", "find the contract"), select that category
- If the query asks about specific document attributes (e.g., "vendor payment terms" → likely invoice/contract), infer the category
- If the query is general or could apply to any document type, return null for category
- Only select a category if you're reasonably confident (>0.6)

**Examples:**
- "What invoices do I have from Acme Corp?" → invoice (0.95)
- "Show me the contract renewal terms" → contract (0.9)
- "List all my receipts from last month" → receipt (0.9)
- "What documents mention Project Alpha?" → null (too general)
- "Find bank transactions over $1000" → bank_statement (0.85)
- "What's the total I owe?" → invoice (0.7)"""

    try:
        result = await category_inferrer.ainvoke([
            {"role": "system", "content": "Infer the document category for search filtering. Be precise."},
            {"role": "user", "content": inference_prompt},
        ])
        
        # Handle both Pydantic model and dict responses
        if isinstance(result, dict):
            category = result.get('category')
            confidence = result.get('confidence', 0.0)
            reasoning = result.get('reasoning', '')
        else:
            category = getattr(result, 'category', None)
            confidence = getattr(result, 'confidence', 0.0)
            reasoning = getattr(result, 'reasoning', '')
        
        logger.info(f"Category inference: {category} (confidence: {confidence:.2f})")
        logger.info(f"Reasoning: {reasoning}")
        
        # Only apply filter if confidence is high enough
        if category and confidence >= 0.6:
            return {"document_category": {"$eq": category}}
        
        return None
        
    except Exception as e:
        logger.error(f"Category inference error: {e}")
        return None


async def retrieve_context_node(state: AgentState) -> dict[str, Any]:
    """Retrieve relevant context from the vector store using semantic search.
    
    This node runs after query classification and before processing nodes.
    It searches the document store for relevant context that can help
    answer the user's query more accurately.
    
    The node first infers if the query targets a specific document category
    (invoice, contract, receipt, etc.) and applies a metadata filter to
    improve search relevance.
    
    Returns updated state with retrieved_context populated.
    """
    logger.info("=== RETRIEVE CONTEXT NODE ===")
    
    messages = state.get("messages", [])
    query_type = state.get("query_type")
    
    # Skip context retrieval for document extraction (the document IS the context)
    if query_type == "document_extraction":
        logger.info("Skipping context retrieval for document extraction")
        return {"retrieved_context": None}
    
    # Get the user's query
    human_msg = get_last_human_message(messages)
    if not human_msg:
        logger.warning("No human message found for context retrieval")
        return {"retrieved_context": None}
    
    user_query = extract_query_text(human_msg)
    logger.info(f"Retrieving context for query: {user_query[:100]}...")
    
    try:
        # Infer document category filter from the query
        filter_metadata = await infer_document_category_filter(user_query)
        if filter_metadata:
            logger.info(f"Applying document category filter: {filter_metadata}")
        else:
            logger.info("No category filter applied - searching all documents")
        
        # Perform hybrid search with reranking for improved relevance
        # Two-stage retrieval: 1) Hybrid search retrieves candidates, 2) Reranker re-scores for accuracy
        search_results = await embedding_service.hybrid_search_with_rerank(
            query=user_query,
            limit=5,  # Final number of results after reranking
            similarity_threshold=0.3,  # Minimum similarity score for initial retrieval
            filter_metadata=filter_metadata,
            rerank=True,  # Enable reranking for better relevance
        )
        
        # Filter out error results
        valid_results = [r for r in search_results if "error" not in r]
        
        if valid_results:
            reranked_count = sum(1 for r in valid_results if r.get("reranked", False))
            logger.info(f"Retrieved {len(valid_results)} context documents ({reranked_count} reranked)")
        else:
            logger.info("No relevant context found in vector store")
        
        return {"retrieved_context": valid_results if valid_results else None}
        
    except Exception as e:
        logger.error(f"Error retrieving context: {e}")
        return {"retrieved_context": None}


def format_retrieved_context(context: list[dict] | None) -> str:
    """Format retrieved context documents into a string for LLM consumption."""
    if not context:
        return ""
    
    formatted_parts = ["## Relevant Context from Knowledge Base:\n"]
    
    for i, doc in enumerate(context, 1):
        content = doc.get("content", "")
        metadata = doc.get("metadata", {})
        source = metadata.get("source", "Unknown source")
        
        formatted_parts.append(f"### Document {i} (Source: {source})\n{content}\n")
    
    return "\n".join(formatted_parts)


async def evaluate_context_sufficiency_node(state: AgentState) -> dict[str, Any]:
    """Evaluate if the retrieved context is sufficient to answer the user's query.
    
    This node uses an LLM to determine whether the retrieved documents contain
    enough information to directly answer the user's question, or if additional
    processing (analytics, database queries, etc.) is needed.
    
    Decision criteria:
    - SUFFICIENT: The context directly answers the question with clear, complete info
    - NOT SUFFICIENT: The question requires computation, database access, or info not in context
    
    Returns updated state with context_sufficient and optionally context_response.
    """
    logger.info("=== EVALUATE CONTEXT SUFFICIENCY NODE ===")
    
    messages = state.get("messages", [])
    query_type = state.get("query_type")
    retrieved_context = state.get("retrieved_context")
    
    # Skip evaluation for document extraction - always needs processing
    if query_type == "document_extraction":
        logger.info("Skipping sufficiency check for document extraction")
        return {"context_sufficient": False, "context_response": None}
    
    # If no context was retrieved, definitely not sufficient
    if not retrieved_context:
        logger.info("No context retrieved - marking as not sufficient")
        return {"context_sufficient": False, "context_response": None}
    
    # Get the user's query
    human_msg = get_last_human_message(messages)
    if not human_msg:
        return {"context_sufficient": False, "context_response": None}
    
    user_query = extract_query_text(human_msg)
    context_str = format_retrieved_context(retrieved_context)
    
    evaluation_prompt = f"""Evaluate whether the provided context is sufficient to fully answer the user's question.

## User's Question:
{user_query}

## Retrieved Context:
{context_str}

## Evaluation Criteria:

**Mark as SUFFICIENT (is_sufficient=true) if:**
- The context directly and completely answers the question
- All information needed is present in the documents
- No calculations, aggregations, or database queries are needed
- The answer can be derived purely from reading the context

**Mark as NOT SUFFICIENT (is_sufficient=false) if:**
- The question asks for specific data/metrics not in the context
- The question requires database queries, calculations, or aggregations
- The question asks about real-time or recent data not in documents
- The context is related but doesn't fully answer the question
- The question is about analytics, trends, or comparisons needing computation

## Important:
- For analytics queries (data exploration, insights, trends), lean toward NOT SUFFICIENT
- For informational queries about documented knowledge, lean toward SUFFICIENT
- If uncertain, mark as NOT SUFFICIENT to ensure thorough processing

If sufficient, provide a complete, helpful response in suggested_response.
If not sufficient, set suggested_response to null."""

    try:
        result = await context_evaluator.ainvoke([
            {"role": "system", "content": "You evaluate whether retrieved context answers user queries. Be conservative - if in doubt, say it's not sufficient."},
            {"role": "user", "content": evaluation_prompt},
        ])
        
        # Handle both Pydantic model and dict responses
        if isinstance(result, dict):
            is_sufficient = result.get('is_sufficient', False)
            confidence = result.get('confidence', 0.0)
            reasoning = result.get('reasoning', '')
            suggested_response = result.get('suggested_response')
        else:
            is_sufficient = getattr(result, 'is_sufficient', False)
            confidence = getattr(result, 'confidence', 0.0)
            reasoning = getattr(result, 'reasoning', '')
            suggested_response = getattr(result, 'suggested_response', None)
        
        logger.info(f"Context sufficiency: {is_sufficient} (confidence: {confidence:.2f})")
        logger.info(f"Reasoning: {reasoning}")
        
        # Only mark as sufficient if confidence is high enough
        if is_sufficient and confidence < 0.7:
            logger.info("Low confidence - proceeding with full processing")
            is_sufficient = False
            suggested_response = None
        
        return {
            "context_sufficient": is_sufficient,
            "context_response": suggested_response if is_sufficient else None,
        }
        
    except Exception as e:
        logger.error(f"Context evaluation error: {e}")
        # On error, proceed with full processing
        return {"context_sufficient": False, "context_response": None}


async def context_response_node(state: AgentState) -> dict[str, Any]:
    """Generate a response directly from the evaluated context.
    
    This node is called when the context sufficiency evaluation determined
    that the retrieved context fully answers the user's question.
    Uses the pre-generated response from the evaluation or generates a new one.
    """
    logger.info("=== CONTEXT RESPONSE NODE ===")
    
    context_response = state.get("context_response")
    retrieved_context = state.get("retrieved_context")
    messages = state.get("messages", [])
    
    # Use pre-generated response if available
    if context_response:
        logger.info("Using pre-generated context response")
        response_content = context_response
    else:
        # Generate response from context (fallback)
        logger.info("Generating response from context")
        human_msg = get_last_human_message(messages)
        user_query = extract_query_text(human_msg) if human_msg else ""
        context_str = format_retrieved_context(retrieved_context)
        
        response = await model.ainvoke([
            {"role": "system", "content": f"""You are a helpful assistant. Answer the user's question based on the provided context.
            
{context_str}

Provide a clear, comprehensive answer based on this context. If the context doesn't fully answer the question, acknowledge any limitations."""},
            {"role": "user", "content": user_query},
        ])
        response_content = response.content
    
    ai_message = AIMessage(content=response_content, id=str(uuid.uuid4()))
    
    return {"messages": [ai_message]}


async def extract_document_node(state: AgentState) -> dict[str, Any]:
    """Extract structured data from uploaded documents (PDFs, images).
    
    Uses a multimodal LLM to analyze the document and extract:
    - Document category (invoice, receipt, credit memo, etc.)
    - Vendor/merchant information
    - Invoice/document numbers
    - Dates and payment terms
    - Line items with descriptions, quantities, prices
    - Financial totals (subtotal, tax, total)
    
    Returns extracted data and a human-readable summary.
    """
    logger.info("=== EXTRACT DOCUMENT NODE ===")
    logger.info("Current state: " + str(state))
    logger.info(f"Model selected: {state.get('model', 'default')}")

    
    messages = state.get("messages", [])
    human_msg = get_last_human_message(messages)
    
    if not human_msg:
        return {
            "messages": [AIMessage(
                content="I couldn't find a document to process. Please upload a PDF or image file.",
                id=str(uuid.uuid4())
            )]
        }
    
    # Extract file data from the message
    file_data = extract_file_data(human_msg)
    
    if not file_data:
        return {
            "messages": [AIMessage(
                content="I couldn't extract the file from your message. Please try uploading the document again.",
                id=str(uuid.uuid4())
            )]
        }
    
    # logger.info(f"Processing document: type={file_data['type']}, mime={file_data['mime_type']}")
    
    # Build multimodal message for the LLM
    # The content format follows LangChain's multimodal message structure
    content_blocks: list[dict[str, Any]] = [
        {"type": "text", "text": "Please analyze this document and extract all structured information."},
    ]
    
    # Add the file content based on type
    if file_data["type"] == "base64":
        if file_data["mime_type"] == "application/pdf":
            # PDF as file type
            content_blocks.append({
                "type": "file",
                "source_type": "base64",
                "data": file_data["data"],
                "mime_type": "application/pdf",
            })
        else:
            # Image as image_url
            data_url = f"data:{file_data['mime_type']};base64,{file_data['data']}"
            content_blocks.append({
                "type": "image_url",
                "image_url": {"url": data_url},
            })
    else:
        # URL-based file
        content_blocks.append({
            "type": "file",
            "source_type": "url",
            "url": file_data["data"],
            "mime_type": file_data["mime_type"],
        })
    
    try:
        document_extractor = model.with_structured_output(ExtractedDocumentData) if state.get("model") == "local" else gemini.with_structured_output(ExtractedDocumentData)
        # Use the document extractor with structured output
        extraction_result = await document_extractor.ainvoke([
            {"role": "system", "content": invoice_extraction_prompt},
            {"role": "user", "content": content_blocks},
        ])


        
        # Convert result to dict for storage
        # The result should be an ExtractedDocumentData Pydantic model
        extracted_data: dict[str, Any] = {}
        if isinstance(extraction_result, ExtractedDocumentData):
            extracted_data = extraction_result.model_dump()
        elif hasattr(extraction_result, "model_dump"):
            extracted_data = extraction_result.model_dump()  # type: ignore
        elif isinstance(extraction_result, dict):
            extracted_data = extraction_result
        
        logger.info(f"Extraction complete: category={extracted_data.get('document_category')}, "
                   f"vendor={extracted_data.get('vendor_name')}, "
                   f"total={extracted_data.get('total_amount')}")
        
        # Generate a human-readable summary
        summary = _format_extraction_summary(extracted_data)
        
        ai_message = AIMessage(content=summary, id=str(uuid.uuid4()))
        
        return {
            "messages": [ai_message],
            "extracted_document": extracted_data,
        }
        
    except Exception as e:
        logger.error(f"Document extraction error: {e}")
        return {
            "messages": [AIMessage(
                content=f"I encountered an error while processing the document: {str(e)}. "
                       "Please ensure the file is a valid PDF or image and try again.",
                id=str(uuid.uuid4())
            )],
            "extracted_document": None,
        }


def _format_extraction_summary(data: dict) -> str:
    """Format extracted document data into a readable summary."""
    
    category = data.get("document_category", "document").replace("_", " ").title()
    vendor = data.get("vendor_name", "Unknown Vendor")
    invoice_num = data.get("invoice_number", "N/A")
    invoice_date = data.get("invoice_date", "N/A")
    due_date = data.get("due_date", "N/A")
    currency = data.get("currency", "USD")
    total = data.get("total_amount")
    subtotal = data.get("subtotal")
    tax = data.get("tax_amount")
    confidence = data.get("confidence_score", 0)
    
    # Format currency amounts
    def fmt_currency(amt):
        if amt is None:
            return "N/A"
        return f"{currency} {amt:,.2f}"
    
    summary_parts = [
        f"## 📄 {category} Extracted\n",
        f"**Vendor:** {vendor}",
        f"**Invoice Number:** {invoice_num}",
        f"**Date:** {invoice_date}",
    ]
    
    if due_date and due_date != "N/A":
        summary_parts.append(f"**Due Date:** {due_date}")
    
    if data.get("payment_terms"):
        summary_parts.append(f"**Payment Terms:** {data['payment_terms']}")
    
    summary_parts.append("")  # Empty line
    
    # Financial summary
    summary_parts.append("### 💰 Financial Summary")
    if subtotal:
        summary_parts.append(f"- **Subtotal:** {fmt_currency(subtotal)}")
    if tax:
        tax_rate = data.get("tax_rate")
        tax_str = fmt_currency(tax)
        if tax_rate:
            tax_str += f" ({tax_rate}%)"
        summary_parts.append(f"- **Tax:** {tax_str}")
    summary_parts.append(f"- **Total:** {fmt_currency(total)}")
    
    # Line items
    line_items = data.get("line_items", [])
    if line_items:
        summary_parts.append("")
        summary_parts.append("### 📋 Line Items")
        summary_parts.append("| Description | Qty | Unit Price | Amount |")
        summary_parts.append("|------------|-----|------------|--------|")
        for item in line_items[:10]:  # Limit to 10 items for readability
            desc = item.get("description", "")[:40]
            qty = item.get("quantity", "-")
            unit_price = item.get("unit_price")
            amount = item.get("amount")
            summary_parts.append(
                f"| {desc} | {qty} | {fmt_currency(unit_price) if unit_price else '-'} | {fmt_currency(amount) if amount else '-'} |"
            )
        if len(line_items) > 10:
            summary_parts.append(f"| ... and {len(line_items) - 10} more items | | | |")
    
    # Extraction metadata
    summary_parts.append("")
    conf_emoji = "✅" if confidence > 0.8 else "⚠️" if confidence > 0.5 else "❌"
    summary_parts.append(f"*Extraction confidence: {conf_emoji} {confidence:.0%}*")
    
    if data.get("extraction_notes"):
        summary_parts.append(f"\n*Note: {data['extraction_notes']}*")
    
    return "\n".join(summary_parts)


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


def route_by_context_sufficiency(state: AgentState) -> Literal["context_response", "route_by_type"]:
    """Route based on whether retrieved context is sufficient to answer the query.
    
    Routes:
    - context_sufficient=True → context_response (direct answer from context)
    - context_sufficient=False → route_by_type (continue to appropriate handler)
    """
    context_sufficient = state.get("context_sufficient", False)
    query_type = state.get("query_type")
    
    # Document extraction always needs processing
    if query_type == "document_extraction":
        logger.info("Document extraction - skipping context response")
        return "route_by_type"
    
    if context_sufficient:
        logger.info("Context is sufficient - routing to direct response")
        return "context_response"
    else:
        logger.info("Context not sufficient - continuing to specialized handler")
        return "route_by_type"


def route_by_query_type(state: AgentState) -> Literal["generic_response", "analytics_agent", "extract_document"]:
    """Route to appropriate handler based on query classification.
    
    Routes:
    - document_extraction → extract_document
    - analytics → analytics_agent
    - generic → generic_response
    """
    query_type = state.get("query_type", "generic")
    
    logger.info(f"Routing based on query_type: {query_type}")
    
    if query_type == "document_extraction":
        return "extract_document"
    elif query_type == "analytics":
        return "analytics_agent"
    else:  # generic
        return "generic_response"


# =============================================================================
# GRAPH CONSTRUCTION
# =============================================================================


def create_analytics_agent_graph() -> StateGraph:
    """Create and compile the ad-hoc analytics agent graph.
    
    Graph structure:
        START → classify_query → retrieve_context → evaluate_context_sufficiency
            → [route_by_context_sufficiency]
                → context_response → END  (if context is sufficient)
                → [route_by_query_type]   (if context not sufficient)
                    → extract_document → END
                    → generic_response → END
                    → analytics_agent → push_visualization → END
    
    The evaluate_context_sufficiency node uses an LLM to determine if the
    retrieved context fully answers the query, enabling early exit when
    document context is sufficient without needing database/analytics processing.
    """
    
    # Create the graph with our state schema
    builder = StateGraph(AgentState)
    
    # Add all nodes
    builder.add_node("classify_query", classify_query_node)
    builder.add_node("retrieve_context", retrieve_context_node)
    builder.add_node("evaluate_context_sufficiency", evaluate_context_sufficiency_node)
    builder.add_node("context_response", context_response_node)
    builder.add_node("extract_document", extract_document_node)
    builder.add_node("generic_response", generic_response_node)
    builder.add_node("analytics_agent", analytics_agent_node)
    builder.add_node("push_visualization", push_visualization_node)
    
    # Add edges
    builder.add_edge(START, "classify_query")
    
    # After classification, retrieve relevant context
    builder.add_edge("classify_query", "retrieve_context")
    
    # After context retrieval, evaluate if context is sufficient
    builder.add_edge("retrieve_context", "evaluate_context_sufficiency")
    
    # Conditional routing based on context sufficiency
    builder.add_conditional_edges(
        "evaluate_context_sufficiency",
        route_by_context_sufficiency,
        {
            "context_response": "context_response",
            "route_by_type": "route_by_type_node",
        }
    )
    
    # Add a pass-through node for query type routing
    # (needed because conditional edges need a target node)
    async def route_by_type_passthrough(state: AgentState) -> dict[str, Any]:
        """Pass-through node for query type routing."""
        return {}
    
    builder.add_node("route_by_type_node", route_by_type_passthrough)
    
    # Route from pass-through to appropriate handler
    builder.add_conditional_edges(
        "route_by_type_node",
        route_by_query_type,
        {
            "extract_document": "extract_document",
            "generic_response": "generic_response",
            "analytics_agent": "analytics_agent",
        }
    )
    
    # Context-based response goes straight to END
    builder.add_edge("context_response", END)
    
    # Document extraction goes straight to END
    builder.add_edge("extract_document", END)
    
    # Generic queries go straight to END
    builder.add_edge("generic_response", END)
    
    # Analytics queries go through visualization then END
    builder.add_edge("analytics_agent", "push_visualization")
    builder.add_edge("push_visualization", END)
    
    return builder


# =============================================================================
# COMPILED AGENT
# =============================================================================


# Create and compile the graph
graph_builder = create_analytics_agent_graph()
agent = graph_builder.compile(name="threadwise-analytics-agent")


# =============================================================================
# EXPORTS
# =============================================================================

__all__ = ["agent", "AgentState", "create_analytics_agent_graph"]
