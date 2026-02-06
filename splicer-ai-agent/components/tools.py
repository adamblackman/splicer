"""
Custom tools for the Splicer code migration agent.

These tools extend the GitHub MCP tools with domain-specific functionality:
- Temporarily removed in favor of search_code from Github MCP | search: Semantic search via Supabase vector store
- copy: Structured file extraction with type classification for migration
- paste: Intelligent file transfer from copied_files to target repository with name mapping
- dependency: Add npm packages to target repository's package.json
"""

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional
from langchain.tools import tool, ToolRuntime
from langchain_core.messages import ToolMessage
from langchain.agents.middleware import wrap_tool_call
from langgraph.config import get_stream_writer
from pydantic import BaseModel, Field

@dataclass
class Context:
    """Custom runtime context schema."""
    
# Search
# class SearchInput(BaseModel):
#     query: str = Field(description="The semantic search query to find relevant code.")
#     limit: int = Field(default=5, description="Number of results to return.")


# @tool(args_schema=SearchInput)
# def search(query: str, runtime: ToolRuntime[Context], limit: int = 5) -> str:
#     """Semantic search for code snippets in the vector store."""
#     writer = get_stream_writer()
#     writer(f"Searching for: {query}")
    
#     try:
#         # Get Supabase client from context or create a new one
#         supabase = runtime.context.get("supabase") if isinstance(runtime.context, dict) else getattr(runtime.context, "supabase", None)
#         if supabase is None:
#             supabase = supabase_client()
#         embeddings = embeddings_model()
#         query_embedding = embeddings.embed_query(query)
        
#         response = supabase.rpc(
#             "match_documents",
#             {
#                 "query_embedding": query_embedding,
#                 "match_count": limit
#             }
#         ).execute()
        
#         results = response.data if response.data else []
        
#         formatted_results = []
#         for doc in results:
#             metadata = doc.get("metadata", {})
#             source = metadata.get("source", "Unknown source")
#             content = doc.get("content", "")
#             formatted_results.append(f"File: {source}\nContent:\n{content}\n---")
            
#         return "\n".join(formatted_results) if formatted_results else "No results found."

#     except Exception as e:
#         return f"Error performing search: {str(e)}"

# Copy
FileType = Literal["component", "hook", "util", "type", "style", "config", "asset"]

class CopyInput(BaseModel):
    path: str = Field(description="File path within the repository.")
    content: str = Field(description="File content (use get_file_contents tool first to retrieve).")
    file_type: FileType = Field(description="Type of file: component, hook, util, type, style, config, or asset.")

@tool(args_schema=CopyInput)
async def copy(path: str, content: str, file_type: FileType) -> Dict[str, Any]:
    """Structure a file for migration with type classification.
    
    Use this after calling get_file_contents to mark a file for copying.
    Returns structured file data with path, content, and type classification.
    """
    writer = get_stream_writer()
    writer(f"Marking {path} for migration as {file_type}")
    return {"path": path, "content": content, "type": file_type}

@wrap_tool_call
async def handle_tool_errors(request, handler):
    """Handle tool execution errors with user-friendly messages."""
    try:
        return await handler(request)
    except Exception as e:
        return ToolMessage(
            content=f"Tool error: Please check your input and try again. ({str(e)})",
            tool_call_id=request.tool_call["id"]
        )

# Paste
class FileMapping(BaseModel):
    """Maps a source file path to its target destination."""
    source_file_path: str = Field(description="Path of the file in copied_files (e.g., 'src/components/TypewriterText.tsx').")
    target_file_path: str = Field(description="Where to write the file in the target repository (e.g., 'src/components/Typewriter.tsx').")


class PasteInput(BaseModel):
    """Input schema for paste tool - accepts multiple file mappings."""
    file_mappings: List[FileMapping] = Field(
        description="List of file mappings from source paths to target paths. "
                    "Each mapping specifies which file from copied_files to paste and where."
    )


async def paste_tool(
    file_mappings: List[Dict[str, str]],
    copied_files: List[Dict[str, Any]],
    target_repo: str,
    push_files_tool: Any,
    branch: str = "splice"
) -> List[Dict[str, Any]]:
    """
    Core implementation of paste logic (testable without runtime injection).
    Batches all files into a single atomic push_files call.
    
    Args:
        file_mappings: List of dicts with source_file_path and target_file_path.
        copied_files: List of files from state.
        target_repo: Target repository in 'owner/repo' format.
        push_files_tool: GitHub MCP push_files tool for atomic file commits.
        branch: Branch name to commit to (defaults to "splice").
    
    Returns:
        List of metadata dicts with target path, type, and original_source_path.
    """
    writer = get_stream_writer()
    
    # Parse target_repo
    if "/" not in target_repo:
        raise ValueError(f"Invalid target_repo format: {target_repo}. Expected 'owner/repo'")
    
    owner, repo = target_repo.split("/", 1)
    
    # Build files list for push_files and result metadata
    files_to_push = []
    results = []
    
    for mapping in file_mappings:
        source_path = mapping["source_file_path"]
        target_path = mapping["target_file_path"]
        
        writer(f"Pasting {source_path} → {target_path}")
        
        # Find the source file in copied_files
        source_file = next((f for f in copied_files if f["path"] == source_path), None)
        if not source_file:
            raise ValueError(f"File {source_path} not found in copied_files")
        
        content = source_file["content"]
        file_type = source_file["type"]
        
        files_to_push.append({"path": target_path, "content": content})
        results.append({
            "path": target_path,
            "type": file_type,
            "original_source_path": source_path
        })
    
    # Single atomic commit with all files
    file_count = len(files_to_push)
    commit_message = f"Splicer: Add {file_count} file{'s' if file_count != 1 else ''}"
    
    await push_files_tool.ainvoke({
        "owner": owner,
        "repo": repo,
        "branch": branch,
        "message": commit_message,
        "files": files_to_push
    })
    
    return results


@dataclass
class PasterContext:
    """Context schema for the paste tool - holds MCP tool dependency."""
    push_files: Any


@tool(args_schema=PasteInput)
async def paste(file_mappings: List[FileMapping], runtime: ToolRuntime[PasterContext]) -> List[Dict[str, Any]]:
    """
    Paste files from copied_files to the target repository in a single atomic commit.
    Handles mapping between source files and target paths.
    
    IMPORTANT: Pass ALL file mappings in a single call to avoid commit conflicts.
    Multiple sequential calls will fail due to branch reference conflicts.
    
    Args:
        file_mappings: List of FileMapping objects with source_file_path and target_file_path.
    
    Returns:
        List of metadata dicts with target path, type, and original_source_path for each pasted file.
    """
    # Access state via runtime.state (LangChain best practice)
    copied_files = runtime.state.get("copied_files", [])
    target_repo = runtime.state.get("target_repo", "")
    branch = runtime.state.get("branch", "splice")
    
    # Access MCP tool via runtime.context
    push_files_tool = runtime.context.push_files
    if not push_files_tool:
        raise ValueError("push_files tool not available in context")
    
    # Convert FileMapping objects to dicts
    mappings_as_dicts = [
        {"source_file_path": m.source_file_path, "target_file_path": m.target_file_path}
        for m in file_mappings
    ]
    
    return await paste_tool(
        file_mappings=mappings_as_dicts,
        copied_files=copied_files,
        target_repo=target_repo,
        push_files_tool=push_files_tool,
        branch=branch
    )


# Dependency
class DependencyInput(BaseModel):
    """Input schema for dependency tool."""
    name: str = Field(description="npm package name (e.g., 'framer-motion', '@types/react').")
    version: str = Field(description="Semver version from source_metadata.dependencies (e.g., '^8.18.0'). REQUIRED - always use the exact version from the source repository.")
    package_json_content: str = Field(description="Current package.json content (use get_file_contents first).")


@tool(args_schema=DependencyInput)
def dependency(name: str, package_json_content: str, version: str) -> Dict[str, Any]:
    """
    Add npm dependency to package.json content. Returns updated content for writing via push_files.
    
    If dependency already exists, returns status 'skipped' with existing version.
    
    IMPORTANT: Always provide the exact version from source_metadata.dependencies.
    Using "latest" can cause compatibility issues with tested source code.
    
    Usage:
    1. Read package.json with get_file_contents
    2. Call dependency(name, package_json_content, version?)
    3. Write updated_content back with push_files
    """
    writer = get_stream_writer()
    
    # Warn if "latest" is used - this often causes compatibility issues
    if version == "latest":
        writer(f"WARNING: Using 'latest' for {name} - this may cause compatibility issues. Prefer using the exact version from source_metadata.dependencies.")
    
    writer(f"Processing dependency: {name}@{version}")
    
    package_json = json.loads(package_json_content)
    
    if "dependencies" not in package_json:
        package_json["dependencies"] = {}
    
    # Skip if already exists
    if name in package_json["dependencies"]:
        existing_version = package_json["dependencies"][name]
        writer(f"Skipping {name} - already exists with version {existing_version}")
        return {
            "name": name,
            "version": existing_version,
            "status": "skipped",
            "updated_content": package_json_content
        }
    
    # Add dependency
    package_json["dependencies"][name] = version
    updated_content = json.dumps(package_json, indent=2)
    
    writer(f"Added {name}@{version}")
    
    return {
        "name": name,
        "version": version,
        "status": "added",
        "updated_content": updated_content
    }