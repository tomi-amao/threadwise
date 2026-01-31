"""API routes for ThreadWise AI Agent.

Combines all route modules into a single router.
"""

from fastapi import APIRouter

from .health import router as health_router
from .chat import router as chat_router
from .embeddings import router as embeddings_router
from .inngest import router as inngest_router

# Main API router
router = APIRouter()

# Include all sub-routers
router.include_router(health_router, tags=["Health"])
router.include_router(chat_router, prefix="/chat", tags=["Chat"])
router.include_router(embeddings_router, prefix="/embeddings", tags=["Embeddings"])
router.include_router(inngest_router, prefix="/inngest", tags=["Inngest"])

__all__ = ["router"]
