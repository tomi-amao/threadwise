"""Health check endpoints for ThreadWise AI Agent."""

import logging
import os
from datetime import datetime

from fastapi import APIRouter

router = APIRouter()
logger = logging.getLogger(__name__)


def get_services():
    """Get service instances (lazy import to avoid circular deps)."""
    try:
        from ...services.embedding_service import get_embedding_service
        from ...services.langgraph_service import LangGraphService

        embedding_service = get_embedding_service()
        langgraph_service = LangGraphService()
    except ImportError:
        embedding_service = None
        langgraph_service = None

    try:
        from ...integrations.inngest import get_inngest_client, validate_inngest_config

        inngest_client = get_inngest_client()
    except ImportError:
        inngest_client = None
        validate_inngest_config = None

    return embedding_service, langgraph_service, inngest_client, validate_inngest_config


@router.get("/")
def read_root():
    """Welcome endpoint."""
    embedding_service, langgraph_service, inngest_client, _ = get_services()

    return {
        "message": "Welcome to ThreadWise AI Agent API",
        "version": "0.1.0",
        "docs": "/docs",
        "services": {
            "chat": "enabled" if langgraph_service else "disabled",
            "embeddings": "enabled" if embedding_service else "disabled",
            "inngest": "enabled" if inngest_client else "disabled",
        },
    }


@router.get("/health")
def health_check():
    """Liveness probe: answers at once and builds no services.

    It used to construct the embedding service, which loads a sentence-transformers model
    (tens of seconds) and fails without a Pinecone key, so a probe could time out or
    report an optional dependency as the whole service being down.
    """
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-agent",
        # The deployed commit, which Render sets. The Inngest sync workflow waits for it to
        # match the pushed commit, so it only syncs once the new code is serving.
        "commit": os.environ.get("RENDER_GIT_COMMIT"),
    }


@router.get("/stats")
def get_stats():
    """Get API statistics."""
    return {
        "total_messages": 0,  # Placeholder - integrate with actual storage
        "api_version": "0.1.0",
        "uptime": "running",
        "last_message_time": None,
    }
