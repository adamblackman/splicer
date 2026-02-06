from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import PasterResponse
from components.system_prompts.paster_prompt import PASTER_PROMPT
from components.tools import paste, PasterContext, handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, PASTER_AGENT_TOOLS


async def paster_agent(state: AgentState, config) -> dict:
    """Transfer files from source to target repository using paste tool."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to paster agent tools
        filtered_tools = [t for t in mcp_tools if t.name in PASTER_AGENT_TOOLS]
        
        # Find push_files tool for paste context (handles atomic commits without SHA)
        push_files_tool = next(
            (t for t in filtered_tools if t.name == "push_files"),
            None
        )
        
        agent = create_agent(
            model=get_model(),
            tools=[*filtered_tools, paste],
            system_prompt=PASTER_PROMPT,
            response_format=ToolStrategy(PasterResponse),
            state_schema=AgentState,
            context_schema=PasterContext,
            middleware=[
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        # Build context from state
        context = f"""Target Repository: {state["target_repo"]}
        Branch: {state["branch"]}

        Source Paths:
        {state.get("source_path", [])}

        Copied Files:
        {state.get("copied_files", [])}

        Target Paths (for code files):
        {state.get("target_path", [])}

        Target Paste Instructions (mapping guide):
        {state.get("target_paste_instructions", [])}"""
        
        # Pass state fields for runtime.state access, context for runtime.context
        result = await agent.ainvoke(
            {
                "messages": [{"role": "user", "content": context}],
                # State fields accessible via runtime.state in tools
                "copied_files": state.get("copied_files", []),
                "target_repo": state.get("target_repo", ""),
                "branch": state.get("branch", "splice"),
            },
            config,
            context=PasterContext(push_files=push_files_tool)
        )
        
        # Extract paste tool results programmatically from messages
        import json
        pasted_files = []
        for msg in result.get("messages", []):
            if hasattr(msg, "tool_calls"):
                for tool_call in msg.tool_calls:
                    if tool_call.get("name") == "paste":
                        for result_msg in result.get("messages", []):
                            if (hasattr(result_msg, "tool_call_id") and 
                                result_msg.tool_call_id == tool_call.get("id")):
                                if isinstance(result_msg.content, str):
                                    # paste returns a list of file results
                                    paste_results = json.loads(result_msg.content)
                                    if isinstance(paste_results, list):
                                        pasted_files.extend(paste_results)
                                break
        
        return {
            "pasted_files": pasted_files
        }
