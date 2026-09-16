"""MCP Client Service for ThreadWise AI Agent.

Provides integration with external MCP servers (e.g., Supabase) as an alternative
to the local SQLDatabaseToolkit for database access. Uses langchain-mcp-adapters
to connect to MCP servers and load their tools for use in the analytics agent.

Architecture:
    MultiServerMCPClient → connects to MCP server via streamable_http
    → loads tools via get_tools()
    → tools are passed to create_agent() in place of sql_tools

Supported MCP Servers:
    - Supabase MCP: https://mcp.supabase.com/mcp (project-scoped, read-only recommended)
"""

import logging
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_core.tools import BaseTool

from ..core.config import settings

logger = logging.getLogger(__name__)


# =============================================================================
# MCP SERVER CONFIGURATIONS
# =============================================================================


def get_supabase_mcp_config() -> dict[str, Any]:
    """Build the Supabase MCP server configuration.
    
    Uses project-scoped mode with database feature group enabled.
    Authentication via Supabase service key or personal access token.
    
    Returns:
        Configuration dict for MultiServerMCPClient
    
    Raises:
        ValueError: If required Supabase settings are missing
    """
    if not settings.supabase_url:
        raise ValueError(
            "SUPABASE_URL is required for Supabase MCP integration. "
            "Set it in your .env file."
        )
    
    # Extract project ref from Supabase URL
    # Format: https://<project-ref>.supabase.co
    project_ref = _extract_project_ref(settings.supabase_url)
    logger.debug(f"Extracted project_ref '{project_ref}' from SUPABASE_URL: {settings.supabase_url}")
    
    if not project_ref:
        raise ValueError(
            "Could not extract project_ref from SUPABASE_URL. "
            "Expected format: https://<project-ref>.supabase.co"
        )
    
    # Build the MCP server URL with project scoping and database features
    mcp_url = (
        f"https://mcp.supabase.com/mcp"
        f"?project_ref={project_ref}"
        f"&features=database,docs"
        f"&read_only=true"
    )
    
    # Build headers for authentication
    headers: dict[str, str] = {}
    auth_source = None
    
    # Use Supabase access token (PAT) for auth if available
    if settings.supabase_access_token:
        headers["Authorization"] = f"Bearer {settings.supabase_access_token}"
        auth_source = "SUPABASE_ACCESS_TOKEN"
    elif settings.supabase_key:
        # Fallback to service key
        headers["Authorization"] = f"Bearer {settings.supabase_key}"
        auth_source = "SUPABASE_KEY"
    else:
        logger.warning("No Supabase authentication found - trying unauthenticated connection")
        auth_source = "none"
    
    config = {
        "supabase": {
            "transport": "streamable_http",
            "url": mcp_url,
            "headers": headers,
        }
    }
    
    logger.info(f"Supabase MCP config built for project: {project_ref}")
    logger.debug(f"MCP URL: {mcp_url}")
    logger.debug(f"Auth source: {auth_source}")
    logger.debug(f"Headers count: {len(headers)}")
    
    return config


def _extract_project_ref(supabase_url: str) -> str | None:
    """Extract the project reference ID from a Supabase URL.
    
    Args:
        supabase_url: Full Supabase project URL
        
    Returns:
        Project reference string or None if extraction fails
    """
    try:
        # Handle both https://xxx.supabase.co and pooler URLs
        from urllib.parse import urlparse
        parsed = urlparse(supabase_url)
        hostname = parsed.hostname or ""
        
        # Standard format: <ref>.supabase.co
        if ".supabase.co" in hostname:
            return hostname.split(".")[0]
        
        # Pooler format: postgres.<ref>@aws-xxx.pooler.supabase.com
        # This won't have a direct ref in hostname
        
        return None
    except Exception as e:
        logger.error(f"Failed to extract project ref: {e}")
        return None


# =============================================================================
# MCP TOOL LOADING
# =============================================================================


# Available MCP data source configurations
MCP_DATA_SOURCES = {
    "supabase_mcp": {
        "name": "Supabase MCP",
        "description": "Connect to Supabase via Model Context Protocol for database queries, migrations, and docs",
        "config_builder": get_supabase_mcp_config,
    },
}


async def load_mcp_tools(data_source: str) -> list[BaseTool]:
    """Load tools from an MCP server based on the data source identifier.
    
    Creates a MultiServerMCPClient, connects to the specified MCP server,
    and returns the available tools for use in the analytics agent.
    
    Args:
        data_source: Identifier for the MCP data source (e.g., "supabase_mcp")
        
    Returns:
        List of LangChain-compatible tools from the MCP server
        
    Raises:
        ValueError: If the data source is not recognized
        ConnectionError: If the MCP server is unreachable
    """
    if data_source not in MCP_DATA_SOURCES:
        raise ValueError(
            f"Unknown MCP data source: {data_source}. "
            f"Available: {list(MCP_DATA_SOURCES.keys())}"
        )
    
    source_config = MCP_DATA_SOURCES[data_source]
    config_builder = source_config["config_builder"]
    
    logger.info(f"Loading MCP tools from: {source_config['name']}")
    
    try:
        # Build the server configuration
        server_config = config_builder()
        logger.debug(f"MCP server config: {server_config}")
        
        # Create the MCP client and load tools
        # MultiServerMCPClient is stateless by default - each tool call
        # creates a fresh session, executes, and cleans up
        logger.debug("Creating MultiServerMCPClient...")
        client = MultiServerMCPClient(server_config)
        
        logger.debug("Calling client.get_tools()...")
        tools = await client.get_tools()
        
        tool_names = [t.name for t in tools]
        logger.info(f"Loaded {len(tools)} MCP tools: {tool_names}")
        
        return tools
        
    except Exception as e:
        # Log the full exception details for better debugging
        import traceback
        logger.error(f"Failed to load MCP tools from {data_source}:")
        logger.error(f"Exception type: {type(e).__name__}")
        logger.error(f"Exception message: {str(e)}")
        logger.error(f"Full traceback:\n{traceback.format_exc()}")
        
        # Try to extract more specific error info if available
        error_msg = str(e)
        if hasattr(e, '__cause__') and e.__cause__:
            error_msg += f" (caused by: {e.__cause__})"
        
        raise ConnectionError(
            f"Could not connect to {source_config['name']} MCP server: {error_msg}"
        ) from e


def get_available_data_sources() -> list[dict[str, str]]:
    """Get list of available data sources for the frontend.
    
    Returns a list of data source options including the default SQL toolkit
    and any configured MCP servers.
    
    Returns:
        List of dicts with id, name, and description for each source
    """
    sources = [
        {
            "id": "sql_toolkit",
            "name": "Direct SQL",
            "description": "Connect directly to the database via SQLDatabaseToolkit",
            "type": "builtin",
            "status": "available" if settings.database_url else "unavailable",
        },
    ]
    
    # Add MCP data sources
    for source_id, source_info in MCP_DATA_SOURCES.items():
        # Check if the required config is available
        status = "available"
        try:
            source_info["config_builder"]()
        except (ValueError, Exception):
            status = "unconfigured"
        
        sources.append({
            "id": source_id,
            "name": source_info["name"],
            "description": source_info["description"],
            "type": "mcp",
            "status": status,
        })
    
    return sources
