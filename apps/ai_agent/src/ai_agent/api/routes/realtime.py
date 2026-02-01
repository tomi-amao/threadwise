"""API routes for Inngest Realtime subscriptions.

Provides secure token generation for frontend clients to subscribe to realtime updates.
"""

import logging
from typing import List

from fastapi import APIRouter, HTTPException, status, Query
from pydantic import BaseModel, Field

from ...integrations.inngest.config import get_subscription_token
from ...integrations.inngest.channels import get_sync_channel, SYNC_TOPICS
from ...services.external_sync_service import sync_service

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class SubscriptionTokenRequest(BaseModel):
    """Request to generate a subscription token."""
    
    source_id: str = Field(..., description="External source ID to subscribe to")
    topics: List[str] = Field(
        default=SYNC_TOPICS,
        description="Topics to subscribe to (e.g., ['progress', 'status'])"
    )


class SubscriptionTokenResponse(BaseModel):
    """Response containing subscription token."""
    
    token: str = Field(..., description="Subscription token for realtime connection")
    channel: str = Field(..., description="Channel name")
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
    Generates a secure token for subscribing to realtime updates from Inngest sync functions.
    
    The token is scoped to a specific source and set of topics, ensuring users can only
    subscribe to data they're authorized to access. Tokens expire after 60 seconds for security.
    
    **Authorization**: This endpoint should verify that the user has access to the specified source.
    Currently, authorization checks are placeholder - implement proper auth before production.
    """,
)
async def create_subscription_token(
    request: SubscriptionTokenRequest,
) -> SubscriptionTokenResponse:
    """Generate a subscription token for realtime updates.
    
    Args:
        request: Token request with source_id and topics
        
    Returns:
        Token response with subscription details
        
    Raises:
        HTTPException: If source not found or authorization fails
    """
    try:
        # Verify the source exists
        source = await sync_service.get_external_source(request.source_id)
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {request.source_id}"
            )
        
        # TODO: Add proper authorization checks here
        # Example: Verify that the current user has access to this source
        # entity_id = source.get("entity_id")
        # if not await user_has_access_to_entity(current_user, entity_id):
        #     raise HTTPException(status_code=403, detail="Access denied")
        
        # Validate topics
        invalid_topics = [t for t in request.topics if t not in SYNC_TOPICS]
        if invalid_topics:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid topics: {invalid_topics}. Valid topics: {SYNC_TOPICS}"
            )
        
        # Generate channel name
        channel = get_sync_channel(request.source_id)
        
        # Get subscription token from Inngest
        token_data = await get_subscription_token(
            channel=channel,
            topics=request.topics
        )
        
        logger.info(
            f"Generated subscription token for source {request.source_id}, "
            f"channel: {channel}, topics: {request.topics}"
        )
        
        return SubscriptionTokenResponse(
            token=token_data["key"],
            channel=channel,
            topics=request.topics,
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
    
    Args:
        source_id: External source ID
        
    Returns:
        Channel information including name and available topics
    """
    # Verify source exists
    source = await sync_service.get_external_source(source_id)
    
    if not source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"External source not found: {source_id}"
        )
    
    channel = get_sync_channel(source_id)
    
    return {
        "channel": channel,
        "topics": SYNC_TOPICS,
        "source_id": source_id,
        "provider": source.get("provider"),
        "display_name": source.get("display_name"),
    }
