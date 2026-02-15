"""API routes for external integrations management.

Provides endpoints for managing external sources and triggering syncs.
"""

import asyncio
import logging
from typing import List, Optional

import inngest
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ...integrations.inngest import get_client
from ...normalization.inngest_functions import trigger_source_normalization
from ...services.external_sync_service import sync_service

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class CreateEntityRequest(BaseModel):
    """Request to create an entity."""

    name: str = Field(..., description="Entity name")
    currency: str = Field(
        ..., min_length=3, max_length=3, description="3-letter currency code"
    )
    legal_name: Optional[str] = Field(None, description="Legal name")
    country: Optional[str] = Field(None, description="Country code")


class EntityResponse(BaseModel):
    """Entity response."""

    id: str
    name: str
    currency: str
    legal_name: Optional[str]
    country: Optional[str]
    created_at: str


class CreateExternalSourceRequest(BaseModel):
    """Request to create an external source connection."""

    entity_id: str = Field(..., description="Parent entity ID")
    provider: str = Field(..., description="Provider name (e.g., 'squarespace')")
    external_account_id: str = Field(
        ..., description="External account ID (e.g., site ID)"
    )
    display_name: Optional[str] = Field(None, description="Display name")
    api_key: str = Field(..., description="API key for the provider")


class ExternalSourceResponse(BaseModel):
    """External source response."""

    id: str
    entity_id: Optional[str]
    provider: str
    external_account_id: str
    display_name: Optional[str]
    sync_status: str
    sync_error: Optional[str]
    last_synced_at: Optional[str]
    sync_cursor: Optional[str]
    created_at: str
    updated_at: str


class TriggerSyncRequest(BaseModel):
    """Request to trigger a sync."""

    endpoint: Optional[str] = Field(
        None,
        description="Specific endpoint to sync (products, orders, etc.). If not provided, syncs all.",
    )


class TriggerSyncResponse(BaseModel):
    """Response from triggering a sync."""

    source_id: str
    status: str
    message: str
    event_ids: List[str] = []


class SyncStatsResponse(BaseModel):
    """Sync statistics response."""

    source_id: str
    provider: str
    stats: dict


class IntegrationSummary(BaseModel):
    """Summary of an integration for UI display."""

    id: str
    provider: str
    display_name: Optional[str]
    external_account_id: str
    sync_status: str
    sync_error: Optional[str]
    last_synced_at: Optional[str]
    entity_name: Optional[str]
    stats: Optional[dict]
    api_key_status: Optional[str] = "pending"
    api_key_last_validated_at: Optional[str] = None
    api_key_error: Optional[str] = None
    failed_events_count: int = 0


class ValidateApiKeyResponse(BaseModel):
    """Response from API key validation."""

    source_id: str
    status: str
    message: str
    provider: str


class TriggerNormalizeRequest(BaseModel):
    """Request to trigger normalization for a source."""

    mode: str = Field(
        default="soft",
        description="'hard' resets all to pending; 'soft' only processes pending",
    )
    batch_size: int = Field(default=100, ge=1, le=500, description="Events per batch")


class TriggerNormalizeResponse(BaseModel):
    """Response from triggering normalization."""

    source_id: str
    status: str
    mode: str
    message: str
    event_ids: List[str] = []


# =============================================================================
# ENTITY ENDPOINTS
# =============================================================================


@router.post(
    "/entities", response_model=EntityResponse, status_code=status.HTTP_201_CREATED
)
async def create_entity(request: CreateEntityRequest):
    """Create a new entity."""
    try:
        result = await sync_service.create_entity(
            name=request.name,
            currency=request.currency,
            legal_name=request.legal_name,
            country=request.country,
        )

        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create entity",
            )

        return result

    except Exception as e:
        logger.error(f"Error creating entity: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/entities", response_model=List[EntityResponse])
async def list_entities():
    """List all entities."""
    try:
        return await sync_service.list_entities()
    except Exception as e:
        logger.error(f"Error listing entities: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# =============================================================================
# EXTERNAL SOURCE ENDPOINTS
# =============================================================================


@router.post(
    "/sources",
    response_model=ExternalSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_external_source(request: CreateExternalSourceRequest):
    """Create a new external source connection."""
    try:
        # Store credentials securely (API key)
        credentials = {"api_key": request.api_key}

        result = await sync_service.create_external_source(
            entity_id=request.entity_id,
            provider=request.provider,
            external_account_id=request.external_account_id,
            credentials=credentials,
            display_name=request.display_name,
        )

        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create external source",
            )

        return result

    except Exception as e:
        logger.error(f"Error creating external source: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/sources", response_model=List[ExternalSourceResponse])
async def list_external_sources(
    entity_id: Optional[str] = None, provider: Optional[str] = None
):
    """List external sources with optional filtering."""
    try:
        return await sync_service.list_external_sources(
            entity_id=entity_id, provider=provider
        )
    except Exception as e:
        logger.error(f"Error listing external sources: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/sources/{source_id}", response_model=ExternalSourceResponse)
async def get_external_source(source_id: str):
    """Get an external source by ID."""
    try:
        result = await sync_service.get_external_source(source_id)

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}",
            )

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting external source: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# =============================================================================
# SYNC ENDPOINTS
# =============================================================================


@router.post("/sources/{source_id}/sync", response_model=TriggerSyncResponse)
async def trigger_sync(source_id: str, request: Optional[TriggerSyncRequest] = None):
    """Trigger a sync for an external source.

    If endpoint is specified, syncs only that endpoint.
    Otherwise, syncs all endpoints.
    """
    try:
        # Verify source exists
        source = await sync_service.get_external_source(source_id)

        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}",
            )

        # Check if already syncing
        if source.get("sync_status") == "syncing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Sync already in progress"
            )

        # Get Inngest client
        inngest_client = get_client()

        print("Inngest client obtained:", inngest_client)
        # Trigger appropriate sync event
        if request and request.endpoint:
            # Single endpoint sync
            event_ids = await inngest_client.send(
                inngest.Event(
                    name="squarespace/sync.endpoint",
                    data={"source_id": source_id, "endpoint": request.endpoint},
                )
            )

            message = f"Triggered sync for {request.endpoint}"
        else:
            # Full sync
            event_ids = await inngest_client.send(
                {"name": "squarespace/sync.requested", "data": {"source_id": source_id}}
            )
            message = "Triggered full sync for all endpoints"

        logger.info(f"{message} for source {source_id}")

        return TriggerSyncResponse(
            source_id=source_id,
            status="triggered",
            message=message,
            event_ids=event_ids if event_ids else [],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering sync: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.post("/sources/{source_id}/validate", response_model=ValidateApiKeyResponse)
async def validate_api_key(source_id: str):
    """Validate the API key for an external source.

    Tests the API key by making a simple request to the provider's API.
    Updates the api_key_status based on the result.
    """
    try:
        # Get the source
        source = await sync_service.get_external_source(source_id)

        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}",
            )

        provider = source.get("provider", "unknown")

        # Get the API key from Vault
        api_key = await sync_service.get_api_key(source_id)

        if not api_key:
            await sync_service.update_api_key_status(
                source_id, "invalid", "No API key configured"
            )
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="invalid",
                message="No API key configured",
                provider=provider,
            )

        # Validate based on provider
        is_valid = False
        error_message = None

        if provider == "squarespace":
            is_valid, error_message = await _validate_squarespace_api_key(api_key)
        elif provider == "revolut":
            is_valid, error_message = await _validate_revolut_api_key(api_key)
        else:
            error_message = f"Unknown provider: {provider}"

        # Update status
        if is_valid:
            await sync_service.update_api_key_status(source_id, "valid")
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="valid",
                message="API key is valid and working",
                provider=provider,
            )
        else:
            await sync_service.update_api_key_status(
                source_id, "invalid", error_message
            )
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="invalid",
                message=error_message or "API key validation failed",
                provider=provider,
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error validating API key: {e}")
        await sync_service.update_api_key_status(source_id, "invalid", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


async def _validate_squarespace_api_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Validate a Squarespace API key by making a test request."""
    import httpx

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://api.squarespace.com/1.0/commerce/inventory",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "ThreadWise/1.0",
                },
                params={"limit": 1},
                timeout=10.0,
            )

            if response.status_code == 200:
                return True, None
            elif response.status_code == 401:
                return False, "Invalid API key - authentication failed"
            elif response.status_code == 403:
                return False, "API key lacks required permissions"
            else:
                return False, f"API returned status {response.status_code}"
    except httpx.TimeoutException:
        return False, "Request timed out - check your network connection"
    except Exception as e:
        return False, f"Connection error: {str(e)}"


async def _validate_revolut_api_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Validate a Revolut API key by making a test request."""
    import httpx

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://b2b.revolut.com/api/1.0/accounts",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "ThreadWise/1.0",
                },
                timeout=10.0,
            )

            if response.status_code == 200:
                return True, None
            elif response.status_code == 401:
                return False, "Invalid API key - authentication failed"
            elif response.status_code == 403:
                return False, "API key lacks required permissions"
            else:
                return False, f"API returned status {response.status_code}"
    except httpx.TimeoutException:
        return False, "Request timed out - check your network connection"
    except Exception as e:
        return False, f"Connection error: {str(e)}"


@router.get("/sources/{source_id}/stats", response_model=SyncStatsResponse)
async def get_sync_stats(source_id: str):
    """Get sync statistics for an external source."""
    try:
        source = await sync_service.get_external_source(source_id)

        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}",
            )

        stats = await sync_service.get_sync_stats(source_id)

        return SyncStatsResponse(
            source_id=source_id, provider=source.get("provider", "unknown"), stats=stats
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting sync stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# =============================================================================
# NORMALIZATION ENDPOINTS
# =============================================================================


@router.post(
    "/sources/{source_id}/normalize",
    response_model=TriggerNormalizeResponse,
    summary="Trigger Normalization",
    description="""
    Trigger normalization and persistence for all raw events from a source.
    
    This is the "Load Data" action in the UI. After syncing raw data, this 
    endpoint processes it into canonical models (customers, orders, products, etc.).
    
    **Modes:**
    - `soft` (default): Only processes events with status 'pending'. Safe to re-run.
    - `hard`: Resets ALL events to 'pending' and reprocesses everything from scratch.
    
    Progress is streamed via Inngest Realtime on the normalization channel.
    """,
)
async def trigger_normalize(
    source_id: str,
    request: Optional[TriggerNormalizeRequest] = None,
):
    """Trigger normalization for an external source."""
    try:
        # Verify source exists
        source = await sync_service.get_external_source(source_id)

        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}",
            )

        mode = request.mode if request else "soft"
        batch_size = request.batch_size if request else 100

        if mode not in ("hard", "soft"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="mode must be 'hard' or 'soft'",
            )

        event_ids = await trigger_source_normalization(
            source_id=source_id, mode=mode, batch_size=batch_size
        )

        if event_ids is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to trigger normalization",
            )

        logger.info(f"Triggered {mode} normalization for source {source_id}")

        return TriggerNormalizeResponse(
            source_id=source_id,
            status="triggered",
            mode=mode,
            message=f"Normalization triggered ({mode} mode)",
            event_ids=event_ids,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering normalization: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# =============================================================================
# INTEGRATION SUMMARY (for UI)
# =============================================================================


@router.get("/summary", response_model=List[IntegrationSummary])
async def get_integrations_summary(entity_id: Optional[str] = None):
    """Get a summary of all integrations for UI display.

    Args:
        entity_id: Optional entity ID to filter by (for user's entity)
    """
    try:
        sources = await sync_service.list_external_sources(entity_id=entity_id)

        summaries = []
        for source in sources:
            # Get stats for each source
            try:
                stats = await sync_service.get_sync_stats(source["id"])
            except Exception:
                stats = None

            # Get failed events count
            failed_count = 0
            try:
                result = await asyncio.to_thread(
                    lambda: sync_service.client.table("external_raw_events")
                    .select("id", count="exact")
                    .eq("source_id", source["id"])
                    .eq("processing_status", "failed")
                    .execute()
                )
                failed_count = result.count or 0
            except Exception as e:
                logger.warning(
                    f"Failed to get failed events count for {source['id']}: {e}"
                )

            # Extract entity name from joined data
            entity_name = None
            if source.get("entities"):
                entity_name = source["entities"].get("name")

            summaries.append(
                IntegrationSummary(
                    id=source["id"],
                    provider=source["provider"],
                    display_name=source.get("display_name"),
                    external_account_id=source["external_account_id"],
                    sync_status=source.get("sync_status", "unknown"),
                    sync_error=source.get("sync_error"),
                    last_synced_at=source.get("last_synced_at"),
                    entity_name=entity_name,
                    stats=stats,
                    api_key_status=source.get("api_key_status", "pending"),
                    api_key_last_validated_at=source.get("api_key_last_validated_at"),
                    api_key_error=source.get("api_key_error"),
                    failed_events_count=failed_count,
                )
            )

        return summaries

    except Exception as e:
        logger.error(f"Error getting integrations summary: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )
