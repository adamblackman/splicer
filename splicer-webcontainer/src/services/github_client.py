"""GitHub client for repository operations.

Handles cloning repositories (public and private) into workspace directories.
Authentication is done via Personal Access Token (PAT) or GitHub App (future).
"""

import asyncio
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

from src.config import get_settings
from src.utils.logging import get_logger
from src.utils.security import sanitize_repo_identifier, sanitize_git_ref

logger = get_logger(__name__)


@dataclass
class CloneResult:
    """Result of a repository clone operation."""

    success: bool
    path: Path | None = None
    error: str | None = None
    commit_sha: str | None = None


class GitHubClient:
    """Client for GitHub repository operations.
    
    Supports cloning public and private repositories using git CLI.
    Authentication is handled via PAT in URL for private repos.
    """

    def __init__(self):
        """Initialize GitHub client."""
        self._settings = get_settings()

    @property
    def _auth_header(self) -> dict[str, str]:
        """Get authentication header for API requests."""
        if self._settings.github_pat:
            return {"Authorization": f"Bearer {self._settings.github_pat}"}
        return {}

    async def check_repo_access(
        self,
        owner: str,
        name: str,
    ) -> tuple[bool, Literal["public", "private"] | None, str | None]:
        """Check if repository exists and is accessible.
        
        Args:
            owner: Repository owner
            name: Repository name
            
        Returns:
            Tuple of (accessible, visibility, error_message)
        """
        # Validate inputs
        sanitized = sanitize_repo_identifier(owner, name)
        if not sanitized:
            return False, None, "Invalid repository owner or name"

        owner, name = sanitized
        url = f"https://api.github.com/repos/{owner}/{name}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                response = await client.get(url, headers=self._auth_header)

                if response.status_code == 200:
                    data = response.json()
                    visibility = "private" if data.get("private") else "public"
                    return True, visibility, None

                elif response.status_code == 404:
                    # Could be private and we don't have access, or doesn't exist
                    if self._settings.has_github_auth:
                        return False, None, "Repository not found or access denied"
                    return False, None, "Repository not found (may be private)"

                elif response.status_code == 401:
                    return False, None, "GitHub authentication failed"

                elif response.status_code == 403:
                    return False, None, "Access forbidden - check permissions"

                else:
                    return False, None, f"GitHub API error: {response.status_code}"

            except httpx.TimeoutException:
                return False, None, "GitHub API timeout"
            except httpx.HTTPError as e:
                return False, None, f"GitHub API error: {str(e)}"

    async def clone_repository(
        self,
        owner: str,
        name: str,
        ref: str,
        target_dir: Path,
        session_id: str | None = None,
    ) -> CloneResult:
        """Clone a GitHub repository to the target directory.
        
        Args:
            owner: Repository owner
            name: Repository name
            ref: Git reference (branch, tag, or commit)
            target_dir: Directory to clone into
            session_id: Session ID for logging context
            
        Returns:
            CloneResult with success status and details
        """
        log = get_logger(__name__, session_id=session_id, repo=f"{owner}/{name}")

        # Validate inputs
        sanitized = sanitize_repo_identifier(owner, name)
        if not sanitized:
            return CloneResult(success=False, error="Invalid repository identifier")

        owner, name = sanitized

        sanitized_ref = sanitize_git_ref(ref)
        if not sanitized_ref:
            return CloneResult(success=False, error="Invalid git reference")

        ref = sanitized_ref

        # Ensure target directory exists
        target_dir.mkdir(parents=True, exist_ok=True)

        # Build clone URL with authentication if available
        if self._settings.github_pat:
            clone_url = f"https://{self._settings.github_pat}@github.com/{owner}/{name}.git"
        else:
            clone_url = f"https://github.com/{owner}/{name}.git"

        # Clone with depth=1 for faster cloning (we don't need history)
        log.info(f"Cloning repository {owner}/{name} at {ref}")

        try:
            # Clone the repository
            clone_cmd = [
                "git", "clone",
                "--depth", "1",
                "--single-branch",
                "--branch", ref,
                clone_url,
                str(target_dir),
            ]

            process = await asyncio.create_subprocess_exec(
                *clone_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._get_git_env(),
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=120.0,  # 2 minute timeout for clone
            )

            if process.returncode != 0:
                error_msg = stderr.decode().strip()
                # Redact any tokens from error message
                if self._settings.github_pat:
                    error_msg = error_msg.replace(self._settings.github_pat, "[REDACTED]")
                log.error(f"Clone failed: {error_msg}")
                return CloneResult(success=False, error=f"Clone failed: {error_msg}")

            # Get the commit SHA
            commit_sha = await self._get_commit_sha(target_dir)

            log.info(f"Clone successful, commit: {commit_sha}")
            return CloneResult(
                success=True,
                path=target_dir,
                commit_sha=commit_sha,
            )

        except asyncio.TimeoutError:
            log.error("Clone timeout exceeded")
            # Clean up partial clone
            if target_dir.exists():
                shutil.rmtree(target_dir, ignore_errors=True)
            return CloneResult(success=False, error="Clone timeout exceeded (2 minutes)")

        except Exception as e:
            error_msg = str(e)
            if self._settings.github_pat:
                error_msg = error_msg.replace(self._settings.github_pat, "[REDACTED]")
            log.error(f"Clone error: {error_msg}")
            return CloneResult(success=False, error=f"Clone error: {error_msg}")

    async def clone_with_fallback(
        self,
        owner: str,
        name: str,
        ref: str,
        target_dir: Path,
        session_id: str | None = None,
    ) -> CloneResult:
        """Clone repository with fallback to default branch if ref fails.
        
        Attempts to clone the specified ref, falls back to 'main' then 'master'.
        
        Args:
            owner: Repository owner
            name: Repository name
            ref: Git reference to try first
            target_dir: Directory to clone into
            session_id: Session ID for logging
            
        Returns:
            CloneResult with success status
        """
        log = get_logger(__name__, session_id=session_id, repo=f"{owner}/{name}")

        # Try the specified ref first
        result = await self.clone_repository(owner, name, ref, target_dir, session_id)
        if result.success:
            return result

        # If not the default branch, try fallbacks
        fallback_refs = ["main", "master"]
        if ref in fallback_refs:
            fallback_refs.remove(ref)

        for fallback_ref in fallback_refs:
            log.info(f"Trying fallback branch: {fallback_ref}")
            # Clean up any partial clone
            if target_dir.exists():
                shutil.rmtree(target_dir, ignore_errors=True)

            result = await self.clone_repository(
                owner, name, fallback_ref, target_dir, session_id
            )
            if result.success:
                return result

        return CloneResult(
            success=False,
            error=f"Failed to clone repository with ref '{ref}' or fallback branches",
        )

    async def _get_commit_sha(self, repo_dir: Path) -> str | None:
        """Get the current commit SHA in the repository.
        
        Args:
            repo_dir: Repository directory
            
        Returns:
            Commit SHA or None if not available
        """
        try:
            process = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "HEAD",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await process.communicate()
            if process.returncode == 0:
                return stdout.decode().strip()
        except Exception:
            pass
        return None

    def _get_git_env(self) -> dict[str, str]:
        """Get environment variables for git commands.
        
        Sets up a clean git environment to avoid user-specific configs.
        """
        env = os.environ.copy()
        # Prevent git from prompting for credentials
        env["GIT_TERMINAL_PROMPT"] = "0"
        # Prevent SSH from prompting
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
        # Disable credential helpers that might interfere
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        return env


def get_github_client() -> GitHubClient:
    """Get GitHub client instance."""
    return GitHubClient()
