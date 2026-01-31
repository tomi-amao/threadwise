"""Core module for ThreadWise AI Agent.

Contains configuration, database connections, state definitions, and shared utilities.
"""

from .config import (
    get_local_llm,
    get_chat_model,
    CustomState,
    CustomContext,
    Settings,
)
from .database import db, database_url
from .state import State, Context

__all__ = [
    "get_local_llm",
    "get_chat_model",
    "CustomState",
    "CustomContext",
    "Settings",
    "db",
    "database_url",
    "State",
    "Context",
]
