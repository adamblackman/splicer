from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware, TodoListMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import IntegratorResponse
from components.system_prompts.integrator_prompt import INTEGRATOR_PROMPT
from components.tools import dependency, handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, INTEGRATOR_AGENT_TOOLS


async def integrator_agent(state: AgentState, config) -> dict:
    """Adapt pasted code to work within the target repository."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to integrator agent tools
        filtered_tools = [t for t in mcp_tools if t.name in INTEGRATOR_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=[*filtered_tools, dependency],
            system_prompt=INTEGRATOR_PROMPT,
            response_format=ToolStrategy(IntegratorResponse),
            state_schema=AgentState,
            middleware=[
                TodoListMiddleware(),
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        # Build context from state
        context = f"""Target Repository: {state["target_repo"]}
        Branch: {state["branch"]}

        ## Integration Instructions (from Planner)
        {state.get("integration_instructions", "No specific instructions")}

        ## Source Context
        Summary: {state.get("source_summary", [])}
        Metadata: {state.get("source_metadata", {})}

        ## Target Context
        Summary: {state.get("target_summary", [])}
        Metadata: {state.get("target_metadata", {})}
        Target Paths: {state.get("target_path", [])}

        ## Target Integration Instructions
        {state.get("target_integration_instructions", "No specific instructions")}

        ## Components to Replace
        {state.get("components_to_replace") or "None - add new component alongside existing ones"}

        ## Pasted Files (metadata)
        {state.get("pasted_files", [])}

        ## Copied Files (original source content)
        {state.get("copied_files", [])}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config
        )
        
        # Extract structured response
        response: IntegratorResponse = result.get("structured_response")
        
        return {
            "integration_summary": response.integration_summary,
            "changeset": response.changeset,
            "wiring_changes": response.wiring_changes,
            "dependency_changes": response.dependency_changes,
            "config_changes": response.config_changes,
        }
