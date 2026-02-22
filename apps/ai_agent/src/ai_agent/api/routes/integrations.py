"""API routes for external integrations management.

Provides endpoints for managing external sources and triggering syncs.
"""

import asyncio
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

import inngest


from ...services.external_sync_service import sync_service
from ...integrations.inngest import get_client
from ...normalization.inngest_functions import trigger_source_normalization

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class CreateEntityRequest(BaseModel):
    """Request to create an entity."""
    
    name: str = Field(..., description="Entity name")
    currency: str = Field(..., min_length=3, max_length=3, description="3-letter currency code")
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
    external_account_id: str = Field(..., description="External account ID (e.g., site ID)")
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
        description="Specific endpoint to sync (products, orders, etc.). If not provided, syncs all."
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
    entity_id: Optional[str] = None
    sync_status: str
    sync_error: Optional[str]
    last_synced_at: Optional[str]
    entity_name: Optional[str]
    stats: Optional[dict]
    api_key_status: Optional[str] = "pending"
    api_key_last_validated_at: Optional[str] = None
    api_key_error: Optional[str] = None
    failed_events_count: int = 0
    uncategorized_transactions_count: int = 0


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
        description="'hard' resets all to pending; 'soft' only processes pending"
    )
    batch_size: int = Field(default=100, ge=1, le=500, description="Events per batch")


class TriggerNormalizeResponse(BaseModel):
    """Response from triggering normalization."""
    
    source_id: str
    status: str
    mode: str
    message: str
    event_ids: List[str] = []


class UpdateApiKeyRequest(BaseModel):
    """Request to update an API key for an external source."""
    
    api_key: str = Field(..., min_length=1, description="New API key")


class UpdateApiKeyResponse(BaseModel):
    """Response from updating an API key."""
    
    source_id: str
    status: str
    message: str


# =============================================================================
# ENTITY ENDPOINTS
# =============================================================================


@router.post("/entities", response_model=EntityResponse, status_code=status.HTTP_201_CREATED)
async def create_entity(request: CreateEntityRequest):
    """Create a new entity."""
    try:
        result = await sync_service.create_entity(
            name=request.name,
            currency=request.currency,
            legal_name=request.legal_name,
            country=request.country
        )
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create entity"
            )
        
        return result
    
    except Exception as e:
        logger.error(f"Error creating entity: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/entities", response_model=List[EntityResponse])
async def list_entities():
    """List all entities."""
    try:
        return await sync_service.list_entities()
    except Exception as e:
        logger.error(f"Error listing entities: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# EXTERNAL SOURCE ENDPOINTS
# =============================================================================


@router.post("/sources", response_model=ExternalSourceResponse, status_code=status.HTTP_201_CREATED)
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
            display_name=request.display_name
        )
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create external source"
            )
        
        return result
    
    except Exception as e:
        logger.error(f"Error creating external source: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/sources", response_model=List[ExternalSourceResponse])
async def list_external_sources(
    entity_id: Optional[str] = None,
    provider: Optional[str] = None
):
    """List external sources with optional filtering."""
    try:
        return await sync_service.list_external_sources(
            entity_id=entity_id,
            provider=provider
        )
    except Exception as e:
        logger.error(f"Error listing external sources: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/sources/{source_id}", response_model=ExternalSourceResponse)
async def get_external_source(source_id: str):
    """Get an external source by ID."""
    try:
        result = await sync_service.get_external_source(source_id)

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}"
            )

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting external source: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.delete("/sources/{source_id}")
async def delete_external_source(source_id: str):
    """Delete an external source and all associated data.

    Cascades: raw events, Vault API key, source record.
    """
    try:
        result = await sync_service.delete_external_source(source_id)

        if result is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}"
            )

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting external source: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# API KEY MANAGEMENT
# =============================================================================


@router.put("/sources/{source_id}/api-key", response_model=UpdateApiKeyResponse)
async def update_api_key(source_id: str, request: UpdateApiKeyRequest):
    """Update the API key for an external source.
    
    Stores the new key securely in Vault and resets the validation status.
    """
    try:
        source = await sync_service.get_external_source(source_id)
        
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"External source not found: {source_id}"
            )
        
        await sync_service.update_api_key(source_id, request.api_key)
        
        return UpdateApiKeyResponse(
            source_id=source_id,
            status="updated",
            message="API key updated successfully. Please validate the new key."
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating API key: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
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
                detail=f"External source not found: {source_id}"
            )

        # Check if already syncing
        if source.get("sync_status") == "syncing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Sync already in progress"
            )

        # Get Inngest client
        inngest_client = get_client()

        provider = source.get("provider", "squarespace")

        # Trigger appropriate sync event based on provider
        if request and request.endpoint:
            # Single endpoint sync
            event_ids = await inngest_client.send(
                inngest.Event(
                    name=f"{provider}/sync.endpoint",
                    data={
                    "source_id": source_id,
                    "endpoint": request.endpoint
                    }
                )
                )

            message = f"Triggered sync for {request.endpoint}"
        else:
            # Full sync
            event_ids = await inngest_client.send({
                "name": f"{provider}/sync.requested",
                "data": {
                    "source_id": source_id
                }
            })
            message = "Triggered full sync for all endpoints"

        logger.info(f"{message} for source {source_id} (provider={provider})")
        
        return TriggerSyncResponse(
            source_id=source_id,
            status="triggered",
            message=message,
            event_ids=event_ids if event_ids else []
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering sync: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
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
                detail=f"External source not found: {source_id}"
            )
        
        provider = source.get("provider", "unknown")
        
        # Get the API key from Vault
        api_key = await sync_service.get_api_key(source_id)
        
        if not api_key:
            await sync_service.update_api_key_status(source_id, "invalid", "No API key configured")
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="invalid",
                message="No API key configured",
                provider=provider
            )
        
        # Validate based on provider
        is_valid = False
        error_message = None
        
        if provider == "squarespace":
            is_valid, error_message = await _validate_squarespace_api_key(api_key)
        elif provider == "revolut":
            is_valid, error_message = await _validate_revolut_api_key(api_key)
        elif provider == "paypal":
            is_valid, error_message = await _validate_paypal_api_key(api_key)
        else:
            error_message = f"Unknown provider: {provider}"
        
        # Update status
        if is_valid:
            await sync_service.update_api_key_status(source_id, "valid")
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="valid",
                message="API key is valid and working",
                provider=provider
            )
        else:
            await sync_service.update_api_key_status(source_id, "invalid", error_message)
            return ValidateApiKeyResponse(
                source_id=source_id,
                status="invalid",
                message=error_message or "API key validation failed",
                provider=provider
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error validating API key: {e}")
        await sync_service.update_api_key_status(source_id, "invalid", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
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
                    "User-Agent": "ThreadWise/1.0"
                },
                params={"limit": 1},
                timeout=10.0
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
                    "User-Agent": "ThreadWise/1.0"
                },
                timeout=10.0
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


async def _validate_paypal_api_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Validate PayPal credentials by attempting OAuth2 token exchange.

    The api_key is expected to be a JSON string: {"client_id":"...","secret":"..."}
    """
    import httpx
    import json
    import os

    try:
        creds = json.loads(api_key)
        client_id = creds.get("client_id")
        secret = creds.get("secret")

        if not client_id or not secret:
            return False, "PayPal credentials must include 'client_id' and 'secret'"

        base_url = os.environ.get("PAYPAL_API_URL", "https://api-m.paypal.com")

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{base_url}/v1/oauth2/token",
                auth=(client_id, secret),
                data={"grant_type": "client_credentials"},
                headers={"Accept": "application/json"},
                timeout=10.0,
            )

            if response.status_code == 200:
                return True, None
            elif response.status_code == 401:
                return False, "Invalid client_id or secret - authentication failed"
            else:
                return False, f"PayPal API returned status {response.status_code}"
    except json.JSONDecodeError:
        return False, "PayPal credentials must be valid JSON: {\"client_id\":\"...\",\"secret\":\"...\"}"
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
                detail=f"External source not found: {source_id}"
            )
        
        stats = await sync_service.get_sync_stats(source_id)
        
        return SyncStatsResponse(
            source_id=source_id,
            provider=source.get("provider", "unknown"),
            stats=stats
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting sync stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
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
    """
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
                detail=f"External source not found: {source_id}"
            )
        
        mode = request.mode if request else "soft"
        batch_size = request.batch_size if request else 100
        
        if mode not in ("hard", "soft"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="mode must be 'hard' or 'soft'"
            )
        
        event_ids = await trigger_source_normalization(
            source_id=source_id,
            mode=mode,
            batch_size=batch_size
        )
        
        if event_ids is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to trigger normalization"
            )
        
        logger.info(
            f"Triggered {mode} normalization for source {source_id}"
        )
        
        return TriggerNormalizeResponse(
            source_id=source_id,
            status="triggered",
            mode=mode,
            message=f"Normalization triggered ({mode} mode)",
            event_ids=event_ids
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering normalization: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# INCOMPLETE TRANSACTIONS (missing chart_of_accounts assignment)
# =============================================================================


class IncompleteTransaction(BaseModel):
    """A financial transaction needing expense categorization in metadata."""
    
    id: str
    source: str
    external_transaction_id: str
    transaction_type: str
    amount: float
    currency_code: str
    direction: str
    occurred_at: str
    description: Optional[str]
    counterparty_name: Optional[str]
    metadata: Optional[dict]


class IncompleteTransactionsResponse(BaseModel):
    """Response with list of incomplete transactions."""
    
    transactions: List[IncompleteTransaction]
    total_count: int


class UpdateTransactionCategoryRequest(BaseModel):
    """Request to assign an account_number (and category) to a transaction's metadata."""
    
    account_number: str = Field(
        ..., description="Account number from chart_of_accounts to assign"
    )


class UpdateTransactionCategoryResponse(BaseModel):
    """Response from updating a transaction's category."""
    
    transaction_id: str
    account_number: str
    expense_category: Optional[str]
    status: str


class AISuggestCategoryRequest(BaseModel):
    """Request for AI-suggested categorization."""
    
    transaction_ids: List[str] = Field(
        ..., max_length=50, description="Up to 50 transaction IDs to categorize"
    )


class AISuggestion(BaseModel):
    """AI-generated category suggestion for a transaction."""
    
    transaction_id: str
    suggested_account_number: Optional[str]
    suggested_expense_category: Optional[str]
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: Optional[str]


class AISuggestCategoryResponse(BaseModel):
    """Response with AI-suggested categories."""
    
    suggestions: List[AISuggestion]


class CategorizationResult(BaseModel):
    """Structured output from LLM for transaction categorization."""
    
    suggested_code: str = Field(
        description="The account number from the chart of accounts (e.g., '6100'). Use '6999' if uncertain."
    )
    confidence: float = Field(
        description="Confidence score between 0 and 1",
        ge=0.0,
        le=1.0
    )
    reasoning: str = Field(
        description="Brief explanation of why this category fits the transaction"
    )


@router.get(
    "/transactions/incomplete",
    response_model=IncompleteTransactionsResponse,
    summary="Get Incomplete Transactions",
    description="Get financial transactions that are missing expense categorization in metadata."
)
async def get_incomplete_transactions(
    source_id: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """Get transactions that need expense categorization."""
    try:
        import asyncio
        from ...core.supabase_client import get_supabase_client
        client = get_supabase_client()
        if not client:
            raise RuntimeError("Supabase client not configured")
        
        # Wrap blocking DB calls in asyncio.to_thread
        def _fetch_transactions():
            source = client.table("external_sources") \
                .select("entity_id, provider") \
                .eq("id", source_id) \
                .execute().data
            # Build query for transactions missing account_code in metadata
            # We look for transactions where metadata->account_code is null
            query = client.table("financial_transactions") \
                .select("*", count="exact") \
                .eq("entity_id", source[0]["entity_id"]) \
                .eq("source", source[0]["provider"]) \
                .in_("transaction_type", ["payment", "fee", "other"])
            
            return query.order("occurred_at", desc=True) \
                .range(offset, offset + limit - 1) \
                .execute()
        
        result = await asyncio.to_thread(_fetch_transactions)
        logging.info(f"Fetched {len(result.data or [])} incomplete transactions (total count: {result.count})")
        
        # Filter client-side: only include rows where metadata lacks account_code
        filtered = []
        for row in (result.data or []):
            meta = row.get("metadata") or {}
            if not meta.get("account_code"):
                filtered.append(row)
        
        transactions = [
            IncompleteTransaction(
                id=row["id"],
                source=row["source"],
                external_transaction_id=row["external_transaction_id"],
                transaction_type=row.get("transaction_type", "other"),
                amount=float(row["amount"]),
                currency_code=row.get("currency_code", "GBP"),
                direction=row["direction"],
                occurred_at=row["occurred_at"],
                description=row.get("description"),
                counterparty_name=row.get("counterparty_name"),
                metadata=row.get("metadata"),
            )
            for row in filtered
        ]
        
        return IncompleteTransactionsResponse(
            transactions=transactions,
            total_count=result.count or 0,
        )
    
    except Exception as e:
        logger.error(f"Error getting incomplete transactions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.put(
    "/transactions/{transaction_id}/category",
    response_model=UpdateTransactionCategoryResponse,
    summary="Assign Category to Transaction",
    description="Assign a chart_of_accounts entry to a financial transaction."
)
async def update_transaction_category(
    transaction_id: str,
    request: UpdateTransactionCategoryRequest,
):
    """Assign a chart_of_accounts entry to a transaction via metadata."""
    try:
        import asyncio
        from ...core.supabase_client import get_supabase_client
        client = get_supabase_client()
        if not client:
            raise RuntimeError("Supabase client not configured")
        
        # Wrap blocking DB calls in asyncio.to_thread
        def _update_transaction():
            # Get the chart_of_accounts entry by account_number
            coa_result = client.table("chart_of_accounts") \
                .select("id, account_number, name") \
                .eq("account_number", request.account_number) \
                .execute()
            
            if not coa_result.data:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Chart of accounts entry not found: {request.account_number}"
                )
            
            coa = coa_result.data[0]
            
            # Fetch existing metadata
            txn_result = client.table("financial_transactions") \
                .select("id, metadata") \
                .eq("id", transaction_id) \
                .execute()
            
            if not txn_result.data:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Transaction not found: {transaction_id}"
                )
            
            existing_meta = txn_result.data[0].get("metadata") or {}
            updated_meta = {
                **existing_meta,
                "account_code": coa["account_number"],
                "expense_category": coa.get("name"),
            }
            
            # Update the transaction's metadata
            update_result = client.table("financial_transactions") \
                .update({"metadata": updated_meta}) \
                .eq("id", transaction_id) \
                .execute()
            
            return coa, update_result
        
        coa, update_result = await asyncio.to_thread(_update_transaction)
        
        if not update_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Transaction not found: {transaction_id}"
            )
        
        return UpdateTransactionCategoryResponse(
            transaction_id=transaction_id,
            account_number=coa["account_number"],
            expense_category=coa.get("name"),
            status="updated",
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating transaction category: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.post(
    "/transactions/ai-categorize",
    response_model=AISuggestCategoryResponse,
    summary="AI-Suggest Categories",
    description="Use AI to suggest chart_of_accounts categories for transactions based on their description, merchant, and MCC data."
)
async def ai_suggest_categories(request: AISuggestCategoryRequest):
    """AI-powered category suggestion for uncategorized transactions."""
    try:
        import asyncio
        import json
        from ...core.supabase_client import get_supabase_client
        from ...core import get_local_llm
        
        client = get_supabase_client()
        if not client:
            raise RuntimeError("Supabase client not configured")
        
        # Wrap blocking DB calls in asyncio.to_thread
        def _fetch_data():
            # Fetch transactions with their raw_event_id
            txn_result = client.table("financial_transactions") \
                .select("id, raw_event_id") \
                .in_("id", request.transaction_ids) \
                .execute()
            
            if not txn_result.data:
                return [], []
            
            # Fetch raw event payloads for these transactions
            raw_event_ids = [txn["raw_event_id"] for txn in txn_result.data if txn.get("raw_event_id")]
            
            raw_events = []
            if raw_event_ids:
                raw_events_result = client.table("external_raw_events") \
                    .select("id, payload") \
                    .in_("id", raw_event_ids) \
                    .execute()
                raw_events = {event["id"]: event["payload"] for event in (raw_events_result.data or [])}
            
            # Map transactions to their payloads
            txn_data = []
            for txn in txn_result.data:
                raw_event_id = txn.get("raw_event_id")
                if raw_event_id and raw_event_id in raw_events:
                    txn_data.append({
                        "id": txn["id"],
                        "payload": raw_events[raw_event_id]
                    })
            
            # Fetch all chart_of_accounts entries
            coa_result = client.table("chart_of_accounts") \
                .select("id, account_number, name, account_type") \
                .order("account_number") \
                .execute()
            
            return txn_data, coa_result.data or []
        
        txn_data, coa_entries = await asyncio.to_thread(_fetch_data)
        
        if not txn_data:
            return AISuggestCategoryResponse(suggestions=[])
        
        # Use LLM with structured output
        llm = get_local_llm("qwen/qwen3-vl-4b")
        structured_llm = llm.with_structured_output(CategorizationResult)
        
        # Build chart of accounts context for LLM
        coa_context = "\n".join([
            f"- Account {entry['account_number']}: {entry['name']} (type: {entry.get('account_type', 'N/A')})"
            for entry in coa_entries
        ])
        
        system_prompt = f"""You are a financial categorization expert. Analyze the financial transaction data and categorize it into the most appropriate chart of accounts entry.

            Available Chart of Accounts:
            {coa_context}

            Analyze all available transaction data including description, counterparty, merchant details, amounts, fees, and any metadata to make the best categorization decision.
        """
        
        suggestions = []
        
        # Process transactions
        for txn in txn_data:
            try:
                # Provide the full raw event payload to give AI maximum context
                transaction_json = json.dumps(txn["payload"], indent=2, default=str)
                
                user_prompt = f"""Categorize this financial transaction based on the raw event payload:

                    {transaction_json}

                    Based on all available information in this raw payload, select the most appropriate chart of accounts code.
                """
                
                logging.info(f"Categorizing transaction {txn['id']} with structured LLM using raw payload {transaction_json}")
                
                # Invoke LLM with structured output
                result: CategorizationResult = await structured_llm.ainvoke([
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ])
                logging.info(f"LLM suggested code {result.suggested_code} with confidence {result.confidence} for transaction {txn['id']}") 
                # Find matching CoA entry
                expense_category = None
                for entry in coa_entries:
                    if entry["account_number"] == result.suggested_code:
                        expense_category = entry.get("name")
                        break
                
                suggestions.append(AISuggestion(
                    transaction_id=txn["id"],
                    suggested_account_number=result.suggested_code,
                    suggested_expense_category=expense_category,
                    confidence=result.confidence,
                    reasoning=result.reasoning,
                ))
                
            except Exception as e:
                logger.error(f"LLM categorization failed for txn {txn['id']}: {e}")
                # Fallback to rule-based
                fallback = _rule_based_categorize(txn, coa_entries)
                suggestions.append(fallback)
        
        return AISuggestCategoryResponse(suggestions=suggestions)
    
    except Exception as e:
        logger.error(f"Error in AI categorization: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


def _rule_based_categorize(
    txn: dict,
    coa_entries: list,
) -> AISuggestion:
    """Rule-based categorization using merchant name, MCC, and description."""
    from ...normalization.revolut_normalizer import RevolutNormalizer
    
    metadata = txn.get("metadata") or {}
    merchant = metadata.get("merchant") or {}
    merchant_name = merchant.get("name", "")
    mcc_code = merchant.get("category_code")
    description = txn.get("description", "")
    counterparty = txn.get("counterparty_name", "")
    
    # Use RevolutNormalizer's categorization logic
    normalizer = RevolutNormalizer.__new__(RevolutNormalizer)
    
    # Try merchant name overrides
    account_code = None
    expense_category = None
    confidence = 0.0
    reasoning = None
    
    if merchant_name:
        name_lower = merchant_name.lower()
        for prefix, (acct, cat) in RevolutNormalizer.MERCHANT_NAME_OVERRIDES.items():
            if name_lower.startswith(prefix):
                account_code = acct
                expense_category = cat
                confidence = 0.9
                reasoning = f"Matched merchant name '{merchant_name}' to known vendor"
                break
    
    # Try MCC code
    if not account_code and mcc_code:
        try:
            mcc_int = int(mcc_code)
            for (lo, hi), (acct, cat) in RevolutNormalizer.MCC_ACCOUNT_MAP.items():
                if lo <= mcc_int <= hi:
                    account_code = acct
                    expense_category = cat
                    confidence = 0.7
                    reasoning = f"Matched MCC code {mcc_code}"
                    break
        except (ValueError, TypeError):
            pass
    
    # Try description keywords
    if not account_code and (description or counterparty):
        text = f"{description} {counterparty}".lower()
        keyword_map = {
            ("shipping", "delivery", "post", "courier"): ("6200", "outbound_shipping"),
            ("google", "facebook", "meta", "ads", "marketing"): ("6100", "marketing"),
            ("software", "subscription", "saas", "cloud"): ("6300", "software"),
            ("office", "supplies", "stationery"): ("6800", "office_supplies"),
            ("insurance"): ("6700", "insurance"),
            ("legal", "lawyer", "solicitor", "accountant"): ("6600", "professional_services"),
            ("rent", "utility", "electric", "gas", "water"): ("6400", "rent_utilities"),
        }
        for keywords, (acct, cat) in keyword_map.items():
            if isinstance(keywords, str):
                keywords = (keywords,)
            if any(kw in text for kw in keywords):
                account_code = acct
                expense_category = cat
                confidence = 0.5
                reasoning = f"Matched description keyword in '{description or counterparty}'"
                break
    
    # Default to miscellaneous
    if not account_code:
        account_code = "6999"
        expense_category = "miscellaneous"
        confidence = 0.2
        reasoning = "No matching rules found - defaulting to miscellaneous"
    
    # Find matching chart_of_accounts entry
    for entry in coa_entries:
        if entry["account_number"] == account_code:
            break
    
    return AISuggestion(
        transaction_id=txn["id"],
        suggested_account_number=account_code,
        suggested_expense_category=expense_category,
        confidence=confidence,
        reasoning=reasoning,
    )


@router.get("/chart-of-accounts")
async def get_chart_of_accounts(
    account_type: Optional[str] = None,
):
    """Get chart of accounts entries, optionally filtered by account type."""
    try:
        import asyncio
        from ...core.supabase_client import get_supabase_client
        client = get_supabase_client()
        if not client:
            raise RuntimeError("Supabase client not configured")
        
        def _fetch_coa():
            query = client.table("chart_of_accounts").select("*")
            
            if account_type:
                query = query.eq("account_type", account_type)
            
            return query.order("account_number").execute()
        
        result = await asyncio.to_thread(_fetch_coa)
        
        return result.data or []
    
    except Exception as e:
        logger.error(f"Error getting chart of accounts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
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
                logger.warning(f"Failed to get failed events count for {source['id']}: {e}")
            
            # Get uncategorized transactions count
            uncategorized_count = 0
            entity_id_for_source = source.get("entity_id")
            if entity_id_for_source:
                try:
                    source_provider = source["provider"]
                    # Count transactions without account_code in metadata
                    result = await asyncio.to_thread(
                        lambda eid=entity_id_for_source, sp=source_provider: sync_service.client.table("financial_transactions")
                        .select("id, metadata", count="exact")
                        .eq("entity_id", eid)
                        .eq("source", sp)
                        .in_("transaction_type", ["payment", "fee", "other"])
                        .execute()
                    )
                    # Filter client-side for missing account_code in metadata
                    if result.data:
                        uncategorized_count = sum(
                            1 for row in result.data
                            if not (row.get("metadata") or {}).get("account_code")
                        )
                except Exception as e:
                    logger.warning(f"Failed to get uncategorized count: {e}")
            
            # Extract entity name from joined data
            entity_name = None
            if source.get("entities"):
                entity_name = source["entities"].get("name")
            
            summaries.append(IntegrationSummary(
                id=source["id"],
                provider=source["provider"],
                display_name=source.get("display_name"),
                external_account_id=source["external_account_id"],
                entity_id=entity_id_for_source,
                sync_status=source.get("sync_status", "unknown"),
                sync_error=source.get("sync_error"),
                last_synced_at=source.get("last_synced_at"),
                entity_name=entity_name,
                stats=stats,
                api_key_status=source.get("api_key_status", "pending"),
                api_key_last_validated_at=source.get("api_key_last_validated_at"),
                api_key_error=source.get("api_key_error"),
                failed_events_count=failed_count,
                uncategorized_transactions_count=uncategorized_count,
            ))
        
        return summaries
    
    except Exception as e:
        logger.error(f"Error getting integrations summary: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
