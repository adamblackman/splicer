from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import CheckRevisorResponse
from components.system_prompts.check_revisor_prompt import CHECK_REVISOR_PROMPT
from components.tools import dependency, handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, CHECK_REVISOR_AGENT_TOOLS


async def check_revisor_agent(state: AgentState, config) -> dict:
    """Fix syntax errors identified by the check node."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to check revisor agent tools + dependency tool
        filtered_tools = [t for t in mcp_tools if t.name in CHECK_REVISOR_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=[*filtered_tools, dependency],
            system_prompt=CHECK_REVISOR_PROMPT,
            response_format=ToolStrategy(CheckRevisorResponse),
            state_schema=AgentState,
            middleware=[
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        # Build minimal context - only what's needed to fix the errors
        check_output = state.get("check_output", {})
        source_metadata = state.get("source_metadata", {})
        
        context = f"""Target Repository: {state["target_repo"]}
        Branch: {state["branch"]}

        ## Check Output (ERRORS TO FIX)
        {check_output}

        ## Source Metadata (for dependency versions)
        {source_metadata}

        ## Changeset (files that were modified by integrator)
        {state.get("changeset", [])}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config
        )
        
        response: CheckRevisorResponse = result.get("structured_response")
        
        return {
            "fixes_applied": response.fixes_applied,
            "files_modified": response.files_modified,
        }
