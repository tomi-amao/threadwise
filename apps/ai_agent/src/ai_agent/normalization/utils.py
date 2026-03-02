"""Utility functions for the normalization module.

Contains type-safe helpers for working with Supabase responses.
"""

from typing import Any, Dict, List, Optional, cast
from uuid import UUID


def extract_id(result: Any, field: str = "id") -> UUID:
    """Extract UUID from Supabase response data.
    
    Supabase client returns complex types. This helper safely
    extracts the ID from upsert/query results.
    
    Args:
        result: The APIResponse from Supabase execute()
        field: The field name containing the UUID (default: "id")
        
    Returns:
        UUID from the first row
        
    Raises:
        ValueError: If no data returned or unexpected format
    """
    data = result.data
    if not data or not isinstance(data, list) or len(data) == 0:
        raise ValueError("No data returned from query")
    row = data[0]
    if not isinstance(row, dict):
        raise ValueError("Unexpected row type from query")
    return UUID(str(row[field]))


def extract_row(result: Any) -> Optional[Dict[str, Any]]:
    """Extract first row from Supabase response as a dict.
    
    Args:
        result: The APIResponse from Supabase execute()
        
    Returns:
        Dict of the first row or None if no data
    """
    data = result.data
    if not data or not isinstance(data, list) or len(data) == 0:
        return None
    row = data[0]
    if not isinstance(row, dict):
        return None
    return cast(Dict[str, Any], row)


def extract_rows(result: Any) -> List[Dict[str, Any]]:
    """Extract all rows from Supabase response as list of dicts.
    
    Args:
        result: The APIResponse from Supabase execute()
        
    Returns:
        List of dicts (empty list if no data)
    """
    data = result.data
    if not data or not isinstance(data, list):
        return []
    return cast(List[Dict[str, Any]], data)
