# agent/main.py
"""AI Agent API built with FastAPI.

This module provides a unified REST API for both LangGraph chat functionality
and embedding services for the ThreadWise platform.
"""
import os
from datetime import datetime
from typing import List, Optional, Dict, Any
import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Import services
try:
    from .services.embedding_service import embedding_service
    from .services.langgraph_service import LangGraphService
except ImportError:
    try:
        from ai_agent.services.embedding_service import embedding_service
        from ai_agent.services.langgraph_service import LangGraphService
    except ImportError:
        embedding_service = None
        LangGraphService = None
        print("Warning: Services not available")
from fastapi import Body

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize services
langgraph_service = LangGraphService() if LangGraphService else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    # Startup
    if langgraph_service:
        await langgraph_service.initialize()
        logger.info("LangGraph service initialized")
    
    if embedding_service:
        logger.info("Embedding service available")
    
    yield
    
    # Shutdown
    logger.info("Application shutting down")


app = FastAPI(
    title="ThreadWise AI Agent API",
    description="Unified AI Agent API with LangGraph chat and embedding services",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for chat
class ChatMessage(BaseModel):
    """Pydantic model for chat message data."""
    content: str
    thread_id: Optional[str] = None
    assistant_id: Optional[str] = None
    attachments: Optional[List[dict]] = None


class ChatResponse(BaseModel):
    """Pydantic model for chat response."""
    content: str
    thread_id: str
    assistant_id: str
    timestamp: datetime
    status: str


class ThreadCreateResponse(BaseModel):
    """Response model for thread creation."""
    thread_id: str
    assistant_id: str
    status: str


# Pydantic models for embeddings
class EmbedFileRequest(BaseModel):
    """Request model for file embedding from storage"""
    file_type: str
    file_url: str
    entity_id: Optional[str] = None  # Optional tenant/entity scoping


class EmbedFileResponse(BaseModel):
    """Response model for file embedding"""
    success: bool
    documentId: Optional[str] = None
    chunks: Optional[int] = None
    filename: str
    text_length: Optional[int] = None
    document_category: Optional[str] = None
    entity_id: Optional[str] = None
    namespace: Optional[str] = None  # Pinecone namespace for multi-tenancy
    hybrid_enabled: Optional[bool] = None  # Whether sparse vectors were stored
    sparse_vector_count: Optional[int] = None  # Number of chunks with sparse vectors
    error: Optional[str] = None


class SearchRequest(BaseModel):
    """Request model for document search"""
    query: str
    limit: Optional[int] = 5
    namespace: Optional[str] = None  # Pinecone namespace for multi-tenancy
    filter_metadata: Optional[Dict[str, Any]] = None  # Pinecone filter format, e.g., {"document_category": {"$eq": "invoice"}}
    similarity_threshold: Optional[float] = 0.7  # Minimum similarity score (0-1)


class HybridSearchRequest(BaseModel):
    """Request model for hybrid document search (semantic + lexical)"""
    query: str
    limit: Optional[int] = 5
    namespace: Optional[str] = None
    filter_metadata: Optional[Dict[str, Any]] = None
    alpha: Optional[float] = 0.7  # Balance: 1.0=pure semantic, 0.0=pure lexical
    similarity_threshold: Optional[float] = 0.0  # Lower threshold for hybrid
    rerank: Optional[bool] = True  # Enable reranking for improved relevance
    rerank_candidates_multiplier: Optional[int] = 3  # Retrieve N×limit candidates for reranking


class SearchResponse(BaseModel):
    """Response model for document search"""
    results: List[dict]
    query: str
    namespace: Optional[str] = None
    filters_applied: Optional[Dict[str, Any]] = None
    search_type: Optional[str] = "semantic"  # "semantic" or "hybrid"
    alpha: Optional[float] = None  # Only for hybrid search


# Legacy message models (for backwards compatibility)
class Message(BaseModel):
    """Pydantic model for incoming message data."""
    id: Optional[int] = None
    content: str
    timestamp: Optional[datetime] = None


class MessageResponse(BaseModel):
    """Pydantic model for API message responses."""
    id: int
    content: str
    timestamp: datetime
    status: str


# In-memory storage (for demo purposes)
messages = []
message_counter = 0


@app.get("/")
def read_root():
    """Welcome endpoint."""
    return {
        "message": "Welcome to ThreadWise AI Agent API",
        "version": "0.1.0",
        "docs": "/docs",
        "services": {
            "chat": "enabled" if langgraph_service else "disabled",
            "embeddings": "enabled" if embedding_service else "disabled"
        }
    }


@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-agent",
        "chat_service": "enabled" if langgraph_service else "disabled",
        "embedding_service": "enabled" if embedding_service else "disabled"
    }


# ======================================
# CHAT ENDPOINTS (LangGraph Integration)
# ======================================

@app.get("/chat/health")
async def chat_health():
    """Check LangGraph service health."""
    if not langgraph_service:
        return {"status": "error", "message": "LangGraph service not available"}
    
    try:
        health_status = await langgraph_service.health_check()
        return health_status
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/chat", response_model=ChatResponse)
async def send_chat_message(message: ChatMessage):
    """Send a message to the LangGraph agent."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.send_message(
            content=message.content,
            thread_id=message.thread_id,
            attachments=message.attachments,
            assistant_id=message.assistant_id
        )
        return ChatResponse(**response)
    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/threads", response_model=ThreadCreateResponse)
async def create_chat_thread():
    """Create a new chat thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.create_thread()
        return ThreadCreateResponse(**response)
    except Exception as e:
        logger.error(f"Thread creation error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/threads/{thread_id}/messages")
async def get_thread_messages(thread_id: str):
    """Get all messages from a thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        messages_data = await langgraph_service.get_thread_messages(thread_id)
        return {"messages": messages_data}
    except Exception as e:
        logger.error(f"Get messages error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/chat/threads/{thread_id}")
async def delete_chat_thread(thread_id: str):
    """Delete a chat thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.delete_thread(thread_id)
        return response
    except Exception as e:
        logger.error(f"Thread deletion error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/chat/assistants")
async def list_assistants():
    """List all available assistants."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.list_assistants()
        return response
    except Exception as e:
        logger.error(f"List assistants error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    
class CreateAssistantRequest(BaseModel):
    graph_name: str
    model_name: str
    assistant_name: str
    context: Optional[Dict[str, Any]] = None

@app.post("/chat/assistants")
async def create_assistant(request: CreateAssistantRequest):
    """Create a new assistant."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.create_assistant(
            graph_name=request.graph_name,
            model_name=request.model_name,
            assistant_name=request.assistant_name,
            context=request.context
        )
        return response
    except Exception as e:
        logger.error(f"Create assistant error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
# ===========================================
# EMBEDDING ENDPOINTS (Vector Storage)
# ===========================================

@app.get("/embeddings/health")
async def embeddings_health():
    """Check embedding service health."""
    if not embedding_service:
        return {"status": "error", "message": "Embedding service not available"}
    
    try:
        # Full health check including Pinecone connection
        health_status = await embedding_service.health_check()
        health_status["timestamp"] = datetime.now().isoformat()
        return health_status
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/embeddings/embed", response_model=EmbedFileResponse)
async def embed_file(request: EmbedFileRequest):
    """Embed a file with enriched metadata into Pinecone vector store.
    
    The file will be automatically categorized based on filename patterns.
    Provide entity_id for multi-tenant namespace isolation - each entity_id
    maps to a separate Pinecone namespace for efficient data isolation.
    """
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        result = await embedding_service.embed_file(
            file_url=request.file_url,
            filename=request.file_url.split("/")[-1],
            file_type=request.file_type,
            entity_id=request.entity_id
        )
        return EmbedFileResponse(**result)
    except Exception as e:
        logger.error(f"Embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embeddings/search", response_model=SearchResponse)
async def search_documents(request: SearchRequest):
    """Search documents using dense (semantic) vector similarity.
    
    This is pure semantic search - matches by meaning and relationships.
    For combined semantic + keyword search, use /embeddings/hybrid-search.
    
    Pinecone filter examples (use operator syntax):
    - {"document_category": {"$eq": "invoice"}} - Only invoice documents
    - {"file_type": {"$eq": "application/pdf"}} - Only PDF documents
    - {"chunk_index": {"$lt": 5}} - Only first 5 chunks
    
    Namespace: Use namespace parameter for multi-tenant searches. If not provided,
    searches in the "default" namespace.
    """
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        results = await embedding_service.search_documents(
            query=request.query,
            limit=request.limit or 5,
            namespace=request.namespace,
            filter_metadata=request.filter_metadata,
            similarity_threshold=request.similarity_threshold or 0.7
        )
        return SearchResponse(
            results=results,
            query=request.query,
            namespace=request.namespace,
            filters_applied=request.filter_metadata,
            search_type="semantic"
        )
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embeddings/hybrid-search", response_model=SearchResponse)
async def hybrid_search_documents(request: HybridSearchRequest):
    """Search documents using hybrid (semantic + lexical) search with optional reranking.
    
    ## Two-Stage Retrieval Architecture:
    
    **Stage 1 - Hybrid Search:** Combines semantic and lexical matching
    - Dense vectors (semantic): Captures meaning and relationships
    - Sparse vectors (lexical): Captures exact keyword matches
    
    **Stage 2 - Reranking (default: enabled):** Cross-encoder model re-scores results
    - Uses bge-reranker-v2-m3 for precise relevance scoring
    - Retrieves more candidates initially, returns top N after reranking
    - Significantly improves relevance for RAG pipelines
    
    ## Parameters:
    
    **alpha** (float, 0.0-1.0): Balance between semantic and lexical search
    - alpha=1.0: Pure semantic search (meaning-based)
    - alpha=0.0: Pure lexical search (keyword-based)
    - alpha=0.7: Recommended default (70% semantic, 30% lexical)
    
    **rerank** (bool): Enable/disable reranking
    - true (default): Two-stage retrieval with reranking (best quality)
    - false: Single-stage hybrid search only (faster, less accurate)
    
    **rerank_candidates_multiplier** (int): Candidate retrieval multiplier
    - Default: 3 (retrieves 3× limit candidates for reranking)
    - Higher values: More candidates to choose from (slower but potentially better)
    - Lower values: Fewer candidates (faster but may miss relevant results)
    
    ## Use Cases:
    
    **With Reranking (Recommended for RAG):**
    ```json
    {
        "query": "What are the payment terms in my invoices?",
        "limit": 5,
        "alpha": 0.7,
        "rerank": true,
        "filter_metadata": {"document_category": {"$eq": "invoice"}}
    }
    ```
    
    **Without Reranking (Speed-Critical):**
    ```json
    {
        "query": "invoice #12345",
        "limit": 10,
        "alpha": 0.3,
        "rerank": false
    }
    ```
    
    **General Search with Custom Reranking:**
    ```json
    {
        "query": "Q3 revenue analysis",
        "limit": 5,
        "alpha": 0.8,
        "rerank": true,
        "rerank_candidates_multiplier": 4
    }
    ```
    """
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        results = await embedding_service.hybrid_search_with_rerank(
            query=request.query,
            limit=request.limit or 5,
            namespace=request.namespace,
            filter_metadata=request.filter_metadata,
            alpha=request.alpha or 0.7,
            similarity_threshold=request.similarity_threshold or 0.0,
            rerank=request.rerank if request.rerank is not None else True,
            rerank_candidates_multiplier=request.rerank_candidates_multiplier or 3,
        )
        return SearchResponse(
            results=results,
            query=request.query,
            namespace=request.namespace,
            filters_applied=request.filter_metadata,
            search_type="hybrid_with_rerank" if request.rerank else "hybrid",
            alpha=request.alpha or 0.7
        )
    except Exception as e:
        logger.error(f"Hybrid search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteEmbeddingsRequest(BaseModel):
    """Request model for deleting embeddings"""
    filename: Optional[str] = None
    document_id: Optional[str] = None  # More precise deletion by document_id
    namespace: Optional[str] = None  # Namespace to delete from


@app.delete("/embeddings")
async def delete_document_embeddings(request: DeleteEmbeddingsRequest):
    """Delete embeddings for a specific document by filename or document_id.
    
    Provide either filename or document_id (document_id is more precise).
    Uses hierarchical vector IDs for efficient deletion.
    """
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    if not request.filename and not request.document_id:
        raise HTTPException(status_code=400, detail="Must provide either filename or document_id")
    
    try:
        result = await embedding_service.delete_file_embeddings(
            filename=request.filename,
            document_id=request.document_id,
            namespace=request.namespace
        )
        return {
            "success": result,
            "deleted_by": "document_id" if request.document_id else "filename",
            "identifier": request.document_id or request.filename,
            "namespace": request.namespace or "default"
        }
    except Exception as e:
        logger.error(f"Delete embeddings error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/embeddings/categories")
async def list_document_categories():
    """List available document categories for filtering."""
    return {
        "categories": [
            {"name": "invoice", "patterns": ["invoice", "bill", "receipt"]},
            {"name": "contract", "patterns": ["contract", "agreement", "terms"]},
            {"name": "report", "patterns": ["report", "analysis", "summary"]},
            {"name": "financial", "patterns": ["financial", "statement", "balance", "p&l", "profit"]},
            {"name": "legal", "patterns": ["legal", "compliance", "regulation"]},
            {"name": "hr", "patterns": ["employee", "hr", "payroll", "personnel"]},
            {"name": "general", "patterns": []},
        ],
        "usage": "Use category name in filter_metadata with Pinecone operator syntax when searching, e.g., {\"document_category\": {\"$eq\": \"invoice\"}}",
        "operators": ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]
    }


@app.get("/embeddings/stats")
async def get_index_stats():
    """Get Pinecone index statistics including namespace breakdown."""
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        stats = await embedding_service.get_index_stats()
        return stats
    except Exception as e:
        logger.error(f"Get index stats error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteNamespaceRequest(BaseModel):
    """Request model for deleting an entire namespace"""
    namespace: str


@app.delete("/embeddings/namespace")
async def delete_namespace(request: DeleteNamespaceRequest):
    """Delete an entire namespace (all documents for a tenant).
    
    WARNING: This permanently deletes all vectors in the namespace.
    Useful for tenant offboarding or complete data cleanup.
    """
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    if not request.namespace or request.namespace == "default":
        raise HTTPException(
            status_code=400, 
            detail="Cannot delete the default namespace. Specify a tenant namespace."
        )
    
    try:
        result = await embedding_service.delete_namespace(request.namespace)
        return {
            "success": result,
            "namespace": request.namespace,
            "message": f"Namespace '{request.namespace}' deleted successfully" if result else "Deletion failed"
        }
    except Exception as e:
        logger.error(f"Delete namespace error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
def get_stats():
    """Get API statistics."""
    return {
        "total_messages": len(messages),
        "api_version": "0.1.0",
        "uptime": "running",
        "last_message_time": (
            messages[-1]["timestamp"].isoformat() if messages else None
        ),
    }


# # ================================
# # MAIN ENTRY POINT
# # ================================

# if __name__ == "__main__":
#     uvicorn.run(
#         "ai_agent.main:app",
#         host="0.0.0.0",
#         port=8000,
#         reload=True,
#         log_level="info",
#     )
