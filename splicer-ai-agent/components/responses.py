import json
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, field_validator

class PlannerResponse(BaseModel):
    """Initial plan generated from user input."""
    source_exploration: List[str] = Field(description="Specific code artifacts in the user's exact language to search for in the source repository.")
    target_exploration: List[str] = Field(description="Specific locations or areas in the user's exact language where the migrated code should be placed in the target repository.")
    integration_instructions: Optional[str] = Field(default=None, description="Strategy for combining source and target features. Optional if the request is simple copy-paste.")
    end_goal: str = Field(description="The final success criteria for the migration.")

class TargetMetadata(BaseModel):
    """Structured metadata about the target repository."""
    framework: str = Field(description="Framework and build tool from package.json (e.g., 'React + Vite', 'Next.js 14', 'Vue + Vite')")
    styling: Optional[str] = Field(default=None, description="Styling system used (e.g., 'Tailwind CSS', 'styled-components', 'CSS Modules')")
    dependencies: Optional[List[str]] = Field(default=None, description="Key npm packages used (e.g., ['react', 'framer-motion', 'zustand'])")
    structure: Optional[str] = Field(default=None, description="Key structural info (e.g., 'Components in src/components/', 'Feature-based structure')")

class TargetResponse(BaseModel):
    """Analysis of the target repository's structure and where migrated component should be added."""
    target_summary: List[str] = Field(min_length=1, description="Key findings about the target repo (e.g., 'React + Vite + TypeScript', 'Uses Tailwind CSS'). REQUIRED: Must contain at least one finding.")
    target_metadata: TargetMetadata = Field(description="Structured metadata about the target repository's architecture, dependencies, and structure.")
    target_path: List[str] = Field(description="Proposed paths for new files (e.g., ['src/components/Typewriter.tsx']).")
    target_integration_instructions: str = Field(description="Step-by-step wiring instructions.")
    target_paste_instructions: List[str] = Field(description="Where to paste each source file (maps to target_path).")
    components_to_replace: Optional[List[str]] = Field(default=None, description="JSX components to remove when wiring (e.g., ['<OldHeader />']. Only for singleton replacements like backgrounds, headers, footers.")

class SourceMetadata(BaseModel):
    """Structured metadata about the source repository and extracted feature."""
    dependencies: Dict[str, str] = Field(description="npm packages with their exact versions from package.json (e.g., {'react': '^18.2.0', '@react-three/fiber': '^8.18.0'})")
    framework: str = Field(description="Framework and build tool info (e.g., 'React + Vite', 'Next.js 14')")
    styling: Optional[str] = Field(default=None, description="Styling approach used (e.g., 'Tailwind CSS', 'CSS Modules')")
    typescript: Optional[bool] = Field(default=None, description="Whether the code uses TypeScript")
    
    @field_validator("dependencies", mode="before")
    @classmethod
    def parse_dependencies(cls, v):
        """Parse dependencies from JSON string if needed."""
        if isinstance(v, str):
            return json.loads(v)
        return v

class SourceResponse(BaseModel):
    """Identification of the code to be migrated from the source repository."""
    source_summary: List[str] = Field(min_length=1, description="Key findings about the feature (e.g., 'Found TypewriterText component', 'Uses React hooks'). REQUIRED: Must contain at least one finding about what was discovered.")
    source_metadata: SourceMetadata = Field(description="Structured metadata about the source feature's dependencies, framework, and characteristics.")
    source_path: List[str] = Field(description="Paths from all copy tool calls you made (e.g., ['src/components/TypewriterText.tsx', 'tailwind.config.ts']).")
    copied_files: List[Dict[str, Any]] = Field(description="List of all copy tool results. For each copy tool call you made, include the EXACT dict that was returned: [{'path': 'src/components/X.tsx', 'content': 'full file content...', 'type': 'component'}, {...}]. DO NOT use empty dicts.")

class PasterResponse(BaseModel):
    """Information of files pasted into the target repository."""
    pasted_files: List[Dict[str, Any]] = Field(description="Relevant details of each file created, including its path, type, and associated metadata.")

class IntegratorResponse(BaseModel):
    """Result wiring the new code into the target environment."""
    integration_summary: str = Field(description="Overview of the integration work performed.")
    changeset: List[str] = Field(description="List of all files that were modified or created.")
    wiring_changes: Optional[List[str]] = Field(description="Description of changes made to wire the code.")
    dependency_changes: Optional[List[str]] = Field(description="Packages added or updated in the target's configuration.")
    config_changes: Optional[List[str]] = Field(description="Changes made to config files.")

class ValidationResponse(BaseModel):
    """Skeptical review of the final integrated code."""
    problems: bool = Field(description="True if issues were found that require a revision agent.")
    validation_summary: List[str] = Field(description="A list of checks performed and their outcomes.")
    check_results: List[str] = Field(description="Detailed logs or error messages from tests/linters.")
    revision: Optional[List[str]] = Field(default=None, description="Instructions for the Revision Agent of issues to cover and instructions for each.")

class CheckRevisorResponse(BaseModel):
    """Result of fixing syntax errors caught by the check node."""
    fixes_applied: List[str] = Field(description="List of fixes made (e.g., 'Removed trailing comma in package.json:62').")
    files_modified: List[str] = Field(description="List of file paths that were changed.")
