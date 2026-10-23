"""Pydantic schemas for ThreadWise AI Agent API."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

# =============================================================================
# CHAT SCHEMAS
# =============================================================================


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


class CreateAssistantRequest(BaseModel):
    """Request model for creating an assistant."""

    graph_name: str
    model_name: str
    assistant_name: str
    context: Optional[Dict[str, Any]] = None


# =============================================================================
# EMBEDDING SCHEMAS
# =============================================================================


class EmbedFileRequest(BaseModel):
    """Request model for file embedding from storage."""

    file_type: str
    file_url: str
    entity_id: Optional[str] = None  # Optional tenant/entity scoping


class EmbedFileResponse(BaseModel):
    """Response model for file embedding."""

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
    """Request model for document search."""

    query: str
    limit: Optional[int] = 5
    namespace: Optional[str] = None  # Pinecone namespace for multi-tenancy
    filter_metadata: Optional[Dict[str, Any]] = None  # Pinecone filter format
    similarity_threshold: Optional[float] = 0.7  # Minimum similarity score (0-1)


class HybridSearchRequest(BaseModel):
    """Request model for hybrid document search (semantic + lexical)."""

    query: str
    limit: Optional[int] = 5
    namespace: Optional[str] = None
    filter_metadata: Optional[Dict[str, Any]] = None
    alpha: Optional[float] = 0.7  # Balance: 1.0=pure semantic, 0.0=pure lexical
    similarity_threshold: Optional[float] = 0.0  # Lower threshold for hybrid
    rerank: Optional[bool] = True  # Enable reranking for improved relevance
    rerank_candidates_multiplier: Optional[int] = (
        3  # Retrieve N×limit candidates for reranking
    )


class SearchResponse(BaseModel):
    """Response model for document search."""

    results: List[dict]
    query: str
    namespace: Optional[str] = None
    filters_applied: Optional[Dict[str, Any]] = None
    search_type: Optional[str] = "semantic"  # "semantic" or "hybrid"
    alpha: Optional[float] = None  # Only for hybrid search


class DeleteEmbeddingsRequest(BaseModel):
    """Request model for deleting embeddings."""

    filename: Optional[str] = None
    document_id: Optional[str] = None  # More precise deletion by document_id
    namespace: Optional[str] = None  # Namespace to delete from


class DeleteNamespaceRequest(BaseModel):
    """Request model for deleting an entire namespace."""

    namespace: str


# =============================================================================
# LEGACY SCHEMAS (for backwards compatibility)
# =============================================================================


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
