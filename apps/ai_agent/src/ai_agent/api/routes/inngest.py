"""Inngest endpoints for ThreadWise AI Agent."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException

router = APIRouter()
logger = logging.getLogger(__name__)


def get_services():
    """Get service instances (lazy import to avoid circular deps)."""
    try:
        from ...integrations.inngest import (
            get_inngest_client,
            validate_inngest_config,
            inngest_functions,
            send_custom_event,
        )
        inngest_client = get_inngest_client()
    except ImportError:
        inngest_client = None
        validate_inngest_config = None
        inngest_functions = []
        send_custom_event = None
    
    return inngest_client, validate_inngest_config, inngest_functions, send_custom_event


@router.get("/health")
async def inngest_health():
    """Check Inngest service health and configuration."""
    inngest_client, validate_inngest_config, inngest_functions, _ = get_services()
    
    if not inngest_client or not validate_inngest_config:
        return {"status": "disabled", "message": "Inngest service not available"}
    
    try:
        config_status = validate_inngest_config()
        return {
            "status": "enabled",
            "config": config_status,
            "functions_registered": len(inngest_functions),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/trigger-cleanup")
async def trigger_cleanup():
    """Manually trigger the cleanup function for testing."""
    inngest_client, _, _, send_custom_event = get_services()
    
    if not inngest_client:
        raise HTTPException(status_code=503, detail="Inngest service not available")
    
    try:
        if not send_custom_event:
            raise HTTPException(status_code=503, detail="Inngest events not available")
        
        success = await send_custom_event(
            event_name="manual/cleanup.triggered",
            data={"triggered_by": "manual_api_call"}
        )
        
        return {
            "success": success,
            "message": "Cleanup event triggered" if success else "Failed to trigger cleanup event",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Error triggering cleanup: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
