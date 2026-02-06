from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import SourceResponse
from components.system_prompts.source_prompt import SOURCE_PROMPT
from components.tools import copy, handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, SOURCE_AGENT_TOOLS


async def source_agent(state: AgentState, config) -> dict:
    """Extract feature code and dependencies from source repository."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to source agent tools: get_file_contents, search_code, get_repository_tree, search_repositories
        filtered_tools = [t for t in mcp_tools if t.name in SOURCE_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=[*filtered_tools, copy],
            system_prompt=SOURCE_PROMPT,
            response_format=ToolStrategy(SourceResponse),
            middleware=[
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        context = f"""Source Repository: {state["source_repo"]}
        Exploration Goals: {state.get("source_exploration", [])}
        End Goal: {state.get("end_goal", "")}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config,
        )
        response: SourceResponse = result["structured_response"]
        
        # Extract copy tool results programmatically from messages
        import json
        copied_files = []
        for msg in result.get("messages", []):
            if hasattr(msg, "tool_calls"):
                for tool_call in msg.tool_calls:
                    if tool_call.get("name") == "copy":
                        for result_msg in result.get("messages", []):
                            if (hasattr(result_msg, "tool_call_id") and 
                                result_msg.tool_call_id == tool_call.get("id")):
                                if isinstance(result_msg.content, str):
                                    copied_files.append(json.loads(result_msg.content))
                                break
        source_path = [f["path"] for f in copied_files]
        
        return {
            "source_summary": response.source_summary,
            "source_metadata": response.source_metadata,
            "source_path": source_path,
            "copied_files": copied_files
        }
