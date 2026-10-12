"""API module for ThreadWise AI Agent.

Contains API routes, schemas, and endpoint definitions.
"""

from .schemas import (
    # Chat schemas
    ChatMessage,
    ChatResponse,
    ThreadCreateResponse,
    CreateAssistantRequest,
    # Embedding schemas
    EmbedFileRequest,
    EmbedFileResponse,
    SearchRequest,
    HybridSearchRequest,
    SearchResponse,
    DeleteEmbeddingsRequest,
    DeleteNamespaceRequest,
    # Legacy schemas
    Message,
    MessageResponse,
)
from .routes import router

__all__ = [
    # Schemas
    "ChatMessage",
    "ChatResponse",
    "ThreadCreateResponse",
    "CreateAssistantRequest",
    "EmbedFileRequest",
    "EmbedFileResponse",
    "SearchRequest",
    "HybridSearchRequest",
    "SearchResponse",
    "DeleteEmbeddingsRequest",
    "DeleteNamespaceRequest",
    "Message",
    "MessageResponse",
    # Router
    "router",
]
