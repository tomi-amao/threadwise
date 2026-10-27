"""Health check endpoints for ThreadWise AI Agent."""

import logging
import os
from datetime import datetime

from fastapi import APIRouter

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/")
def read_root():
    """Welcome endpoint. Builds no services, like /health below.

    It used to construct them to report which were enabled, and the embedding service loads a
    sentence-transformers model: opening the service URL in a browser starved a small instance
    of CPU until LangGraph's own health checks timed out.
    """
    return {
        "message": "Welcome to ThreadWise AI Agent API",
        "version": "0.1.0",
        "docs": "/docs",
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
