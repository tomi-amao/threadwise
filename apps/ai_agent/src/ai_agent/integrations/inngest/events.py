"""Inngest event helpers for triggering background functions."""

import logging
from typing import Dict, Any, Optional
from datetime import datetime

from .config import get_client

logger = logging.getLogger(__name__)


async def send_chat_message_event(
    content: str,
    thread_id: Optional[str] = None,
    user_id: Optional[str] = None,
    assistant_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> bool:
    """Send a chat message event to trigger background processing.
    
    Args:
        content: The message content
        thread_id: Optional thread identifier
        user_id: Optional user identifier
        assistant_id: Optional assistant identifier
        metadata: Optional additional metadata
        
    Returns:
        True if event was sent successfully, False otherwise
    """
    try:
        client = get_client()
        
        event_data = {
            "content": content,
            "thread_id": thread_id,
            "user_id": user_id,
            "assistant_id": assistant_id,
            "timestamp": datetime.now().isoformat(),
            "metadata": metadata or {}
        }
        
        await client.send_async({
            "name": "chat/message.received",
            "data": event_data
        })
        
        logger.info(f"Sent chat message event for thread {thread_id}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send chat message event: {str(e)}")
        return False


async def send_document_embedding_event(
    document_id: str,
    filename: str,
    entity_id: Optional[str] = None,
    chunks: int = 0,
    file_type: Optional[str] = None,
    success: bool = True,
    error: Optional[str] = None
) -> bool:
    """Send a document embedding completion event.
    
    Args:
        document_id: The document identifier
        filename: Name of the embedded file
        entity_id: Optional entity/tenant identifier
        chunks: Number of chunks created
        file_type: MIME type of the file
        success: Whether embedding was successful
        error: Error message if failed
        
    Returns:
        True if event was sent successfully, False otherwise
    """
    try:
        client = get_client()
        
        event_data = {
            "document_id": document_id,
            "filename": filename,
            "entity_id": entity_id,
            "chunks": chunks,
            "file_type": file_type,
            "success": success,
            "error": error,
            "timestamp": datetime.now().isoformat()
        }
        
        await client.send_async({
            "name": "documents/embedding.completed",
            "data": event_data
        })
        
        logger.info(f"Sent document embedding event for {document_id}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send document embedding event: {str(e)}")
        return False


async def send_custom_event(
    event_name: str,
    data: Dict[str, Any],
    user_id: Optional[str] = None
) -> bool:
    """Send a custom event to Inngest.
    
    Args:
        event_name: Name of the event (e.g., "custom/my-event")
        data: Event payload data
        user_id: Optional user identifier
        
    Returns:
        True if event was sent successfully, False otherwise
    """
    try:
        client = get_client()
        
        event_payload = {
            "name": event_name,
            "data": {
                **data,
                "timestamp": datetime.now().isoformat(),
                "user_id": user_id
            }
        }
        
        if user_id:
            event_payload["user"] = {"id": user_id}
        
        await client.send_async(event_payload)
        
        logger.info(f"Sent custom event: {event_name}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send custom event {event_name}: {str(e)}")
        return False
