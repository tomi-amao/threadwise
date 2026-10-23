"""API module for ThreadWise AI Agent.

Contains API routes, schemas, and endpoint definitions.
"""

from .routes import router
from .schemas import (  # Chat schemas; Embedding schemas; Legacy schemas
    ChatMessage,
    ChatResponse,
    CreateAssistantRequest,
    DeleteEmbeddingsRequest,
    DeleteNamespaceRequest,
    EmbedFileRequest,
    EmbedFileResponse,
    HybridSearchRequest,
    Message,
    MessageResponse,
    SearchRequest,
    SearchResponse,
    ThreadCreateResponse,
)

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
