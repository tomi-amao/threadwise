"""Core module for ThreadWise AI Agent.

Contains configuration, database connections, state definitions, and shared utilities.
"""

from .config import (
    CustomContext,
    CustomState,
    Settings,
    get_chat_model,
    get_local_llm,
)

__all__ = [
    "get_local_llm",
    "get_chat_model",
    "CustomState",
    "CustomContext",
    "Settings",
]
