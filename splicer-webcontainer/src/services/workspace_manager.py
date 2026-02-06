"""Workspace manager for isolated session environments.

Each session gets its own workspace directory containing the cloned repository.
The workspace manager handles creation, isolation, and cleanup of these directories.
"""

import asyncio
import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from src.config import get_settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class PackageInfo:
    """Detected package manager and configuration."""

    manager: Literal["npm", "yarn", "pnpm"]
    lockfile: str | None
    scripts: dict[str, str] = field(default_factory=dict)
    dependencies: dict[str, str] = field(default_factory=dict)
    dev_dependencies: dict[str, str] = field(default_factory=dict)


@dataclass
class WorkspaceInfo:
    """Information about a workspace."""

    session_id: str
    path: Path
    package_info: PackageInfo | None = None
    detected_framework: str | None = None
    start_command: list[str] | None = None


class WorkspaceManager:
    """Manages workspace directories for preview sessions.
    
    Responsibilities:
    - Create isolated workspace directories
    - Detect package manager and framework
    - Install dependencies
    - Determine start command
    - Clean up workspaces
    """

    def __init__(self):
        """Initialize workspace manager."""
        self._settings = get_settings()
        self._base_dir = Path(self._settings.workspace_base_dir)

    def _get_workspace_path(self, session_id: str) -> Path:
        """Get the workspace path for a session.
        
        Args:
            session_id: Session identifier
            
        Returns:
            Path to workspace directory
        """
        # Validate session_id to prevent path traversal
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        if safe_id != session_id:
            raise ValueError(f"Invalid session ID: {session_id}")

        return self._base_dir / safe_id

    async def create_workspace(self, session_id: str) -> Path:
        """Create an isolated workspace directory.
        
        Args:
            session_id: Session identifier
            
        Returns:
            Path to created workspace
            
        Raises:
            ValueError: If session_id is invalid
            OSError: If directory creation fails
        """
        workspace_path = self._get_workspace_path(session_id)

        # Ensure parent directory exists
        self._base_dir.mkdir(parents=True, exist_ok=True)

        # Create workspace with restrictive permissions
        workspace_path.mkdir(mode=0o700, exist_ok=False)

        logger.info(
            f"Created workspace",
            extra={"session_id": session_id, "path": str(workspace_path)},
        )

        return workspace_path

    async def cleanup_workspace(self, session_id: str) -> bool:
        """Remove a workspace directory and all contents.
        
        Args:
            session_id: Session identifier
            
        Returns:
            True if cleanup successful, False if workspace didn't exist
        """
        workspace_path = self._get_workspace_path(session_id)

        if not workspace_path.exists():
            return False

        try:
            # Use shutil.rmtree for recursive deletion
            shutil.rmtree(workspace_path)
            logger.info(
                f"Cleaned up workspace",
                extra={"session_id": session_id},
            )
            return True
        except Exception as e:
            logger.error(
                f"Failed to cleanup workspace: {e}",
                extra={"session_id": session_id},
            )
            return False

    async def detect_package_manager(self, workspace_path: Path) -> PackageInfo | None:
        """Detect the package manager used by the project.
        
        Checks for lockfiles and package.json to determine:
        - Package manager (npm, yarn, pnpm)
        - Available scripts
        - Dependencies
        
        Args:
            workspace_path: Path to workspace
            
        Returns:
            PackageInfo or None if not a Node.js project
        """
        package_json_path = workspace_path / "package.json"

        if not package_json_path.exists():
            return None

        try:
            with open(package_json_path) as f:
                package_data = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to parse package.json: {e}")
            return None

        # Detect package manager from lockfiles
        # Priority: pnpm > yarn > npm (based on common usage in modern projects)
        lockfile = None
        if (workspace_path / "pnpm-lock.yaml").exists():
            manager = "pnpm"
            lockfile = "pnpm-lock.yaml"
        elif (workspace_path / "yarn.lock").exists():
            manager = "yarn"
            lockfile = "yarn.lock"
        elif (workspace_path / "package-lock.json").exists():
            manager = "npm"
            lockfile = "package-lock.json"
        else:
            # Default to npm if no lockfile
            manager = "npm"

        return PackageInfo(
            manager=manager,
            lockfile=lockfile,
            scripts=package_data.get("scripts", {}),
            dependencies=package_data.get("dependencies", {}),
            dev_dependencies=package_data.get("devDependencies", {}),
        )

    async def detect_framework(self, package_info: PackageInfo) -> str | None:
        """Detect the frontend framework from dependencies.
        
        Priority matters here:
        1. Build tools (vite) should be detected first since they determine
           how the dev server runs and what flags it supports
        2. Meta-frameworks (next, nuxt, sveltekit) that bundle their own server
        3. UI frameworks (react, vue, svelte, angular)
        
        Args:
            package_info: Package information
            
        Returns:
            Framework name or None
        """
        all_deps = {**package_info.dependencies, **package_info.dev_dependencies}
        dev_deps = package_info.dev_dependencies

        # First, check for build tools in devDependencies (highest priority)
        # These determine the dev server behavior and supported flags
        if "vite" in dev_deps or "vite" in all_deps:
            return "vite"

        # Check for meta-frameworks that bundle their own dev server
        # Order matters - more specific frameworks first
        framework_indicators = [
            ("next", "nextjs"),
            ("nuxt", "nuxt"),
            ("@sveltejs/kit", "sveltekit"),
            ("@angular/cli", "angular"),
            # UI frameworks (fallback if no build tool detected)
            ("svelte", "svelte"),
            ("vue", "vue"),
            ("@angular/core", "angular"),
            ("react", "react"),
        ]

        for dep, framework in framework_indicators:
            if dep in all_deps:
                return framework

        return None

    def _get_start_command(
        self,
        package_info: PackageInfo,
        framework: str | None,
    ) -> list[str]:
        """Determine the command to start the dev server.
        
        Uses safe defaults based on detected framework and available scripts.
        Does NOT accept arbitrary commands from users.
        
        Args:
            package_info: Package information
            framework: Detected framework name
            
        Returns:
            Command as list of strings
        """
        manager = package_info.manager
        scripts = package_info.scripts

        # Run command varies by package manager
        run_cmd = {
            "npm": ["npm", "run"],
            "yarn": ["yarn"],
            "pnpm": ["pnpm"],
        }[manager]

        # Priority order for script names
        # These are safe, well-known script names
        preferred_scripts = ["dev", "start", "serve", "preview"]

        # For Next.js, prefer 'dev' over 'start' (start is production)
        if framework == "nextjs":
            preferred_scripts = ["dev", "start"]

        # Find the first matching script
        for script_name in preferred_scripts:
            if script_name in scripts:
                return run_cmd + [script_name]

        # Fallback: if 'dev' or 'start' exists, use it
        if "dev" in scripts:
            return run_cmd + ["dev"]
        if "start" in scripts:
            return run_cmd + ["start"]

        # Last resort: try to run a common framework command directly
        framework_commands = {
            "vite": ["npx", "vite", "--host"],
            "nextjs": ["npx", "next", "dev"],
            "react": ["npx", "react-scripts", "start"],
        }

        if framework and framework in framework_commands:
            return framework_commands[framework]

        # If nothing found, default to npm start
        return ["npm", "start"]

    async def install_dependencies(
        self,
        workspace_path: Path,
        package_info: PackageInfo,
        session_id: str | None = None,
    ) -> tuple[bool, str]:
        """Install project dependencies.
        
        Args:
            workspace_path: Path to workspace
            package_info: Package information
            session_id: Session ID for logging
            
        Returns:
            Tuple of (success, error_or_output)
        """
        log = get_logger(__name__, session_id=session_id)

        manager = package_info.manager

        # Install command varies by manager
        # Using standard install (not ci/frozen-lockfile) because the agent may
        # modify package.json without updating the lockfile
        install_cmd = {
            "npm": ["npm", "install"],
            "yarn": ["yarn", "install"],
            "pnpm": ["pnpm", "install"],
        }[manager]

        log.info(f"Installing dependencies with {manager}")

        try:
            process = await asyncio.create_subprocess_exec(
                *install_cmd,
                cwd=str(workspace_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._get_node_env(workspace_path),
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=300.0,  # 5 minute timeout for install
            )

            if process.returncode != 0:
                error_output = stderr.decode().strip() or stdout.decode().strip()
                log.error(f"Dependency installation failed: {error_output[:500]}")
                return False, error_output

            log.info("Dependencies installed successfully")
            return True, stdout.decode()

        except asyncio.TimeoutError:
            log.error("Dependency installation timeout")
            return False, "Installation timeout exceeded (5 minutes)"
        except Exception as e:
            log.error(f"Dependency installation error: {e}")
            return False, str(e)

    async def prepare_workspace(
        self,
        workspace_path: Path,
        session_id: str,
    ) -> WorkspaceInfo:
        """Prepare a workspace after cloning.
        
        Detects package manager, framework, and installs dependencies.
        
        Args:
            workspace_path: Path to cloned repository
            session_id: Session identifier
            
        Returns:
            WorkspaceInfo with detected configuration
        """
        log = get_logger(__name__, session_id=session_id)

        # Detect package manager
        package_info = await self.detect_package_manager(workspace_path)

        if not package_info:
            log.warning("No package.json found - not a Node.js project")
            return WorkspaceInfo(
                session_id=session_id,
                path=workspace_path,
                package_info=None,
            )

        # Detect framework
        framework = await self.detect_framework(package_info)
        log.info(f"Detected: manager={package_info.manager}, framework={framework}")

        # Install dependencies
        success, output = await self.install_dependencies(
            workspace_path, package_info, session_id
        )

        if not success:
            raise RuntimeError(f"Failed to install dependencies: {output}")

        # Determine start command
        start_command = self._get_start_command(package_info, framework)
        log.info(f"Start command: {' '.join(start_command)}")

        return WorkspaceInfo(
            session_id=session_id,
            path=workspace_path,
            package_info=package_info,
            detected_framework=framework,
            start_command=start_command,
        )

    def _get_node_env(self, workspace_path: Path) -> dict[str, str]:
        """Get environment variables for Node.js operations.
        
        Args:
            workspace_path: Path to workspace
            
        Returns:
            Environment dictionary
        """
        env = os.environ.copy()

        # Ensure node_modules/.bin is in PATH
        node_bin = workspace_path / "node_modules" / ".bin"
        if "PATH" in env:
            env["PATH"] = f"{node_bin}:{env['PATH']}"
        else:
            env["PATH"] = str(node_bin)

        # Disable npm update checks
        env["NO_UPDATE_NOTIFIER"] = "1"
        env["NPM_CONFIG_UPDATE_NOTIFIER"] = "false"

        # Set CI mode for predictable behavior
        env["CI"] = "true"

        # Limit Node.js memory to prevent OOM during npm install
        # With 4GB container, allow 3GB for Node heap, leaving ~1GB for system/npm overhead
        # This prevents Node from consuming all available memory
        env["NODE_OPTIONS"] = "--max-old-space-size=3072"

        return env

    async def get_workspace_info(self, session_id: str) -> WorkspaceInfo | None:
        """Get information about an existing workspace.
        
        Args:
            session_id: Session identifier
            
        Returns:
            WorkspaceInfo or None if workspace doesn't exist
        """
        workspace_path = self._get_workspace_path(session_id)

        if not workspace_path.exists():
            return None

        package_info = await self.detect_package_manager(workspace_path)
        framework = None
        start_command = None

        if package_info:
            framework = await self.detect_framework(package_info)
            start_command = self._get_start_command(package_info, framework)

        return WorkspaceInfo(
            session_id=session_id,
            path=workspace_path,
            package_info=package_info,
            detected_framework=framework,
            start_command=start_command,
        )

    async def cleanup_all_workspaces(self) -> int:
        """Clean up all workspaces (used during shutdown).
        
        Returns:
            Number of workspaces cleaned up
        """
        if not self._base_dir.exists():
            return 0

        count = 0
        for item in self._base_dir.iterdir():
            if item.is_dir():
                try:
                    shutil.rmtree(item)
                    count += 1
                except Exception as e:
                    logger.error(f"Failed to cleanup workspace {item}: {e}")

        logger.info(f"Cleaned up {count} workspaces")
        return count


def get_workspace_manager() -> WorkspaceManager:
    """Get workspace manager instance."""
    return WorkspaceManager()
