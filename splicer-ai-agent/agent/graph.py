"""
Splicer Agent Graph

This module defines the LangGraph workflow for code migration.
The graph can be compiled with or without a checkpointer for persistence.

Usage with persistence:
    from components.memory import get_checkpointer
    from agent.graph import compile_graph
    
    async with get_checkpointer() as checkpointer:
        graph = compile_graph(checkpointer=checkpointer)
        config = {"configurable": {"thread_id": "migration-123"}}
        result = await graph.ainvoke(input_data, config, durability="async")
"""
from typing import TYPE_CHECKING

from langgraph.graph import StateGraph, START, END
from agent.state import AgentState
from agent.nodes.splice import splicer_setup
from agent.nodes.planner import planner_api
from agent.nodes.target import target_agent
from agent.nodes.source import source_agent
from agent.nodes.paster import paster_agent
from agent.nodes.integrator import integrator_agent
from agent.nodes.check import check_node
# from agent.nodes.check_revisor import check_revisor_agent
# from agent.nodes.validator import validator_agent
# from agent.nodes.revisor import revisor_agent
from agent.nodes.clean import clean_up

if TYPE_CHECKING:
    from langgraph.checkpoint.base import BaseCheckpointSaver

def if_check_failed(state: AgentState):
    """
    Route based on check node results.
    If check found errors, proceed to check_revisor to fix them.
    Otherwise, skip straight to clean_up.
    """
    check_output = state.get("check_output", {})
    if not check_output.get("passed", True):
        return "check_revisor_agent"
    return "clean_up"

# def if_problems(state: AgentState):
#     """
#     Check if validation found errors.
#     If so, proceed to revisor agent.
#     Otherwise, end.
#     """
#     if state.get("problems"):
#         return "revisor_agent"
#     return END

# Graph
workflow = StateGraph(AgentState)

# Nodes
workflow.add_node("splicer_setup", splicer_setup)
workflow.add_node("planner_api", planner_api)
workflow.add_node("target_agent", target_agent)
workflow.add_node("source_agent", source_agent)
workflow.add_node("paster_agent", paster_agent)
workflow.add_node("integrator_agent", integrator_agent)
workflow.add_node("check_node", check_node)
# workflow.add_node("check_revisor_agent", check_revisor_agent)
# workflow.add_node("validator_agent", validator_agent)
# workflow.add_node("revisor_agent", revisor_agent)
workflow.add_node("clean_up", clean_up)

# Workflow
workflow.add_edge(START, "splicer_setup")
workflow.add_edge(START, "planner_api")
workflow.add_edge("planner_api", "target_agent")
workflow.add_edge("planner_api", "source_agent")
workflow.add_edge(["splicer_setup", "target_agent", "source_agent"], "paster_agent")
workflow.add_edge("paster_agent", "integrator_agent")
workflow.add_edge("integrator_agent", "check_node")

# workflow.add_conditional_edges(
#     "check_node",
#     if_check_failed,
#     {
#         "check_revisor_agent": "check_revisor_agent",
#         "clean_up": "clean_up"
#     }
# )
# workflow.add_edge("check_revisor_agent", "clean_up")

# workflow.add_edge("check_node", "validator_agent")
# workflow.add_conditional_edges(
#     "validator_agent",
#     if_problems,
#     {
#         "revisor_agent": "revisor_agent",
#         END: END
#     }
# )
# workflow.add_edge("revisor_agent", "clean_up")

workflow.add_edge("check_node", "clean_up")
workflow.add_edge("clean_up", END)

def compile_graph(checkpointer: "BaseCheckpointSaver | None" = None):
    """
    Compile the workflow with an optional checkpointer for persistence.
    
    Args:
        checkpointer: Optional checkpointer for state persistence.
                     Use get_checkpointer() from components.memory for production.
                     Pass None for testing without persistence.
    
    Returns:
        CompiledStateGraph: The compiled graph ready for invocation.
        
    Example:
        # With persistence
        async with get_checkpointer() as checkpointer:
            graph = compile_graph(checkpointer=checkpointer)
            config = {"configurable": {"thread_id": "my-thread"}}
            result = await graph.ainvoke(input_data, config, durability="async")
        
        # Without persistence (testing)
        graph = compile_graph()
        result = graph.invoke(input_data)
    """
    return workflow.compile(checkpointer=checkpointer)


# Export for langgraph dev (local testing with in-memory checkpointing)
# Production uses server.py with Postgres checkpointing instead
app = workflow.compile()
