# TODO: Add repo_loader indexing for target repo
"""
Splicer Setup Node - Creates splice branch and prepares environment.
Future: Add repo_loader for indexing target repo into vector store.
"""

from agent.state import AgentState
from components.github_mcp import github_session, get_token_from_config


async def splicer_setup(state: AgentState, config) -> dict:
    """Create splice branch in target repo from default branch if it doesn't exist."""
    target_repo = state["target_repo"]
    branch = state.get("branch", "splice")
    
    if "/" not in target_repo:
        raise ValueError(f"Invalid target_repo format: {target_repo}")
    
    owner, repo = target_repo.split("/", 1)
    
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        create_branch_tool = next((t for t in mcp_tools if t.name == "create_branch"), None)
        if not create_branch_tool:
            raise ValueError("create_branch tool not available from GitHub MCP")
        
        try:
            await create_branch_tool.ainvoke({
                "owner": owner,
                "repo": repo,
                "branch": branch
            })
        except Exception as e:
            error_msg = str(e).lower()
            if "already exists" in error_msg or "reference already exists" in error_msg:
                pass
            else:
                raise
        
    return {}
