"""Inngest configuration and client setup for ThreadWise AI Agent."""

import logging
import os
from typing import Dict, Any

import inngest

# Configure logger
logger = logging.getLogger(__name__)

# Inngest client configuration
INNGEST_APP_ID = os.getenv("INNGEST_APP_ID", "threadwise-ai-agent")
INNGEST_EVENT_KEY = os.getenv("INNGEST_EVENT_KEY")
INNGEST_SIGNING_KEY = os.getenv("INNGEST_SIGNING_KEY")

# Initialize Inngest client
client = inngest.Inngest(
    app_id=INNGEST_APP_ID,
    logger=logger,
    event_key=INNGEST_EVENT_KEY,
    signing_key=INNGEST_SIGNING_KEY,
)

def get_client() -> inngest.Inngest:
    """Get the configured Inngest client."""
    return client

def validate_config() -> Dict[str, Any]:
    """Validate Inngest configuration and return status."""
    config_status = {
        "app_id": INNGEST_APP_ID,
        "event_key_configured": bool(INNGEST_EVENT_KEY),
        "signing_key_configured": bool(INNGEST_SIGNING_KEY),
        "client_initialized": client is not None,
    }
    
    # Log configuration warnings
    if not INNGEST_EVENT_KEY:
        logger.warning("INNGEST_EVENT_KEY not configured - some features may be limited")
    
    if not INNGEST_SIGNING_KEY:
        logger.warning("INNGEST_SIGNING_KEY not configured - webhook signature verification disabled")
    
    return config_status