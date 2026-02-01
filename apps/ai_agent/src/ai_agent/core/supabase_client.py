"""Supabase client utilities for ThreadWise AI Agent.

Provides async Supabase client for database operations.
"""

import logging
from functools import lru_cache
from typing import Optional

from supabase import create_client, Client

from .config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_supabase_client() -> Optional[Client]:
    """Get the Supabase client singleton.
    
    Returns:
        Supabase client instance or None if not configured
    """
    if not settings.supabase_url or not settings.supabase_key:
        logger.warning("Supabase URL or key not configured")
        return None
    
    try:
        client = create_client(
            supabase_url=settings.supabase_url,
            supabase_key=settings.supabase_key
        )
        logger.info("Supabase client initialized successfully")
        return client
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")
        return None


# Convenience alias
supabase = get_supabase_client()
