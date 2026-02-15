"""Chat endpoints for ThreadWise AI Agent."""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from ..schemas import (
    ChatMessage,
    ChatResponse,
    CreateAssistantRequest,
    ThreadCreateResponse,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def get_services():
    """Get service instances (lazy import to avoid circular deps)."""
    try:
        from ...services.langgraph_service import LangGraphService

        langgraph_service = LangGraphService()
    except ImportError:
        langgraph_service = None

    try:
        from ...integrations.inngest import send_chat_message_event
    except ImportError:
        send_chat_message_event = None

    return langgraph_service, send_chat_message_event


@router.get("/health")
async def chat_health():
    """Check LangGraph service health."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        return {"status": "error", "message": "LangGraph service not available"}

    try:
        health_status = await langgraph_service.health_check()
        return health_status
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("", response_model=ChatResponse)
async def send_chat_message(message: ChatMessage):
    """Send a message to the LangGraph agent."""
    langgraph_service, send_chat_message_event = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        response = await langgraph_service.send_message(
            content=message.content,
            thread_id=message.thread_id,
            attachments=message.attachments,
            assistant_id=message.assistant_id,
        )

        # Send event to Inngest for background processing (fire-and-forget)
        if send_chat_message_event:
            asyncio.create_task(
                send_chat_message_event(
                    content=message.content,
                    thread_id=response.get("thread_id"),
                    assistant_id=response.get("assistant_id"),
                )
            )

        return ChatResponse(**response)
    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/threads", response_model=ThreadCreateResponse)
async def create_chat_thread():
    """Create a new chat thread."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        response = await langgraph_service.create_thread()
        return ThreadCreateResponse(**response)
    except Exception as e:
        logger.error(f"Thread creation error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/threads/{thread_id}/messages")
async def get_thread_messages(thread_id: str):
    """Get all messages from a thread."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        messages_data = await langgraph_service.get_thread_messages(thread_id)
        return {"messages": messages_data}
    except Exception as e:
        logger.error(f"Get messages error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/threads/{thread_id}")
async def delete_chat_thread(thread_id: str):
    """Delete a chat thread."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        response = await langgraph_service.delete_thread(thread_id)
        return response
    except Exception as e:
        logger.error(f"Thread deletion error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/assistants")
async def list_assistants():
    """List all available assistants."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        response = await langgraph_service.list_assistants()
        return response
    except Exception as e:
        logger.error(f"List assistants error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/assistants")
async def create_assistant(request: CreateAssistantRequest):
    """Create a new assistant."""
    langgraph_service, _ = get_services()

    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")

    try:
        response = await langgraph_service.create_assistant(
            graph_name=request.graph_name,
            model_name=request.model_name,
            assistant_name=request.assistant_name,
            context=request.context,
        )
        return response
    except Exception as e:
        logger.error(f"Create assistant error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/data-sources")
async def list_data_sources():
    """List available data sources for analytics queries.

    Returns the available data source options including the default
    SQL toolkit and any configured MCP server integrations.
    """
    try:
        from ...services.mcp_client import get_available_data_sources

        sources = get_available_data_sources()
        return {"data_sources": sources}
    except Exception as e:
        logger.error(f"List data sources error: {str(e)}")
        return {
            "data_sources": [
                {
                    "id": "sql_toolkit",
                    "name": "Direct SQL",
                    "description": "Connect directly to the database",
                    "type": "builtin",
                    "status": "available",
                }
            ]
        }
