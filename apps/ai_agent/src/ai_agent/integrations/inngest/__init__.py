"""Inngest integration for ThreadWise AI Agent.

Provides background processing and workflow automation using Inngest.
"""

from .config import get_client, validate_config, client
from .functions import FUNCTIONS, process_chat_message, process_document_embedding, cleanup_old_threads
from .events import send_chat_message_event, send_document_embedding_event, send_custom_event

# Aliases for route compatibility
get_inngest_client = get_client
validate_inngest_config = validate_config
inngest_functions = FUNCTIONS

__all__ = [
    # Client
    "get_client",
    "get_inngest_client",  # Alias
    "validate_config",
    "validate_inngest_config",  # Alias
    "client",
    # Functions
    "FUNCTIONS",
    "inngest_functions",  # Alias
    "process_chat_message",
    "process_document_embedding",
    "cleanup_old_threads",
    # Events
    "send_chat_message_event",
    "send_document_embedding_event",
    "send_custom_event",
]
