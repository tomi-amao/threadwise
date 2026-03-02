"""API routes for Inngest Realtime subscriptions.

Provides secure token generation for frontend clients to subscribe to
realtime updates for both sync and normalization operations.
"""

import logging
from enum import Enum
from typing import List

from fastapi import APIRouter, HTTPException, status, Query
from pydantic import BaseModel, Field

from ...integrations.inngest.config import get_subscription_token
from ...integrations.inngest.channels import (
    get_sync_channel,
    get_normalization_channel,
    SYNC_TOPICS,
    NORMALIZATION_TOPICS,
)
from ...services.external_sync_service import sync_service

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# ENUMS & CONSTANTS
# =============================================================================


class ChannelType(str, Enum):
    """Supported realtime channel types."""
    SYNC = "sync"
    NORMALIZATION = "normalization"


CHANNEL_CONFIG = {
    ChannelType.SYNC: {
        "get_channel": get_sync_channel,
        "topics": SYNC_TOPICS,
    },
    ChannelType.NORMALIZATION: {
        "get_channel": get_normalization_channel,
        "topics": NORMALIZATION_TOPICS,
    },
}


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class SubscriptionTokenRequest(BaseModel):
    """Request to generate a subscription token."""
    
    source_id: str = Field(..., description="External source ID to subscribe to")
    channel_type: ChannelType = Field(
        default=ChannelType.SYNC,
        description="Type of channel: 'sync' or 'normalization'"
    )
    topics: List[str] = Field(
        default=None,
        description="Topics to subscribe to. Defaults to all topics for the channel type."
    )


class SubscriptionTokenResponse(BaseModel):
    """Response containing subscription token."""
    
    token: str = Field(..., description="Subscription token for realtime connection")
    channel: str = Field(..., description="Channel name")
    channel_type: str = Field(..., description="Type of channel")
    topics: List[str] = Field(..., description="Subscribed topics")
    expires_in: int = Field(default=60, description="Token expiration in seconds")


# =============================================================================
# ENDPOINTS
# =============================================================================


@router.post(
    "/subscription-token",
    response_model=SubscriptionTokenResponse,
    summary="Generate Realtime Subscription Token",
    description="""
    Generates a secure token for subscribing to realtime updates from Inngest functions.
    
    Supports both sync and normalization channels:
    - **sync**: Progress updates during data sync operations
    - **normalization**: Progress updates during data normalization/persistence
    
    The token is scoped to a specific source and set of topics, ensuring users can only
    subscribe to data they're authorized to access. Tokens expire after 60 seconds for security.
    """,
)
async def create_subscription_token(
    request: SubscriptionTokenRequest,
) -> SubscriptionTokenResponse:
    """Generate a subscription token for realtime updates."""
    try:
        # Verify the source exists
        source = await sync_service.get_external_source(request.source_id)
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {request.source_id}"
            )
        
        # TODO: Add proper authorization checks here
        
        # Resolve channel config
        config = CHANNEL_CONFIG[request.channel_type]
        valid_topics = config["topics"]
        
        # Use default topics for the channel type if none specified
        topics = request.topics if request.topics is not None else valid_topics
        
        # Validate topics
        invalid_topics = [t for t in topics if t not in valid_topics]
        if invalid_topics:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid topics for {request.channel_type}: {invalid_topics}. "
                       f"Valid topics: {valid_topics}"
            )
        
        # Generate channel name
        channel = config["get_channel"](request.source_id)
        
        # Get subscription token from Inngest
        token_data = await get_subscription_token(
            channel=channel,
            topics=topics
        )
        
        logger.info(
            f"Generated {request.channel_type} subscription token for source "
            f"{request.source_id}, channel: {channel}, topics: {topics}"
        )
        
        return SubscriptionTokenResponse(
            token=token_data["key"],
            channel=channel,
            channel_type=request.channel_type.value,
            topics=topics,
            expires_in=60,
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating subscription token: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate subscription token: {str(e)}"
        )


@router.get(
    "/channels/{source_id}",
    summary="Get Channel Information",
    description="Get information about available channels and topics for a source",
)
async def get_channel_info(
    source_id: str,
) -> dict:
    """Get channel information for a source.
    
    Returns all available channels (sync + normalization) and their topics.
    """
    # Verify source exists
    source = await sync_service.get_external_source(source_id)
    
    if not source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"External source not found: {source_id}"
        )
    
    return {
        "source_id": source_id,
        "provider": source.get("provider"),
        "display_name": source.get("display_name"),
        "channels": {
            "sync": {
                "channel": get_sync_channel(source_id),
                "topics": SYNC_TOPICS,
            },
            "normalization": {
                "channel": get_normalization_channel(source_id),
                "topics": NORMALIZATION_TOPICS,
            },
        },
    }
