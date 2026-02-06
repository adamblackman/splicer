"""
Clean node - Delete .splicer/ staging directory after migration.

TODO: Add final migration summary/report.
"""

import json
import logging
from typing import Any, List
from agent.state import AgentState
from components.github_mcp import github_session, get_token_from_config

logger = logging.getLogger(__name__)


async def _list_splicer_directory(tool: Any, owner: str, repo: str, ref: str) -> List[str]:
    """List files in .splicer/ directory. Returns list of file paths."""
    try:
        result = await tool.ainvoke({
            "owner": owner, "repo": repo, "path": ".splicer", "ref": ref
        })
    except Exception as e:
        logger.debug(f"No .splicer/ directory found or error listing: {e}")
        return []
    
    files = []
    if isinstance(result, list):
        for item in result:
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    listing = json.loads(item.get("text", "[]"))
                    for f in listing:
                        if isinstance(f, dict) and f.get("type") == "file":
                            path = f.get("path", "")
                            if path:
                                files.append(path)
                except json.JSONDecodeError:
                    pass
    return files


async def _delete_splicer_file(tool: Any, owner: str, repo: str, branch: str, path: str) -> bool:
    """Delete a single file from .splicer/. Returns success status."""
    try:
        await tool.ainvoke({
            "owner": owner, "repo": repo, "branch": branch,
            "path": path, "message": f"Splicer: Remove {path}"
        })
        logger.info(f"Deleted {path}")
        return True
    except Exception as e:
        logger.warning(f"Failed to delete {path}: {e}")
        return False


async def clean_up(state: AgentState, config) -> dict:
    """Delete .splicer/ directory if it exists. Returns empty dict."""
    target_repo = state.get("target_repo", "")
    branch = state.get("branch", "splice")
    
    if "/" not in target_repo:
        return {}
    
    owner, repo = target_repo.split("/", 1)
    token = get_token_from_config(config)

    # Use a fresh session for listing to avoid ClosedResourceError (session can close after first use)
    async with github_session(token) as mcp_tools:
        get_file_contents = next((t for t in mcp_tools if t.name == "get_file_contents"), None)
        if not get_file_contents:
            return {}
        files = await _list_splicer_directory(get_file_contents, owner, repo, branch)

    if not files:
        return {}

    # Use a fresh session for deletes so we never use a tool after its session may have closed
    async with github_session(token) as mcp_tools:
        delete_file = next((t for t in mcp_tools if t.name == "delete_file"), None)
        if not delete_file:
            return {}
        for path in files:
            await _delete_splicer_file(delete_file, owner, repo, branch, path)

    return {}
