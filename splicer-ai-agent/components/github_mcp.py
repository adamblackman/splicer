"""
GitHub MCP Client - Connects to GitHub's Remote MCP Server via HTTP transport.
Flow: Agent → MultiServerMCPClient → GitHub Remote MCP Server → GitHub API

Uses HTTP transport for serverless compatibility (Cloud Run, Lambda, etc.).
The Remote MCP Server is hosted by GitHub at api.githubcopilot.com.

Token is passed per-request via LangGraph runtime config:
    config["configurable"]["github_token"]
"""

import os
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, List
import anyio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_core.tools import BaseTool

# GitHub Remote MCP Server endpoints
GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
# For GitHub Enterprise Cloud with data residency (ghe.com):
# https://copilot-api.{subdomain}.ghe.com/mcp


# Env var used for local dev when config does not contain github_token (e.g. LangGraph dev)
GITHUB_TOKEN_ENV = "GITHUB_TOKEN"


def get_token_from_config(config: Optional[Dict[str, Any]]) -> str:
    """
    Extract GitHub token from LangGraph runtime config.
    
    Token is expected at config["configurable"]["github_token"], injected by the
    Supabase edge function in production.
    
    For local development (e.g. LangGraph dev), when the token is not in config,
    falls back to the GITHUB_TOKEN environment variable so you can use a
    personal access token.
    
    Args:
        config: LangGraph runtime config dict
        
    Returns:
        GitHub installation access token (or PAT when using GITHUB_TOKEN locally)
        
    Raises:
        ValueError: If token is not in config and GITHUB_TOKEN is not set
    """
    if config is not None:
        configurable = config.get("configurable", {})
        token = configurable.get("github_token")
        if token:
            return token

    # Local dev fallback: use PAT from env (e.g. for langgraph dev)
    token = os.getenv(GITHUB_TOKEN_ENV)
    if token:
        return token

    raise ValueError(
        "github_token not found in config['configurable']. "
        "In production, the Supabase edge function must inject the GitHub "
        "installation access token. For local testing (e.g. langgraph dev), set "
        f"the {GITHUB_TOKEN_ENV} environment variable to your personal access token."
    )


def get_github_host() -> Optional[str]:
    """Get GITHUB_HOST for Enterprise. Returns None for standard github.com."""
    return os.getenv("GITHUB_HOST")


def _get_mcp_url() -> str:
    """
    Get the GitHub Remote MCP Server URL.
    
    For standard GitHub.com: https://api.githubcopilot.com/mcp/
    For GitHub Enterprise Cloud (ghe.com): https://copilot-api.{subdomain}.ghe.com/mcp
    
    Note: GitHub Enterprise Server does not support the remote MCP server.
    """
    host = get_github_host()
    
    if host is None:
        return GITHUB_MCP_URL
    
    # Handle GitHub Enterprise Cloud with data residency (*.ghe.com)
    if host.endswith(".ghe.com"):
        # Extract subdomain: https://octocorp.ghe.com -> octocorp
        subdomain = host.replace("https://", "").replace("http://", "").split(".")[0]
        return f"https://copilot-api.{subdomain}.ghe.com/mcp"
    
    # GitHub Enterprise Server does not support remote MCP server
    raise ValueError(
        f"GitHub Enterprise Server ({host}) does not support the Remote MCP Server.\n"
        "Options:\n"
        "  1. Use standard GitHub.com (unset GITHUB_HOST)\n"
        "  2. Use GitHub Enterprise Cloud with data residency (*.ghe.com)\n"
        "  3. For GHES, deploy github-mcp-server locally with stdio transport"
    )


def create_github_mcp_client(token: str) -> MultiServerMCPClient:
    """
    Create GitHub MCP client using HTTP transport to GitHub's Remote MCP Server.
    
    Uses HTTP transport for serverless compatibility - no subprocess required.
    Authentication via Bearer token in Authorization header.
    
    Args:
        token: GitHub installation access token (from runtime config)
        
    Returns:
        Configured MultiServerMCPClient instance
    """
    url = _get_mcp_url()
    
    client = MultiServerMCPClient(
        {
            "github": {
                "transport": "http",
                "url": url,
                "headers": {
                    "Authorization": f"Bearer {token}",
                },
            }
        }
    )
    
    return client

# GitHub MCP Tool Sets for Each Agent
# Source Agent: Explore source repo and extract files
SOURCE_AGENT_TOOLS = {
    "get_file_contents",      # Read file content
    "search_code",            # Search code patterns (also useful for finding files)
    "search_repositories",    # Repo metadata
}

# Target Agent: Explore target repo and understand structure
TARGET_AGENT_TOOLS = {
    "get_file_contents",      # Read file content
    "search_code",            # Search patterns (also useful for finding files)
    "search_repositories",    # Repo metadata
}

# Paster Agent: Paste files into target repo
PASTER_AGENT_TOOLS = {
    "push_files",             # Atomic file commits
}

# Integrator Agent: Adapt code to target environment
INTEGRATOR_AGENT_TOOLS = {
    "get_file_contents",      # Read files (required for whole-file updates)
    "search_code",            # Search patterns (find imports, usages, files)
    "push_files",             # Create/update files atomically (no SHA needed, works for single or batch)
}

# Validator Agent: Check integrated work (read-only)
VALIDATOR_AGENT_TOOLS = {
    "get_file_contents",      # Read files to verify content
    "search_code",            # Search for issues/broken imports
}

# Revisor Agent: Fix validation issues
REVISOR_AGENT_TOOLS = {
    "get_file_contents",      # Read files
    "search_code",            # Find code to fix
    "push_files",             # Create/update files (atomic, no SHA needed)
}

# Check Revisor Agent: Fix syntax errors caught by check node
CHECK_REVISOR_AGENT_TOOLS = {
    "get_file_contents",      # Read files to understand context
    "search_code",            # Search for patterns if needed
    "push_files",             # Write fixes
}

@asynccontextmanager
async def github_session(token: str):
    """
    Context manager that yields ALL GitHub MCP tools bound to a stateful session.
    
    Creates a fresh client per session with the provided token. Each agent should
    filter to only the tools it needs from the sets defined above.
    All tool calls within the session share a single persistent connection.
    
    Args:
        token: GitHub installation access token (use get_token_from_config(config))
        
    Usage:
        token = get_token_from_config(config)
        async with github_session(token) as mcp_tools:
            # Filter to agent-specific tools
            filtered = [t for t in mcp_tools if t.name in SOURCE_AGENT_TOOLS]
            agent = create_agent(model, tools=[*filtered, search, copy], ...)
    """
    import logging
    
    client = create_github_mcp_client(token)
    body_completed = False
    
    try:
        async with client.session("github") as session:
            tools: List[BaseTool] = await load_mcp_tools(session)
            yield tools
            body_completed = True
    except Exception as e:
        # Handle cleanup errors that occur after the body completed successfully
        # This includes ExceptionGroup from TaskGroup, BrokenResourceError, etc.
        # These commonly occur during HTTP transport session teardown
        if not body_completed:
            raise
        
        # Log cleanup errors but don't fail the operation
        error_name = type(e).__name__
        if isinstance(e, ExceptionGroup):
            logging.debug(f"MCP session cleanup ExceptionGroup (ignored): {e}")
        elif isinstance(e, (anyio.BrokenResourceError, anyio.ClosedResourceError)):
            logging.debug(f"MCP session cleanup {error_name} (ignored)")
        else:
            logging.warning(f"MCP session cleanup error (ignored): {error_name}: {e}")
