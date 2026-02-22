"""Inngest integration for ThreadWise AI Agent.

Provides background processing and workflow automation using Inngest.
"""

from .config import get_client, validate_config, client
from .functions import FUNCTIONS, process_chat_message, process_document_embedding, cleanup_old_threads
from .events import (
    send_chat_message_event,
    send_document_embedding_event,
    send_custom_event,
    send_squarespace_sync_event,
    send_revolut_sync_event,
    send_paypal_sync_event,
)
from .sync_functions import (
    squarespace_sync_all,
    squarespace_sync_endpoint,
    squarespace_sync_single_endpoint,
    SYNC_FUNCTIONS,
)
from .revolut_sync_functions import REVOLUT_SYNC_FUNCTIONS
from .paypal_sync_functions import PAYPAL_SYNC_FUNCTIONS

# Import normalization functions and triggers
from ...normalization.inngest_functions import (
    normalize_raw_event,
    normalize_batch,
    normalize_source,
    normalize_after_sync,
    normalize_after_revolut_sync,
    normalize_after_paypal_sync,
    reprocess_failed_events,
    reprocess_stuck_processing_events,
    reprocess_failed_manual,
    trigger_normalization,
    trigger_batch_normalization,
    trigger_source_normalization,
    trigger_reprocess_failed,
    NORMALIZATION_FUNCTIONS,
)

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
    # Sync functions
    "squarespace_sync_all",
    "squarespace_sync_endpoint",
    "squarespace_sync_single_endpoint",
    "SYNC_FUNCTIONS",
    "REVOLUT_SYNC_FUNCTIONS",
    "PAYPAL_SYNC_FUNCTIONS",
    # Normalization functions
    "normalize_raw_event",
    "normalize_batch",
    "normalize_source",
    "normalize_after_sync",
    "normalize_after_revolut_sync",
    "normalize_after_paypal_sync",
    "reprocess_failed_events",
    "reprocess_stuck_processing_events",
    "reprocess_failed_manual",
    "trigger_normalization",
    "trigger_batch_normalization",
    "trigger_source_normalization",
    "trigger_reprocess_failed",
    "NORMALIZATION_FUNCTIONS",
    # Events
    "send_chat_message_event",
    "send_document_embedding_event",
    "send_custom_event",
    "send_squarespace_sync_event",
    "send_revolut_sync_event",
    "send_paypal_sync_event",
]
