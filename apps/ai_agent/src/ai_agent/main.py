"""AI Agent API built with FastAPI.

This module provides a unified REST API for both LangGraph chat functionality
and embedding services for the ThreadWise platform.

The API is organized into modular routers:
- Health endpoints (/, /health, /stats)
- Chat endpoints (/chat/*)
- Embedding endpoints (/embeddings/*)
- Inngest endpoints (/inngest/*)
"""

# IMPORTANT: Configure logging BEFORE any langgraph/inngest imports
# This prevents the structlog format_exc_info warning
try:
    from .core import logging_config  # noqa: F401
except ImportError:
    pass

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def get_services():
    """Initialize and return service instances."""
    langgraph_service = None
    # The embedding service is deliberately NOT created here: constructing it
    # loads a sentence-transformers model (torch) and makes blocking Pinecone
    # network calls, which ran on every server start and hot reload. Routes and
    # graph nodes call get_embedding_service() lazily on first use instead.
    embedding_service = None
    inngest_client = None
    inngest_functions = []
    validate_inngest_config = None

    # Import services
    try:
        from .services.langgraph_service import LangGraphService

        langgraph_service = LangGraphService()
    except ImportError:
        try:
            from ai_agent.services.langgraph_service import LangGraphService

            langgraph_service = LangGraphService()
        except ImportError:
            logger.warning("Services not available")

    # Import Inngest configuration
    try:
        from .integrations.inngest import (
            get_inngest_client,
        )
        from .integrations.inngest import inngest_functions as functions
        from .integrations.inngest import validate_inngest_config as validate_config

        inngest_client = get_inngest_client()
        validate_inngest_config = validate_config
        inngest_functions = functions
    except ImportError:
        try:
            from ai_agent.integrations.inngest import (
                get_inngest_client,
            )
            from ai_agent.integrations.inngest import inngest_functions as functions
            from ai_agent.integrations.inngest import (
                validate_inngest_config as validate_config,
            )

            inngest_client = get_inngest_client()
            validate_inngest_config = validate_config
            inngest_functions = functions
        except ImportError:
            logger.warning("Inngest modules not available")

    return (
        langgraph_service,
        embedding_service,
        inngest_client,
        inngest_functions,
        validate_inngest_config,
    )


# Get service instances
(
    langgraph_service,
    embedding_service,
    inngest_client,
    inngest_functions,
    validate_inngest_config,
) = get_services()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    # Startup
    if langgraph_service:
        await langgraph_service.initialize()
        logger.info("LangGraph service initialized")

    if inngest_client and validate_inngest_config:
        config_status = validate_inngest_config()
        logger.info(f"Inngest initialized: {config_status}")

    yield

    # Shutdown
    logger.info("Application shutting down")


# Create FastAPI application
app = FastAPI(
    title="ThreadWise AI Agent API",
    description="Unified AI Agent API with LangGraph chat and embedding services",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: only the app's own origins (CORS_ALLOW_ORIGINS, comma-separated). Auth is a bearer
# token in a header, not a cookie, so credentials are not shared cross-origin.
from .core.config import settings  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
)

# Setup Inngest endpoint
if inngest_client and inngest_functions:
    from inngest.fast_api import serve as inngest_serve

    inngest_serve(app, inngest_client, inngest_functions)
    logger.info(f"Inngest endpoint configured with {len(inngest_functions)} functions")

# Include API routers
from .api.routes import router as api_router  # noqa: E402

app.include_router(api_router)

logger.info("ThreadWise AI Agent API initialized")
