from langchain_core.messages import SystemMessage, HumanMessage
from components.model import get_model
from agent.state import AgentState
from components.responses import PlannerResponse
from components.system_prompts.planner_prompt import PLANNER_PROMPT

async def planner_api(state: AgentState):
    """
    The Planner Agent acts as the architect of the migration.
    It analyzes the user's request to produce a high-level plan,
    delegating exploration to the Source and Target agents.
    """
    
    model = get_model(thinking_level="low")
    structured_llm = model.with_structured_output(PlannerResponse)
    
    user_input = state["user_input"]
    
    messages = [
        SystemMessage(content=PLANNER_PROMPT),
        HumanMessage(content=user_input)
    ]
    
    response = await structured_llm.ainvoke(messages)
    
    return {
        "source_exploration": response.source_exploration,
        "target_exploration": response.target_exploration,
        "integration_instructions": response.integration_instructions,
        "end_goal": response.end_goal
    }
