"""Supabase client for session persistence.

Uses the Supabase Python SDK with the secret API key for server-side operations.
All database operations go through this client for consistency and error handling.
"""

from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

from supabase import create_client, Client

from src.config import get_settings
from src.db.models import (
    SessionStatus,
    SessionCreate,
    SessionUpdate,
    SessionInDB,
)
from src.utils.logging import get_logger
from src.utils.security import generate_access_token

logger = get_logger(__name__)

# Table name constant
SESSIONS_TABLE = "preview_sessions"


class SupabaseClient:
    """Client for Supabase database operations.
    
    Encapsulates all database access and provides type-safe methods
    for session CRUD operations.
    """

    def __init__(self, client: Client):
        """Initialize with Supabase client.
        
        Args:
            client: Supabase client instance
        """
        self._client = client
        self._settings = get_settings()

    async def create_session(self, data: SessionCreate) -> SessionInDB:
        """Create a new preview session.
        
        Args:
            data: Session creation data
            
        Returns:
            Created session record
            
        Raises:
            Exception: If database operation fails
        """
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=self._settings.session_max_lifetime)

        record = {
            "repo_owner": data.repo_owner,
            "repo_name": data.repo_name,
            "repo_ref": data.repo_ref,
            "status": SessionStatus.PENDING.value,
            "access_token": generate_access_token(),
            "container_instance": self._settings.full_instance_id,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "last_activity_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
        }

        logger.info(
            f"Creating session for {data.repo_owner}/{data.repo_name}",
            extra={"repo": f"{data.repo_owner}/{data.repo_name}"},
        )

        response = self._client.table(SESSIONS_TABLE).insert(record).execute()

        if not response.data:
            raise Exception("Failed to create session: no data returned")

        return SessionInDB.model_validate(response.data[0])

    async def get_session(self, session_id: str) -> SessionInDB | None:
        """Get a session by ID.
        
        Args:
            session_id: Session UUID
            
        Returns:
            Session record or None if not found
        """
        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .eq("id", session_id)
            .is_("deleted_at", "null")
            .execute()
        )

        if not response.data:
            return None

        return SessionInDB.model_validate(response.data[0])

    async def get_session_by_token(self, access_token: str) -> SessionInDB | None:
        """Get a session by access token.
        
        Args:
            access_token: Session access token
            
        Returns:
            Session record or None if not found
        """
        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .eq("access_token", access_token)
            .is_("deleted_at", "null")
            .execute()
        )

        if not response.data:
            return None

        return SessionInDB.model_validate(response.data[0])

    async def update_session(
        self,
        session_id: str,
        update: SessionUpdate,
    ) -> SessionInDB | None:
        """Update session fields.
        
        Args:
            session_id: Session UUID
            update: Fields to update
            
        Returns:
            Updated session record or None if not found
        """
        # Build update dict, excluding None values
        update_data: dict[str, Any] = {"updated_at": datetime.now(timezone.utc).isoformat()}

        if update.status is not None:
            update_data["status"] = update.status.value
        if update.error_message is not None:
            update_data["error_message"] = update.error_message
        if update.internal_port is not None:
            update_data["internal_port"] = update.internal_port
        if update.container_instance is not None:
            update_data["container_instance"] = update.container_instance
        if update.last_activity_at is not None:
            update_data["last_activity_at"] = update.last_activity_at.isoformat()

        response = (
            self._client.table(SESSIONS_TABLE)
            .update(update_data)
            .eq("id", session_id)
            .is_("deleted_at", "null")
            .execute()
        )

        if not response.data:
            return None

        return SessionInDB.model_validate(response.data[0])

    async def update_status(
        self,
        session_id: str,
        status: SessionStatus,
        error_message: str | None = None,
    ) -> SessionInDB | None:
        """Convenience method to update session status.
        
        Args:
            session_id: Session UUID
            status: New status
            error_message: Optional error message (for failed status)
            
        Returns:
            Updated session or None
        """
        update = SessionUpdate(status=status, error_message=error_message)
        return await self.update_session(session_id, update)

    async def update_activity(self, session_id: str) -> None:
        """Update last activity timestamp for idle timeout tracking.
        
        Args:
            session_id: Session UUID
        """
        now = datetime.now(timezone.utc)
        self._client.table(SESSIONS_TABLE).update(
            {"last_activity_at": now.isoformat()}
        ).eq("id", session_id).is_("deleted_at", "null").execute()

    async def soft_delete_session(self, session_id: str) -> bool:
        """Soft-delete a session.
        
        Args:
            session_id: Session UUID
            
        Returns:
            True if session was deleted, False if not found
        """
        now = datetime.now(timezone.utc)

        response = (
            self._client.table(SESSIONS_TABLE)
            .update({
                "deleted_at": now.isoformat(),
                "status": SessionStatus.STOPPED.value,
                "updated_at": now.isoformat(),
            })
            .eq("id", session_id)
            .is_("deleted_at", "null")
            .execute()
        )

        return bool(response.data)

    async def list_active_sessions(
        self,
        instance_id: str | None = None,
        limit: int = 100,
    ) -> list[SessionInDB]:
        """List active (non-deleted, non-stopped, non-failed) sessions.
        
        Args:
            instance_id: Filter by container instance (optional)
            limit: Maximum number of results
            
        Returns:
            List of active sessions
        """
        query = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .is_("deleted_at", "null")
            .in_("status", [
                SessionStatus.PENDING.value,
                SessionStatus.CLONING.value,
                SessionStatus.INSTALLING.value,
                SessionStatus.STARTING.value,
                SessionStatus.READY.value,
            ])
            .limit(limit)
        )

        if instance_id:
            query = query.eq("container_instance", instance_id)

        response = query.execute()

        return [SessionInDB.model_validate(row) for row in response.data]

    async def list_sessions_for_instance(
        self,
        instance_id: str,
    ) -> list[SessionInDB]:
        """List all sessions owned by a specific instance.
        
        Used during instance shutdown to clean up owned sessions.
        
        Args:
            instance_id: Container instance ID
            
        Returns:
            List of sessions
        """
        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .eq("container_instance", instance_id)
            .is_("deleted_at", "null")
            .execute()
        )

        return [SessionInDB.model_validate(row) for row in response.data]

    async def get_expired_sessions(self, limit: int = 50) -> list[SessionInDB]:
        """Get sessions that have exceeded their lifetime.
        
        Args:
            limit: Maximum number of results
            
        Returns:
            List of expired sessions
        """
        now = datetime.now(timezone.utc)

        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .is_("deleted_at", "null")
            .lt("expires_at", now.isoformat())
            .limit(limit)
            .execute()
        )

        return [SessionInDB.model_validate(row) for row in response.data]

    async def get_idle_sessions(
        self,
        idle_threshold: datetime,
        limit: int = 50,
    ) -> list[SessionInDB]:
        """Get sessions that have been idle past the threshold.
        
        Args:
            idle_threshold: Cutoff time for last activity
            limit: Maximum number of results
            
        Returns:
            List of idle sessions
        """
        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .is_("deleted_at", "null")
            .eq("status", SessionStatus.READY.value)
            .lt("last_activity_at", idle_threshold.isoformat())
            .limit(limit)
            .execute()
        )

        return [SessionInDB.model_validate(row) for row in response.data]

    async def find_active_session_for_repo(
        self,
        repo_owner: str,
        repo_name: str,
        repo_ref: str,
        instance_id: str | None = None,
    ) -> SessionInDB | None:
        """Find an existing active session for the given repository and ref.
        
        Used for session reuse optimization - returns the most recent active session
        matching the repo/branch combination instead of creating a new one.
        
        Args:
            repo_owner: GitHub repository owner
            repo_name: GitHub repository name
            repo_ref: Git reference (branch, tag, commit)
            instance_id: Optional filter by container instance
            
        Returns:
            Most recent active session matching criteria, or None if not found
        """
        # Look for sessions that are ready or in progress (not failed/stopped)
        query = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .eq("repo_owner", repo_owner)
            .eq("repo_name", repo_name)
            .eq("repo_ref", repo_ref)
            .is_("deleted_at", "null")
            .in_("status", [
                SessionStatus.PENDING.value,
                SessionStatus.CLONING.value,
                SessionStatus.INSTALLING.value,
                SessionStatus.STARTING.value,
                SessionStatus.READY.value,
            ])
            .order("created_at", desc=True)
            .limit(1)
        )

        if instance_id:
            query = query.eq("container_instance", instance_id)

        response = query.execute()

        if not response.data:
            return None

        session = SessionInDB.model_validate(response.data[0])
        
        # Verify session hasn't expired
        if session.is_expired:
            logger.debug(
                f"Found session {session.id} but it's expired",
                extra={"session_id": session.id, "repo": session.repo_full_name},
            )
            return None

        logger.info(
            f"Found existing active session for {repo_owner}/{repo_name}@{repo_ref}",
            extra={"session_id": session.id, "status": session.status.value},
        )

        return session

    async def cleanup_deleted_sessions(
        self,
        older_than: datetime,
        limit: int = 100,
    ) -> int:
        """Permanently delete soft-deleted sessions older than threshold.
        
        This should be called by a scheduled cleanup job.
        
        Args:
            older_than: Delete sessions soft-deleted before this time
            limit: Maximum number to delete in one batch
            
        Returns:
            Number of sessions permanently deleted
        """
        response = (
            self._client.table(SESSIONS_TABLE)
            .delete()
            .not_.is_("deleted_at", "null")
            .lt("deleted_at", older_than.isoformat())
            .limit(limit)
            .execute()
        )

        count = len(response.data) if response.data else 0
        if count > 0:
            logger.info(f"Permanently deleted {count} old sessions")

        return count

    async def claim_orphaned_sessions(
        self,
        new_instance_id: str,
        stale_threshold: datetime,
    ) -> list[SessionInDB]:
        """Attempt to claim sessions from instances that may have died.
        
        This is called when an instance starts up to recover orphaned sessions.
        Sessions are considered orphaned if their owning instance hasn't updated
        them recently.
        
        Args:
            new_instance_id: ID of the claiming instance
            stale_threshold: Consider sessions orphaned if updated before this time
            
        Returns:
            List of claimed sessions
        """
        # Find potentially orphaned sessions
        response = (
            self._client.table(SESSIONS_TABLE)
            .select("*")
            .is_("deleted_at", "null")
            .in_("status", [
                SessionStatus.PENDING.value,
                SessionStatus.CLONING.value,
                SessionStatus.INSTALLING.value,
                SessionStatus.STARTING.value,
            ])
            .lt("updated_at", stale_threshold.isoformat())
            .execute()
        )

        claimed = []
        for row in response.data:
            session = SessionInDB.model_validate(row)
            # Mark as failed - the new instance can't recover in-progress work
            await self.update_status(
                session.id,
                SessionStatus.FAILED,
                error_message="Session orphaned due to instance failure",
            )
            claimed.append(session)

        if claimed:
            logger.warning(
                f"Marked {len(claimed)} orphaned sessions as failed",
                extra={"instance_id": new_instance_id},
            )

        return claimed


@lru_cache
def get_supabase_client() -> SupabaseClient:
    """Get cached Supabase client instance.
    
    Uses lru_cache to ensure only one client is created.
    """
    settings = get_settings()
    client = create_client(settings.supabase_url, settings.supabase_secret_key)
    return SupabaseClient(client)
