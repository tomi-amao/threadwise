"""Inngest configuration and client setup for ThreadWise AI Agent."""

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict

import inngest
from inngest.experimental import realtime

from ...core.config import settings

# Configure logger
logger = logging.getLogger(__name__)

# Inngest client configuration from settings
INNGEST_APP_ID = settings.inngest_app_id
INNGEST_EVENT_KEY = settings.inngest_event_key
INNGEST_SIGNING_KEY = settings.inngest_signing_key

# Without INNGEST_ENV the SDK names its Inngest environment after the platform's git branch, and
# Render sets RENDER_GIT_BRANCH=main. Production then reported itself as a "main" branch
# environment: Inngest created one on the first sync, refused every sync into Production ("SDK
# environment is outside this key's access"), and that environment's crons were rejected by the
# production signing key. Production is the environment with no name, so only INNGEST_ENV may name
# one (for a real branch environment). The SDK reads these once, when the client is created.
PLATFORM_BRANCH_VARS = (
    "RAILWAY_GIT_BRANCH",
    "RENDER_GIT_BRANCH",
    "VERCEL_GIT_COMMIT_REF",
)


def create_client() -> inngest.Inngest:
    """The Inngest client, in the environment INNGEST_ENV names (Production when it is unset)."""
    hidden = {
        name: os.environ.pop(name)
        for name in PLATFORM_BRANCH_VARS
        if name in os.environ
    }
    try:
        return inngest.Inngest(
            app_id=INNGEST_APP_ID,
            logger=logger,
            event_key=INNGEST_EVENT_KEY,
            signing_key=INNGEST_SIGNING_KEY,
        )
    finally:
        os.environ.update(hidden)


client = create_client()


def get_client() -> inngest.Inngest:
    """Get the configured Inngest client."""
    return client


async def get_subscription_token(channel: str, topics: list[str]) -> dict[str, Any]:
    """Generate a subscription token for realtime updates.

    Args:
        channel: The channel name to subscribe to (e.g., 'sync:source_id')
        topics: List of topics to subscribe to (e.g., ['progress', 'status'])

    Returns:
        A dictionary containing the subscription token and metadata
    """
    token = await realtime.get_subscription_token(
        client=client,
        channel=channel,
        topics=topics,
    )
    # The JWT is minted against client.api_origin (dev server vs. cloud,
    # per INNGEST_DEV) - the frontend must open its realtime WebSocket
    # against that same origin, or a dev-server-signed token gets rejected
    # by the default `wss://api.inngest.com` endpoint the JS SDK falls
    # back to when no origin is given.
    return {**token, "apiBaseUrl": client.api_origin}


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
        logger.warning(
            "INNGEST_EVENT_KEY not configured - some features may be limited"
        )

    if not INNGEST_SIGNING_KEY:
        logger.warning(
            "INNGEST_SIGNING_KEY not configured - webhook signature verification disabled"
        )

    return config_status


async def utc_now_iso() -> str:
    """Current UTC time as ISO 8601, for use as a durable ``step.run`` handler."""
    return datetime.now(timezone.utc).isoformat()
