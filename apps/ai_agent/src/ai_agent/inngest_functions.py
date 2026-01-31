"""Inngest functions for ThreadWise AI Agent background processing."""

import logging
from typing import Dict, Any, Optional
from datetime import datetime

import inngest
from .inngest_config import get_client

logger = logging.getLogger(__name__)

# Get the Inngest client
inngest_client = get_client()


@inngest_client.create_function(
    fn_id="process_chat_message",
    trigger=inngest.TriggerEvent(event="chat/message.received"),
)
async def process_chat_message(ctx: inngest.Context, step) -> Dict[str, Any]:
    """Process chat messages asynchronously for analytics or background tasks."""
    try:
        event_data = ctx.event.data
        message_content = event_data.get("content", "")
        thread_id = event_data.get("thread_id")
        user_id = event_data.get("user_id")
        
        ctx.logger.info(f"Processing chat message for thread {thread_id}")
        
        # Step 1: Log message for analytics
        await step.run(
            "log-message-analytics",
            lambda: _log_message_analytics(message_content, thread_id, user_id)
        )
        
        # Step 2: Extract entities or keywords (placeholder for future ML processing)
        entities = await step.run(
            "extract-entities", 
            lambda: _extract_message_entities(message_content)
        )
        
        # Step 3: Update user engagement metrics (placeholder)
        await step.run(
            "update-engagement",
            lambda: _update_user_engagement(user_id, thread_id)
        )
        
        return {
            "status": "completed",
            "thread_id": thread_id,
            "entities_extracted": len(entities) if entities else 0,
            "processed_at": datetime.now().isoformat()
        }
        
    except Exception as e:
        ctx.logger.error(f"Error processing chat message: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="process_document_embedding",
    trigger=inngest.TriggerEvent(event="documents/embedding.completed"),
)
async def process_document_embedding(ctx: inngest.Context, step) -> Dict[str, Any]:
    """Process completed document embeddings for indexing and categorization."""
    try:
        event_data = ctx.event.data
        document_id = event_data.get("document_id")
        filename = event_data.get("filename")
        entity_id = event_data.get("entity_id")
        chunks_count = event_data.get("chunks", 0)
        
        ctx.logger.info(f"Processing embedding completion for document {document_id}")
        
        # Step 1: Update document index
        await step.run(
            "update-document-index",
            lambda: _update_document_index(document_id, filename, entity_id, chunks_count)
        )
        
        # Step 2: Trigger document categorization if needed
        category = await step.run(
            "categorize-document",
            lambda: _categorize_document(filename, entity_id)
        )
        
        # Step 3: Send notification if this was a large document
        if chunks_count > 50:  # Arbitrary threshold for "large" documents
            await step.run(
                "notify-large-document",
                lambda: _notify_large_document_processed(document_id, filename, chunks_count)
            )
        
        return {
            "status": "completed",
            "document_id": document_id,
            "category": category,
            "chunks_processed": chunks_count,
            "processed_at": datetime.now().isoformat()
        }
        
    except Exception as e:
        ctx.logger.error(f"Error processing document embedding: {str(e)}")
        raise


@inngest_client.create_function(
    fn_id="cleanup_old_threads",
    trigger=inngest.TriggerCron(cron="0 2 * * *"),  # Daily at 2 AM
)
async def cleanup_old_threads(ctx: inngest.Context, step) -> Dict[str, Any]:
    """Clean up old chat threads and temporary data."""
    try:
        ctx.logger.info("Starting daily cleanup of old threads")
        
        # Step 1: Identify old threads (older than 30 days)
        old_threads = await step.run(
            "identify-old-threads",
            lambda: _identify_old_threads(days_old=30)
        )
        
        # Step 2: Archive threads before deletion
        archived_count = 0
        if old_threads:
            archived_count = await step.run(
                "archive-old-threads",
                lambda: _archive_threads(old_threads)
            )
        
        # Step 3: Clean up temporary files
        temp_files_cleaned = await step.run(
            "cleanup-temp-files",
            lambda: _cleanup_temporary_files()
        )
        
        return {
            "status": "completed",
            "threads_identified": len(old_threads) if old_threads else 0,
            "threads_archived": archived_count,
            "temp_files_cleaned": temp_files_cleaned,
            "processed_at": datetime.now().isoformat()
        }
        
    except Exception as e:
        ctx.logger.error(f"Error in cleanup job: {str(e)}")
        raise


# Helper functions (these would integrate with your actual services)

async def _log_message_analytics(content: str, thread_id: Optional[str], user_id: Optional[str]) -> bool:
    """Log message for analytics purposes."""
    # Placeholder - integrate with your analytics service
    logger.info(f"Analytics: Message logged for thread {thread_id}")
    return True


async def _extract_message_entities(content: str) -> list:
    """Extract entities from message content."""
    # Placeholder - integrate with NLP service or LLM for entity extraction
    logger.info("Entities: Extraction completed")
    return []


async def _update_user_engagement(user_id: Optional[str], thread_id: Optional[str]) -> bool:
    """Update user engagement metrics."""
    # Placeholder - integrate with your user analytics
    logger.info(f"Engagement: Updated for user {user_id}")
    return True


async def _update_document_index(document_id: str, filename: str, entity_id: Optional[str], chunks: int) -> bool:
    """Update document index after embedding completion."""
    # Placeholder - integrate with your document management system
    logger.info(f"Index: Updated for document {document_id} with {chunks} chunks")
    return True


async def _categorize_document(filename: str, entity_id: Optional[str]) -> str:
    """Categorize document based on filename and content."""
    # Placeholder - integrate with your categorization logic
    if "invoice" in filename.lower():
        return "invoice"
    elif "contract" in filename.lower():
        return "contract"
    return "general"


async def _notify_large_document_processed(document_id: str, filename: str, chunks: int) -> bool:
    """Send notification for large document processing completion."""
    # Placeholder - integrate with your notification service
    logger.info(f"Notification: Large document {filename} processed ({chunks} chunks)")
    return True


async def _identify_old_threads(days_old: int) -> list:
    """Identify threads older than specified days."""
    # Placeholder - integrate with your database
    logger.info(f"Cleanup: Identified threads older than {days_old} days")
    return []


async def _archive_threads(thread_ids: list) -> int:
    """Archive old threads."""
    # Placeholder - integrate with your archival system
    logger.info(f"Archive: Archived {len(thread_ids)} threads")
    return len(thread_ids)


async def _cleanup_temporary_files() -> int:
    """Clean up temporary files."""
    # Placeholder - integrate with your file management
    logger.info("Cleanup: Temporary files cleaned")
    return 0


# Export all functions for registration
FUNCTIONS = [
    process_chat_message,
    process_document_embedding, 
    cleanup_old_threads,
]