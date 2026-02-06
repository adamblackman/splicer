from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import TargetResponse
from components.system_prompts.target_prompt import TARGET_PROMPT
from components.tools import handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, TARGET_AGENT_TOOLS


async def target_agent(state: AgentState, config) -> dict:
    """Explore target repository structure and determine integration paths."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to target agent tools: get_file_contents, search_code, get_repository_tree, search_repositories
        filtered_tools = [t for t in mcp_tools if t.name in TARGET_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=[*filtered_tools],
            system_prompt=TARGET_PROMPT,
            response_format=ToolStrategy(TargetResponse),
            middleware=[
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        context = f"""Target Repository: {state["target_repo"]}
        Exploration Goals: {state.get("target_exploration", [])}
        End Goal: {state.get("end_goal", "")}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config,
        )
        response: TargetResponse = result["structured_response"]
        
        return {
            "target_summary": response.target_summary,
            "target_metadata": response.target_metadata,
            "target_path": response.target_path,
            "target_integration_instructions": response.target_integration_instructions,
            "target_paste_instructions": response.target_paste_instructions,
            "components_to_replace": response.components_to_replace
        }
