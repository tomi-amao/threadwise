"""Configuration and settings for ThreadWise AI Agent.

Provides LLM initialization and application settings.
"""

import os
from typing import Optional

from dotenv import load_dotenv
from langchain.agents import AgentState
from langchain.chat_models import init_chat_model
from langchain_openai import ChatOpenAI
from pydantic import BaseModel
from pydantic_settings import BaseSettings

load_dotenv(dotenv_path=".env", override=True)

# =============================================================================
# PYDANTIC SETTINGS
# =============================================================================


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Database
    database_url: Optional[str] = None

    # LLM Configuration
    local_llm_base_url: str = "http://localhost:1234/v1"
    default_model: str = "qwen/qwen3-vl-4b"
    default_chat_model: str = "google_genai:gemini-2.5-flash-lite"

    # LangGraph
    langgraph_base_url: str = "http://localhost:2024"

    # Inngest
    inngest_app_id: str = "threadwise-ai-agent"
    inngest_event_key: Optional[str] = None
    inngest_signing_key: Optional[str] = None

    # API Keys (optional - loaded from environment)
    brave_search_api_key: Optional[str] = None
    langsmith_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    pinecone_api_key: Optional[str] = None

    # Supabase
    supabase_url: Optional[str] = None
    supabase_key: Optional[str] = None
    supabase_anon_key: Optional[str] = None
    supabase_access_token: Optional[str] = None  # PAT for MCP auth

    # Development settings
    inngest_dev: Optional[str] = None

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # Ignore extra environment variables


# Global settings instance
settings = Settings()


# =============================================================================
# STATE SCHEMAS
# =============================================================================


class CustomState(AgentState):
    """Custom agent state with user name."""

    user_name: str


class CustomContext(BaseModel):
    """Context for agent runtime."""

    user_id: str


# =============================================================================
# LLM INITIALIZATION
# =============================================================================


def get_local_llm(model_name: str = "local-model") -> ChatOpenAI:
    """Get local LLM instance following AI Sandbox patterns.

    Args:
        model_name: Name of the model to use (default: local-model)

    Returns:
        ChatOpenAI instance configured for local LLM server
    """
    return ChatOpenAI(
        model=model_name,
        base_url=settings.local_llm_base_url,
        # Use host.docker.internal if running in Docker:
        # base_url="http://host.docker.internal:1234/v1",
        api_key="not-needed",
        temperature=0.7,
        streaming=True,
    )


def get_chat_model(model: str = "google_genai:gemini-2.5-flash-lite"):
    """Get LLM instance based on model name using LangChain's init_chat_model.

    Args:
        model: Model identifier string (e.g., "google_genai:gemini-2.5-flash-lite")

    Returns:
        Initialized chat model
    """
    llm = init_chat_model(model)
    return llm
