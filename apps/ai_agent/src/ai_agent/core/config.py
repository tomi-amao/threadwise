"""Configuration and settings for ThreadWise AI Agent.

Provides LLM initialization and application settings.
"""

import os
from typing import Optional

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import AgentState
from langchain.chat_models import init_chat_model
from pydantic import BaseModel
from pydantic_settings import BaseSettings

# override=False: a variable already set in the real environment wins over .env
load_dotenv(dotenv_path=".env", override=False)

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
    # The chat agent (agents/chat_agent.py): provider-prefixed ids for init_chat_model.
    # The main loop, the model it falls back to, and a small one for summaries.
    # Measured on 2026-10-22 (docs/evals.md): the 3.5 models took 18-22s for a one-tool question
    # and 20-34s for the follow-up step; the 2.5 models 5-9s and about 1s. Different models
    # have separate free-tier quotas, so the fallback is the other family.
    agent_model: str = "google_genai:gemini-2.5-flash"
    agent_fallback_model: Optional[str] = "google_genai:gemini-3.5-flash"
    agent_small_model: str = "google_genai:gemini-2.5-flash-lite"

    # Limits on the assistant (see docs/operations.md)
    assistant_runs_per_window: int = 30
    assistant_rate_window_s: int = 600
    assistant_turn_token_cap: int = 150_000
    # Keyed hash for ids in traces and metadata (core/tracing.py). Set it in production.
    trace_hash_salt: Optional[str] = None

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
    # Shared secret for machine callers of internal-only routes (X-Internal-Key). Unset = closed.
    internal_api_key: Optional[str] = None
    # Origins the browser app is served from (CORS). Comma-separated in the environment.
    cors_allow_origins: str = "http://localhost:5174,http://localhost:5180"
    # Only for legacy projects that still sign user tokens with a shared HS256 secret.
    supabase_jwt_secret: Optional[str] = None
    
    # Development settings
    inngest_dev: Optional[str] = None

    # Zoho Calendar OAuth — ThreadWise's own registered OAuth client (app-wide,
    # unlike Shopify/PayPal where each user brings their own custom-app
    # credentials, so those never appear here). Per-entity refresh tokens are
    # still stored per-connection via Vault, same as every other provider.
    zoho_client_id: str = ""
    zoho_client_secret: str = ""
    zoho_redirect_uri: str = ""
    zoho_accounts_domain: str = "accounts.zoho.com"

    # Where the browser is redirected after an OAuth callback finishes —
    # this backend has no other reason to know the frontend's own origin
    # (CORS is wide open, not origin-specific), but a server-issued redirect
    # needs an absolute URL, not a path relative to this backend's own host.
    frontend_url: str = "http://localhost:5174"

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
