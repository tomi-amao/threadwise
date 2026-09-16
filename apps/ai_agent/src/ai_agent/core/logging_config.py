"""Logging configuration for ThreadWise AI Agent.

This module configures structlog to work properly with the langgraph library
and prevent warning messages about format_exc_info conflicts.
"""

import logging
import structlog


def configure_logging():
    """Configure structlog to prevent format_exc_info conflicts.
    
    This must be called before langgraph or inngest imports to prevent
    the warning: "Remove format_exc_info from your processor chain if 
    you want pretty exceptions."
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            # DO NOT include format_exc_info here - ConsoleRenderer handles exceptions
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


# Configure logging on module import (before langgraph/inngest)
configure_logging()
