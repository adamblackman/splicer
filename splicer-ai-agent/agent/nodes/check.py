"""
Check node - runs static validation on the target repository.

This node runs programmatically before the validator agent, storing results
in state for the validator to analyze.
"""

import json
import re
from typing import Any, Dict, List, Tuple
from langgraph.config import get_stream_writer
from agent.state import AgentState
from components.github_mcp import github_session, get_token_from_config


# Patterns for import extraction
_IMPORT_PATTERN = re.compile(
    r'''(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]|'''
    r'''require\s*\(\s*['"]([^'"]+)['"]\s*\)''',
    re.MULTILINE
)

# Node.js built-in modules (not npm packages)
_NODE_BUILTINS = {"fs", "path", "url", "crypto", "os", "util", "http", "https", "stream", "events", "buffer"}

# File extensions by language category
_JS_TS_EXTENSIONS = (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")
_JSON_EXTENSIONS = (".json",)
_PYTHON_EXTENSIONS = (".py", ".pyw")
_YAML_EXTENSIONS = (".yaml", ".yml")

def _strip_strings_and_comments(content: str, is_jsx: bool = False) -> str:
    """
    Replace string literals and comments with whitespace to avoid false positives
    in bracket matching. Preserves line structure for error reporting.
    """
    result = []
    i = 0
    n = len(content)
    
    while i < n:
        # Single-line comment
        if content[i:i+2] == '//':
            result.append('//')
            i += 2
            while i < n and content[i] != '\n':
                result.append(' ')
                i += 1
        # Multi-line comment
        elif content[i:i+2] == '/*':
            result.append('/*')
            i += 2
            while i < n - 1 and content[i:i+2] != '*/':
                result.append(' ' if content[i] != '\n' else '\n')
                i += 1
            if i < n - 1:
                result.append('*/')
                i += 2
        # Template literal
        elif content[i] == '`':
            result.append(' ')
            i += 1
            while i < n and content[i] != '`':
                if content[i] == '\\' and i + 1 < n:
                    result.append('  ')
                    i += 2
                elif content[i] == '\n':
                    result.append('\n')
                    i += 1
                else:
                    result.append(' ')
                    i += 1
            if i < n:
                result.append(' ')
                i += 1
        # String literals
        elif content[i] in '"\'':
            quote = content[i]
            result.append(' ')
            i += 1
            while i < n and content[i] != quote:
                if content[i] == '\\' and i + 1 < n:
                    result.append('  ')
                    i += 2
                elif content[i] == '\n':
                    break  # Unterminated string
                else:
                    result.append(' ')
                    i += 1
            if i < n and content[i] == quote:
                result.append(' ')
                i += 1
        else:
            result.append(content[i])
            i += 1
    
    return ''.join(result)


def _check_bracket_balance(content: str, file_path: str) -> List[str]:
    """
    Check for balanced brackets, braces, and parentheses.
    Returns list of error messages.
    """
    errors = []
    stripped = _strip_strings_and_comments(content, file_path.endswith(('.jsx', '.tsx')))
    
    stack: List[Tuple[str, int, int]] = []  # (char, line, col)
    pairs = {'(': ')', '[': ']', '{': '}'}
    closers = {')': '(', ']': '[', '}': '{'}
    
    line = 1
    col = 1
    
    for char in stripped:
        if char in pairs:
            stack.append((char, line, col))
        elif char in closers:
            expected_opener = closers[char]
            if not stack:
                errors.append(f"Unexpected '{char}' at line {line}, col {col}")
            elif stack[-1][0] != expected_opener:
                opener, open_line, open_col = stack[-1]
                errors.append(
                    f"Mismatched brackets: '{opener}' at line {open_line} closed with '{char}' at line {line}"
                )
                stack.pop()
            else:
                stack.pop()
        
        if char == '\n':
            line += 1
            col = 1
        else:
            col += 1
    
    # Report unclosed brackets
    for opener, open_line, open_col in stack:
        errors.append(f"Unclosed '{opener}' at line {open_line}, col {open_col}")
    
    return errors


def _check_jsx_syntax(content: str, file_path: str) -> List[str]:
    """
    Check for common JSX/TSX syntax errors.
    """
    errors = []
    stripped = _strip_strings_and_comments(content, is_jsx=True)
    
    # Pattern: closing JSX tag followed by invalid character (like the stray period)
    # Matches: </tag>. or </tag>, or />. or />,
    invalid_after_tag = re.compile(r'(?:<\/[a-zA-Z][a-zA-Z0-9]*\s*>|\/\s*>)\s*([.,])\s*(?=\)|;|\n|$)')
    
    for match in invalid_after_tag.finditer(stripped):
        char = match.group(1)
        # Find line number
        line_num = stripped[:match.start()].count('\n') + 1
        errors.append(f"Invalid '{char}' after JSX closing tag at line {line_num}")
    
    # Check for obviously broken JSX: opening < without proper closure on same logical unit
    # This is a heuristic - catches things like: <div<
    broken_tag = re.compile(r'<([a-zA-Z][a-zA-Z0-9]*)[^>]*<(?![!/])')
    for match in broken_tag.finditer(stripped):
        line_num = stripped[:match.start()].count('\n') + 1
        errors.append(f"Malformed JSX tag '<{match.group(1)}' at line {line_num}")
    
    return errors


def _check_trailing_syntax(content: str, file_path: str) -> List[str]:
    """
    Check for trailing syntax errors common in JS/TS.
    """
    errors = []
    lines = content.split('\n')
    
    for i, line in enumerate(lines, 1):
        stripped_line = line.rstrip()
        if not stripped_line:
            continue
        
        # Check for trailing operators that suggest incomplete expressions
        # But exclude valid cases like line continuation
        if re.search(r'[+\-*/]\s*$', stripped_line) and not stripped_line.endswith('++') and not stripped_line.endswith('--'):
            # Could be multiline expression, just warn
            pass
        
        # Standalone period (not part of number, property access, or spread)
        if re.search(r'(?<![0-9a-zA-Z_$\]\)])\.\s*$', stripped_line):
            if not re.search(r'\.\.\.$', stripped_line):  # Exclude spread operator
                errors.append(f"Suspicious trailing '.' at line {i}")
    
    return errors


def _check_python_syntax(content: str, file_path: str) -> List[str]:
    """
    Check Python syntax by attempting to compile.
    """
    errors = []
    try:
        compile(content, file_path, 'exec')
    except SyntaxError as e:
        errors.append(f"Python syntax error at line {e.lineno}: {e.msg}")
    return errors


def _validate_syntax(content: str, file_path: str) -> List[str]:
    """
    Validate syntax based on file type. Returns list of error messages.
    """
    errors = []
    
    if file_path.endswith(_JS_TS_EXTENSIONS):
        errors.extend(_check_bracket_balance(content, file_path))
        if file_path.endswith(('.jsx', '.tsx')):
            errors.extend(_check_jsx_syntax(content, file_path))
        errors.extend(_check_trailing_syntax(content, file_path))
    
    elif file_path.endswith(_PYTHON_EXTENSIONS):
        errors.extend(_check_python_syntax(content, file_path))
    
    elif file_path.endswith(_JSON_EXTENSIONS):
        try:
            json.loads(content)
        except json.JSONDecodeError as e:
            errors.append(f"JSON syntax error at line {e.lineno}: {e.msg}")
    
    elif file_path.endswith(_YAML_EXTENSIONS):
        # Basic YAML validation - check for tab indentation (invalid in YAML)
        for i, line in enumerate(content.split('\n'), 1):
            if line.startswith('\t'):
                errors.append(f"YAML error at line {i}: tabs not allowed for indentation")
                break
    
    return errors


def _extract_imports(content: str) -> List[str]:
    """Extract import paths from JS/TS content."""
    matches = _IMPORT_PATTERN.findall(content)
    return [m[0] or m[1] for m in matches if m[0] or m[1]]


def _extract_content_from_mcp_result(result: Any) -> str:
    """
    Extract file content from MCP tool response.
    MCP returns a list of content items:
    [{"text": "status message", "type": "text"}, {"text": "actual content", "type": "text"}]
    """
    if isinstance(result, str):
        return result
    
    if isinstance(result, list):
        for item in result:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                if not text.startswith("successfully downloaded"):
                    return text
    return ""


async def _read_file(
    get_file_contents: Any, owner: str, repo: str, path: str, ref: str
) -> Dict[str, Any]:
    """
    Read a file from GitHub. Returns dict with success status and content/error.
    """
    try:
        result = await get_file_contents.ainvoke({
            "owner": owner, "repo": repo, "path": path, "ref": ref
        })
        content = _extract_content_from_mcp_result(result)
        if content:
            return {"success": True, "content": content, "path": path}
        return {"success": False, "error": "Empty response from GitHub", "path": path}
    except Exception as e:
        return {"success": False, "error": str(e), "path": path}


async def _run_check(
    get_file_contents: Any,
    owner: str,
    repo: str,
    branch: str,
    changeset: List[str],
) -> Dict[str, Any]:
    """
    Core check logic - validates files by reading them directly.
    
    Checks performed:
    1. Changeset files exist and are readable
    2. package.json is valid JSON (extracts dependencies)
    3. tsconfig.json is valid JSON
    4. npm dependencies referenced in imports exist in package.json
    5. Syntax validation (brackets, JSX, Python compile, JSON/YAML)
    """
    writer = get_stream_writer()
    errors: List[str] = []
    warnings: List[str] = []
    checks_performed: List[str] = []
    
    writer(f"Validating {owner}/{repo} branch:{branch}")
    
    # 1. Verify changeset files exist by trying to read them
    readable_files: Dict[str, str] = {}
    for file_path in changeset:
        result = await _read_file(get_file_contents, owner, repo, file_path, branch)
        if result["success"]:
            readable_files[result["path"]] = result["content"]
        else:
            errors.append(f"Cannot read '{result['path']}': {result['error']}")
    checks_performed.append("changeset_files_exist")
    
    # 2. Validate and parse package.json (reuse if already fetched)
    all_deps: set = set()
    if "package.json" in readable_files:
        pkg_content = readable_files["package.json"]
        pkg_success = True
    else:
        pkg_result = await _read_file(get_file_contents, owner, repo, "package.json", branch)
        pkg_success = pkg_result["success"]
        pkg_content = pkg_result.get("content", "")
    
    if pkg_success:
        try:
            pkg_data = json.loads(pkg_content)
            all_deps = set(pkg_data.get("dependencies", {}).keys()) | \
                       set(pkg_data.get("devDependencies", {}).keys())
            checks_performed.append("package_json_valid")
        except json.JSONDecodeError as e:
            errors.append(f"Invalid package.json: {str(e)}")
    else:
        warnings.append("No package.json found (may not be a JS/TS project)")
    
    # 3. Validate tsconfig.json (reuse if already fetched)
    if "tsconfig.json" in readable_files:
        ts_content = readable_files["tsconfig.json"]
        ts_success = True
    else:
        ts_result = await _read_file(get_file_contents, owner, repo, "tsconfig.json", branch)
        ts_success = ts_result["success"]
        ts_content = ts_result.get("content", "")
    
    if ts_success:
        try:
            json.loads(ts_content)
            checks_performed.append("tsconfig_valid")
        except json.JSONDecodeError as e:
            errors.append(f"Invalid tsconfig.json: {str(e)}")
    
    # 4. Check npm dependencies in changeset files
    # Missing dependencies are errors (they prevent the app from running)
    missing_deps: set = set()
    js_ts_files = [f for f in changeset if f.endswith(_JS_TS_EXTENSIONS)]
    for file_path in js_ts_files:
        content = readable_files.get(file_path)
        if not content:
            continue
        
        for imp in _extract_imports(content):
            # Skip local imports and path aliases
            if imp.startswith(".") or imp.startswith("@/"):
                continue
            
            # Extract npm package name
            if imp.startswith("@"):
                pkg_name = "/".join(imp.split("/")[:2])  # @org/package
            else:
                pkg_name = imp.split("/")[0]
            
            if all_deps and pkg_name not in all_deps and pkg_name not in _NODE_BUILTINS:
                if pkg_name not in missing_deps:
                    missing_deps.add(pkg_name)
                    errors.append(f"Missing dependency '{pkg_name}' imported in {file_path}")
    
    if js_ts_files:
        checks_performed.append("npm_dependency_check")
    
    # 5. Syntax validation for all readable files
    syntax_errors_found = False
    for file_path, content in readable_files.items():
        syntax_errs = _validate_syntax(content, file_path)
        for err in syntax_errs:
            errors.append(f"{file_path}: {err}")
            syntax_errors_found = True
    
    if syntax_errors_found or readable_files:
        checks_performed.append("syntax_validation")
    
    passed = len(errors) == 0
    return {
        "errors": errors,
        "warnings": warnings,
        "checks_performed": checks_performed,
        "passed": passed
    }


async def check_node(state: AgentState, config) -> dict:
    """
    Run static validation checks on the target repository.
    
    Stores results in state for the validator agent to analyze:
    - check_output: Full check result dict (errors, warnings, checks_performed, passed)
    """
    target_repo = state.get("target_repo", "")
    branch = state.get("branch", "splice")
    changeset = state.get("changeset", [])
    
    if "/" not in target_repo:
        return {
            "check_output": {
                "errors": [f"Invalid target_repo format: {target_repo}"],
                "warnings": [],
                "checks_performed": [],
                "passed": False
            }
        }
    
    owner, repo = target_repo.split("/", 1)
    
    try:
        token = get_token_from_config(config)
        async with github_session(token) as mcp_tools:
            get_file_contents = next(
                (t for t in mcp_tools if t.name == "get_file_contents"),
                None
            )
            if not get_file_contents:
                available = [t.name for t in mcp_tools] if mcp_tools else []
                return {
                    "check_output": {
                        "errors": [f"get_file_contents tool not available. Available: {available}"],
                        "warnings": [],
                        "checks_performed": [],
                        "passed": False
                    }
                }
            
            check_output = await _run_check(
                get_file_contents=get_file_contents,
                owner=owner,
                repo=repo,
                branch=branch,
                changeset=changeset,
            )
        return {"check_output": check_output}
    except Exception as e:
        return {
            "check_output": {
                "errors": [f"GitHub MCP session error: {str(e)}"],
                "warnings": [],
                "checks_performed": [],
                "passed": False
            }
        }
