from typing import TypedDict, List, Dict, Any, Optional, Annotated
from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage

class AgentState(TypedDict):
    # Input
    user_input: str
    source_repo: str
    target_repo: str
    branch: str
    
    # Messages (for chat history and streaming)
    messages: Annotated[List[AnyMessage], add_messages]

    # Planner Output
    source_exploration: Optional[List[str]]
    target_exploration: Optional[List[str]]
    integration_instructions: Optional[str]
    end_goal: Optional[str]

    # Target Agent Output
    target_summary: Optional[List[str]]
    target_metadata: Optional[Dict[str, Any]]
    target_path: Optional[List[str]]
    target_integration_instructions: Optional[str]
    target_paste_instructions: Optional[List[str]]
    components_to_replace: Optional[List[str]]

    # Source Agent Output
    source_summary: Optional[List[str]]
    source_metadata: Optional[Dict[str, Any]]
    source_path: Optional[List[str]]
    copied_files: Optional[List[str]]

    # Paster Agent Output
    pasted_files: Optional[List[Dict[str, Any]]]

    # Integrator Agent Output
    integration_summary: Optional[str]
    changeset: Optional[List[str]]
    wiring_changes: Optional[List[str]]
    dependency_changes: Optional[List[str]]
    config_changes: Optional[List[str]]

    # Check Node Output
    check_output: Optional[Dict[str, Any]]

    # Check Revisor Agent Output
    fixes_applied: Optional[List[str]]
    files_modified: Optional[List[str]]

    # Validator Agent Output (unused for now)
    problems: Optional[bool]
    validation_summary: Optional[List[str]]
    check_results: Optional[List[str]]
    revision: Optional[List[str]]
