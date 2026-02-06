from langchain.agents import create_agent
from langchain.agents.middleware import ToolRetryMiddleware, TodoListMiddleware
from agent.state import AgentState
from components.model import get_model
from components.system_prompts.revisor_prompt import REVISOR_PROMPT
from components.tools import dependency, handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, REVISOR_AGENT_TOOLS


async def revisor_agent(state: AgentState, config) -> dict:
    """Fix validation issues identified by the Validator agent."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to revisor agent tools
        filtered_tools = [t for t in mcp_tools if t.name in REVISOR_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=[*filtered_tools, dependency],
            system_prompt=REVISOR_PROMPT,
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

        ## End Goal (from Planner)
        {state.get("end_goal", "No end goal specified")}

        ## Integration Instructions (from Planner)
        {state.get("integration_instructions", "No specific instructions")}

        ## Source Summary
        {state.get("source_summary", [])}

        ## Target Summary
        {state.get("target_summary", [])}

        ## Target Integration Instructions
        {state.get("target_integration_instructions", "No specific instructions")}

        ## Changeset (files that were modified)
        {state.get("changeset", [])}

        ## Wiring Changes
        {state.get("wiring_changes", [])}

        ## Validation Summary
        {state.get("validation_summary", [])}

        ## Revision (ISSUES TO FIX)
        {state.get("revision", [])}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config
        )
        
        return {}
