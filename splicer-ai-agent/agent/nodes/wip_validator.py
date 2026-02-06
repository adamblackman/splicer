from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain.agents.middleware import ToolRetryMiddleware
from agent.state import AgentState
from components.model import get_model
from components.responses import ValidationResponse
from components.system_prompts.validator_prompt import VALIDATOR_PROMPT
from components.tools import handle_tool_errors
from components.github_mcp import github_session, get_token_from_config, VALIDATOR_AGENT_TOOLS


async def validator_agent(state: AgentState, config) -> dict:
    """Verify the Integrator's work is functional and meets the migration goal."""
    token = get_token_from_config(config)
    async with github_session(token) as mcp_tools:
        # Filter to validator agent tools
        filtered_tools = [t for t in mcp_tools if t.name in VALIDATOR_AGENT_TOOLS]
        
        agent = create_agent(
            model=get_model(thinking_level="high"),
            tools=filtered_tools,
            system_prompt=VALIDATOR_PROMPT,
            response_format=ToolStrategy(ValidationResponse),
            state_schema=AgentState,
            middleware=[
                ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
                handle_tool_errors
            ]
        )
        
        # Format check_output for the agent context
        check_output = state.get("check_output", {})
        check_errors = check_output.get("errors", [])
        check_warnings = check_output.get("warnings", [])
        check_passed = check_output.get("passed", True)
        checks_performed = check_output.get("checks_performed", [])
        
        check_summary = f"""Passed: {check_passed}
        Checks performed: {', '.join(checks_performed) if checks_performed else 'None'}
        Errors: {check_errors if check_errors else 'None'}
        Warnings: {check_warnings if check_warnings else 'None'}"""
        
        # Build context from state
        context = f"""Target Repository: {state["target_repo"]}
Branch: {state["branch"]}

## Check Results (from check node)
{check_summary}

## End Goal (from Planner)
{state.get("end_goal", "No end goal specified")}

## Source Summary
{state.get("source_summary", [])}

## Target Summary
{state.get("target_summary", [])}

## Changeset (files to validate)
{state.get("changeset", [])}

## Wiring Changes
{state.get("wiring_changes", [])}

## Dependency Changes
{state.get("dependency_changes", [])}

## Config Changes
{state.get("config_changes", [])}"""
        
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": context}]},
            config
        )
        
        # Extract structured response
        response: ValidationResponse = result.get("structured_response")
        
        return {
            "problems": response.problems,
            "validation_summary": response.validation_summary,
            "check_results": response.check_results,
            "revision": response.revision,
        }
