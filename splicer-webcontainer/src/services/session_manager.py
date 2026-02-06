"""Session manager - orchestrates the complete session lifecycle.

This is the main coordinator that ties together:
- Database (Supabase) for persistence
- GitHub client for repository cloning
- Workspace manager for file system operations
- Process manager for dev server lifecycle
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Callable

from src.config import get_settings
from src.db import (
    get_supabase_client,
    SessionCreate,
    SessionUpdate,
    SessionStatus,
    SessionInDB,
    SessionResponse,
)
from src.services.github_client import GitHubClient, get_github_client
from src.services.workspace_manager import WorkspaceManager, get_workspace_manager
from src.services.process_manager import ProcessManager, get_process_manager
from src.utils.logging import get_logger

logger = get_logger(__name__)


class SessionManager:
    """Orchestrates the complete session lifecycle.
    
    Flow:
    1. Create session record (pending)
    2. Clone repository (cloning)
    3. Install dependencies (installing)
    4. Start dev server (starting)
    5. Wait for ready (ready) or timeout (failed)
    6. Handle stop/cleanup (stopped)
    """

    def __init__(
        self,
        github_client: GitHubClient | None = None,
        workspace_manager: WorkspaceManager | None = None,
        process_manager: ProcessManager | None = None,
    ):
        """Initialize session manager.
        
        Args:
            github_client: Optional GitHub client (uses default if not provided)
            workspace_manager: Optional workspace manager
            process_manager: Optional process manager
        """
        self._settings = get_settings()
        self._db = get_supabase_client()
        self._github = github_client or get_github_client()
        self._workspace = workspace_manager or get_workspace_manager()
        self._process = process_manager or get_process_manager()
        
        # Track active setup tasks
        self._setup_tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()
        
        # In-memory storage for GitHub tokens (not persisted to DB)
        # Tokens are cleaned up after session setup completes or fails
        self._github_tokens: dict[str, str] = {}

    async def create_session(
        self,
        repo_owner: str,
        repo_name: str,
        repo_ref: str = "main",
        github_token: str | None = None,
        force_new: bool = False,
    ) -> SessionResponse:
        """Create a new preview session and start setup in background.
        
        Args:
            repo_owner: GitHub repository owner
            repo_name: GitHub repository name
            repo_ref: Git reference (branch, tag, commit)
            github_token: GitHub installation access token for private repos
            force_new: If True, always create a new session. If False (default),
                      attempt to reuse an existing active session for the same repo/ref.
            
        Returns:
            Session response with ID and initial status
        """
        # Session reuse optimization: check for existing active session
        if not force_new:
            existing = await self.find_existing_session(repo_owner, repo_name, repo_ref)
            if existing:
                return existing

        # Create session in database
        session_data = SessionCreate(
            repo_owner=repo_owner,
            repo_name=repo_name,
            repo_ref=repo_ref,
        )

        session = await self._db.create_session(session_data)
        
        log = get_logger(
            __name__,
            session_id=session.id,
            repo=session.repo_full_name,
        )
        log.info(f"Created session for {session.repo_full_name}")

        # Store token in memory for background setup (not persisted to DB)
        if github_token:
            async with self._lock:
                self._github_tokens[session.id] = github_token

        # Start setup in background
        task = asyncio.create_task(self._setup_session(session.id))
        
        async with self._lock:
            self._setup_tasks[session.id] = task

        # Return immediate response
        return SessionResponse.from_db(session)

    async def find_existing_session(
        self,
        repo_owner: str,
        repo_name: str,
        repo_ref: str,
    ) -> SessionResponse | None:
        """Find an existing active session for the given repo/ref.
        
        This enables session reuse optimization - instead of creating a new session
        every time, we can return an existing one if it's still active and healthy.
        
        Priority:
        1. Ready sessions owned by this instance (can serve immediately)
        2. Ready sessions owned by other instances (may need recovery)
        3. In-progress sessions (setup still running)
        
        Args:
            repo_owner: GitHub repository owner
            repo_name: GitHub repository name
            repo_ref: Git reference (branch, tag, commit)
            
        Returns:
            SessionResponse if a suitable session exists, None otherwise
        """
        log = get_logger(
            __name__,
            repo=f"{repo_owner}/{repo_name}@{repo_ref}",
        )

        # First, try to find a session owned by this instance
        existing = await self._db.find_active_session_for_repo(
            repo_owner,
            repo_name,
            repo_ref,
            instance_id=self._settings.full_instance_id,
        )

        if existing:
            log.info(
                f"Reusing existing session (this instance)",
                extra={"session_id": existing.id, "status": existing.status.value},
            )
            
            # Update activity timestamp since this is a new "access"
            await self._db.update_activity(existing.id)
            
            preview_url = None
            if existing.status == SessionStatus.READY:
                preview_url = self._settings.get_preview_url(
                    existing.id,
                    existing.access_token,
                )
            
            return SessionResponse.from_db(existing, preview_url)

        # Next, try to find any active session (may be on another instance)
        existing = await self._db.find_active_session_for_repo(
            repo_owner,
            repo_name,
            repo_ref,
        )

        if existing:
            if existing.status == SessionStatus.READY:
                # Session exists on another instance - return it
                # The preview proxy will handle recovery if needed
                log.info(
                    f"Reusing existing session (other instance)",
                    extra={
                        "session_id": existing.id,
                        "instance": existing.container_instance,
                    },
                )
                
                await self._db.update_activity(existing.id)
                
                preview_url = self._settings.get_preview_url(
                    existing.id,
                    existing.access_token,
                )
                
                return SessionResponse.from_db(existing, preview_url)
            else:
                # Session is still setting up - return it so client can poll
                log.info(
                    f"Found in-progress session",
                    extra={"session_id": existing.id, "status": existing.status.value},
                )
                return SessionResponse.from_db(existing)

        return None

    async def get_session(self, session_id: str) -> SessionResponse | None:
        """Get session status and details.
        
        Args:
            session_id: Session identifier
            
        Returns:
            Session response or None if not found
        """
        session = await self._db.get_session(session_id)
        if not session:
            return None

        preview_url = None
        if session.status == SessionStatus.READY:
            preview_url = self._settings.get_preview_url(
                session.id,
                session.access_token,
            )

        return SessionResponse.from_db(session, preview_url)

    async def get_session_internal(self, session_id: str) -> SessionInDB | None:
        """Get full session record (internal use only).
        
        Args:
            session_id: Session identifier
            
        Returns:
            Full session record or None
        """
        return await self._db.get_session(session_id)

    async def stop_session(self, session_id: str) -> bool:
        """Stop a session and clean up resources.
        
        Args:
            session_id: Session identifier
            
        Returns:
            True if session was stopped, False if not found
        """
        log = get_logger(__name__, session_id=session_id)

        session = await self._db.get_session(session_id)
        if not session:
            return False

        # Cancel any pending setup task and clean up token
        async with self._lock:
            task = self._setup_tasks.pop(session_id, None)
            self._github_tokens.pop(session_id, None)  # Clean up token if present
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        log.info("Stopping session")

        # Stop the process
        await self._process.stop_process(session_id)

        # Clean up workspace
        await self._workspace.cleanup_workspace(session_id)

        # Update database
        await self._db.soft_delete_session(session_id)

        log.info("Session stopped and cleaned up")
        return True

    async def update_activity(self, session_id: str) -> None:
        """Update last activity timestamp for a session.
        
        Called when preview traffic is received.
        
        Args:
            session_id: Session identifier
        """
        await self._db.update_activity(session_id)

    async def validate_access(
        self,
        session_id: str,
        access_token: str,
    ) -> tuple[bool, SessionInDB | None, int | None]:
        """Validate access to a session's preview.
        
        Args:
            session_id: Session identifier
            access_token: Access token from request
            
        Returns:
            Tuple of (is_valid, session, internal_port)
        """
        session = await self._db.get_session(session_id)
        
        if not session:
            return False, None, None

        # Constant-time comparison to prevent timing attacks
        from src.utils.security import constant_time_compare
        if not constant_time_compare(session.access_token, access_token):
            return False, None, None

        # Check if session is ready
        if session.status != SessionStatus.READY:
            return False, session, None

        # Check if this instance owns the session
        if session.container_instance != self._settings.full_instance_id:
            # Session is owned by another instance - attempt recovery
            return False, session, None

        # Get the internal port
        process_info = await self._process.get_process_info(session_id)
        if not process_info:
            return False, session, None

        return True, session, process_info.port

    async def recover_session(self, session_id: str) -> tuple[bool, int | None]:
        """Attempt to recover a session from another instance.
        
        This is called when a request arrives for a session owned by a different
        instance. We attempt to take over the session by re-cloning the repo
        and starting the dev server on this instance.
        
        Note: Recovery only works for public repositories since GitHub tokens
        are not persisted. Private repos will fail to clone during recovery.
        
        Args:
            session_id: Session identifier
            
        Returns:
            Tuple of (success, internal_port)
        """
        log = get_logger(__name__, session_id=session_id)
        
        session = await self._db.get_session(session_id)
        if not session:
            log.warning("Session not found for recovery")
            return False, None
        
        if session.status != SessionStatus.READY:
            log.warning(f"Session not in READY state for recovery: {session.status}")
            return False, None
        
        # Check if we're already setting up this session
        async with self._lock:
            if session_id in self._setup_tasks:
                log.info("Session recovery already in progress")
                return False, None
        
        log.info(f"Attempting to recover session from instance {session.container_instance}")
        
        try:
            # Mark session as recovering (use STARTING status)
            await self._db.update_status(session_id, SessionStatus.STARTING)
            
            # Claim ownership of this session
            await self._db.update_session(
                session_id,
                SessionUpdate(container_instance=self._settings.full_instance_id),
            )
            
            # Create workspace and re-clone
            # Note: No token available for recovery - only works for public repos
            workspace_path = await self._workspace.create_workspace(session_id)
            
            log.info("Re-cloning repository for recovery (public repos only)")
            clone_result = await self._github.clone_with_fallback(
                session.repo_owner,
                session.repo_name,
                session.repo_ref,
                workspace_path,
                session_id,
                token=None,  # No token available for recovery
            )
            
            if not clone_result.success:
                raise RuntimeError(f"Clone failed during recovery: {clone_result.error}")
            
            # Prepare workspace (install dependencies)
            log.info("Installing dependencies for recovery")
            workspace_info = await self._workspace.prepare_workspace(
                workspace_path,
                session_id,
            )
            
            if not workspace_info.start_command:
                raise RuntimeError("Could not determine start command during recovery")
            
            # Start dev server
            log.info("Starting dev server for recovery")
            process_info = await self._process.start_process(
                session_id,
                workspace_path,
                workspace_info.start_command,
                framework=workspace_info.detected_framework,
            )
            
            # Update session with port info
            await self._db.update_session(
                session_id,
                SessionUpdate(internal_port=process_info.port),
            )
            
            # Wait for ready
            is_ready = await self._process.wait_for_ready(
                session_id,
                timeout=float(self._settings.session_startup_timeout),
            )
            
            if is_ready:
                await self._db.update_status(session_id, SessionStatus.READY)
                log.info("Session recovery complete")
                return True, process_info.port
            else:
                raise RuntimeError("Server failed to start during recovery")
                
        except Exception as e:
            log.error(f"Session recovery failed: {e}")
            # Revert status if possible
            try:
                await self._db.update_status(
                    session_id, 
                    SessionStatus.FAILED, 
                    f"Recovery failed: {e}"
                )
            except Exception:
                pass
            return False, None

    async def _setup_session(self, session_id: str) -> None:
        """Background task to set up a session.
        
        Steps:
        1. Clone repository
        2. Detect package manager and install dependencies
        3. Start dev server
        4. Wait for server to be ready
        
        Args:
            session_id: Session identifier
        """
        session = await self._db.get_session(session_id)
        if not session:
            return

        log = get_logger(
            __name__,
            session_id=session_id,
            repo=session.repo_full_name,
        )

        # Retrieve GitHub token from in-memory storage (if provided)
        async with self._lock:
            github_token = self._github_tokens.get(session_id)

        try:
            # Step 1: Clone repository
            await self._db.update_status(session_id, SessionStatus.CLONING)
            log.info("Cloning repository")

            workspace_path = await self._workspace.create_workspace(session_id)

            clone_result = await self._github.clone_with_fallback(
                session.repo_owner,
                session.repo_name,
                session.repo_ref,
                workspace_path,
                session_id,
                token=github_token,
            )

            if not clone_result.success:
                raise RuntimeError(f"Clone failed: {clone_result.error}")

            # Step 2: Install dependencies
            await self._db.update_status(session_id, SessionStatus.INSTALLING)
            log.info("Installing dependencies")

            workspace_info = await self._workspace.prepare_workspace(
                workspace_path,
                session_id,
            )

            if not workspace_info.start_command:
                raise RuntimeError("Could not determine start command")

            # Step 3: Start dev server
            await self._db.update_status(session_id, SessionStatus.STARTING)
            log.info("Starting dev server")

            process_info = await self._process.start_process(
                session_id,
                workspace_path,
                workspace_info.start_command,
                framework=workspace_info.detected_framework,
            )

            # Update session with port info
            await self._db.update_session(
                session_id,
                SessionUpdate(internal_port=process_info.port),
            )

            # Step 4: Wait for ready
            log.info(f"Waiting for server to be ready on port {process_info.port}")

            is_ready = await self._process.wait_for_ready(
                session_id,
                timeout=float(self._settings.session_startup_timeout),
            )

            if is_ready:
                await self._db.update_status(session_id, SessionStatus.READY)
                log.info("Session is ready")
            else:
                # Get any output from the process for error message
                error_msg = "Server failed to start within timeout"
                await self._fail_session(session_id, error_msg)

        except asyncio.CancelledError:
            log.info("Session setup cancelled")
            await self._cleanup_failed_session(session_id)
            raise

        except Exception as e:
            log.error(f"Session setup failed: {e}")
            await self._fail_session(session_id, str(e))

        finally:
            async with self._lock:
                self._setup_tasks.pop(session_id, None)
                # Clean up GitHub token from memory (no longer needed after setup)
                self._github_tokens.pop(session_id, None)

    async def _fail_session(self, session_id: str, error: str) -> None:
        """Mark a session as failed and clean up.
        
        Args:
            session_id: Session identifier
            error: Error message
        """
        log = get_logger(__name__, session_id=session_id)
        log.error(f"Session failed: {error}")

        await self._db.update_status(session_id, SessionStatus.FAILED, error)
        await self._cleanup_failed_session(session_id)

    async def _cleanup_failed_session(self, session_id: str) -> None:
        """Clean up resources for a failed session.
        
        Args:
            session_id: Session identifier
        """
        await self._process.stop_process(session_id)
        await self._workspace.cleanup_workspace(session_id)

    async def cleanup_expired_sessions(self) -> int:
        """Clean up sessions that have exceeded their lifetime.
        
        Returns:
            Number of sessions cleaned up
        """
        expired = await self._db.get_expired_sessions()
        count = 0

        for session in expired:
            if session.container_instance == self._settings.full_instance_id:
                await self.stop_session(session.id)
                count += 1
            else:
                # Just mark as stopped, the owning instance will clean up
                await self._db.soft_delete_session(session.id)
                count += 1

        if count > 0:
            logger.info(f"Cleaned up {count} expired sessions")

        return count

    async def cleanup_idle_sessions(self) -> int:
        """Clean up sessions that have been idle too long.
        
        Returns:
            Number of sessions cleaned up
        """
        idle_threshold = datetime.now(timezone.utc) - timedelta(
            seconds=self._settings.session_idle_timeout
        )

        idle = await self._db.get_idle_sessions(idle_threshold)
        count = 0

        for session in idle:
            if session.container_instance == self._settings.full_instance_id:
                logger.info(
                    f"Cleaning up idle session",
                    extra={"session_id": session.id},
                )
                await self.stop_session(session.id)
                count += 1

        if count > 0:
            logger.info(f"Cleaned up {count} idle sessions")

        return count

    async def recover_on_startup(self) -> None:
        """Recovery logic when instance starts up.
        
        Handles orphaned sessions from crashed instances.
        """
        stale_threshold = datetime.now(timezone.utc) - timedelta(minutes=5)
        
        # Mark stale sessions as failed
        await self._db.claim_orphaned_sessions(
            self._settings.full_instance_id,
            stale_threshold,
        )

    async def shutdown(self) -> None:
        """Graceful shutdown - stop all sessions owned by this instance.
        """
        logger.info("Shutting down session manager")

        # Cancel all setup tasks
        async with self._lock:
            for task in self._setup_tasks.values():
                task.cancel()

        # Wait for tasks to complete
        if self._setup_tasks:
            await asyncio.gather(
                *self._setup_tasks.values(),
                return_exceptions=True,
            )

        # Get all sessions owned by this instance
        sessions = await self._db.list_sessions_for_instance(
            self._settings.full_instance_id
        )

        for session in sessions:
            if session.is_active:
                await self.stop_session(session.id)

        # Stop all processes (belt and suspenders)
        await self._process.stop_all_processes()

        # Clean up all workspaces
        await self._workspace.cleanup_all_workspaces()

        logger.info("Session manager shutdown complete")


# Singleton instance
_session_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    """Get session manager singleton.
    
    Returns:
        SessionManager instance
    """
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager


async def init_session_manager() -> SessionManager:
    """Initialize session manager and run startup recovery.
    
    Returns:
        Initialized SessionManager instance
    """
    manager = get_session_manager()
    await manager.recover_on_startup()
    return manager
