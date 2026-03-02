"""API routes for ThreadWise AI Agent.

Combines all route modules into a single router.
"""

from fastapi import APIRouter

from .health import router as health_router
from .chat import router as chat_router
from .embeddings import router as embeddings_router
from .inngest import router as inngest_router
from .integrations import router as integrations_router
from .realtime import router as realtime_router
from .normalization import router as normalization_router
from .accounting import router as accounting_router

# Main API router
router = APIRouter()

# Include all sub-routers
router.include_router(health_router, tags=["Health"])
router.include_router(chat_router, prefix="/chat", tags=["Chat"])
router.include_router(embeddings_router, prefix="/embeddings", tags=["Embeddings"])
router.include_router(inngest_router, prefix="/inngest", tags=["Inngest"])
router.include_router(integrations_router, prefix="/integrations", tags=["Integrations"])
router.include_router(realtime_router, prefix="/realtime", tags=["Realtime"])
router.include_router(normalization_router, prefix="/normalization", tags=["Normalization"])
router.include_router(accounting_router, prefix="/accounting", tags=["Accounting"])

__all__ = ["router"]
