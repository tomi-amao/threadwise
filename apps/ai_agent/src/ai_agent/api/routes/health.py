"""Health check endpoints for ThreadWise AI Agent."""

from datetime import datetime
import logging

from fastapi import APIRouter

router = APIRouter()
logger = logging.getLogger(__name__)


def get_services():
    """Get service instances (lazy import to avoid circular deps)."""
    try:
        from ...services.embedding_service import embedding_service
        from ...services.langgraph_service import LangGraphService
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
            "inngest": "enabled" if inngest_client else "disabled"
        }
    }


@router.get("/health")
def health_check():
    """Health check endpoint."""
    embedding_service, langgraph_service, inngest_client, validate_inngest_config = get_services()
    
    inngest_status = "disabled"
    inngest_config = {}
    
    if inngest_client and validate_inngest_config:
        inngest_status = "enabled"
        inngest_config = validate_inngest_config()
    
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-agent",
        "chat_service": "enabled" if langgraph_service else "disabled",
        "embedding_service": "enabled" if embedding_service else "disabled",
        "inngest_service": inngest_status,
        "inngest_config": inngest_config
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
