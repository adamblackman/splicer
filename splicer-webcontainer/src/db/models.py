"""Pydantic models for database entities and API schemas.

These models define the shape of data at different layers:
- SessionCreate: Input for creating a new session
- SessionUpdate: Partial update fields
- SessionInDB: Full database record (internal use only)
- SessionResponse: API response (safe to expose to clients)
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, ConfigDict, computed_field


class SessionStatus(str, Enum):
    """Session lifecycle states."""

    PENDING = "pending"  # Session created, workspace not yet set up
    CLONING = "cloning"  # Cloning repository
    INSTALLING = "installing"  # Installing dependencies
    STARTING = "starting"  # Starting dev server
    READY = "ready"  # Dev server is reachable
    FAILED = "failed"  # Setup failed, check error_message
    STOPPED = "stopped"  # Manually stopped or timed out


class SessionCreate(BaseModel):
    """Schema for creating a new preview session."""

    repo_owner: str = Field(
        ...,
        min_length=1,
        max_length=39,
        description="GitHub repository owner (user or organization)",
    )
    repo_name: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="GitHub repository name",
    )
    repo_ref: str = Field(
        default="main",
        min_length=1,
        max_length=256,
        description="Git reference (branch, tag, or commit SHA)",
    )

    @computed_field
    @property
    def repo_full_name(self) -> str:
        """Full repository name (owner/name)."""
        return f"{self.repo_owner}/{self.repo_name}"


class SessionUpdate(BaseModel):
    """Schema for updating session fields.
    
    All fields are optional - only provided fields are updated.
    """

    status: SessionStatus | None = None
    error_message: str | None = None
    internal_port: int | None = None
    container_instance: str | None = None
    last_activity_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")


class SessionInDB(BaseModel):
    """Full session record from database.
    
    This model includes internal fields that should NOT be exposed to clients.
    """

    model_config = ConfigDict(from_attributes=True)

    # Primary key
    id: str = Field(..., description="Session UUID")

    # Timestamps
    created_at: datetime
    updated_at: datetime
    last_activity_at: datetime
    expires_at: datetime
    deleted_at: datetime | None = None

    # Repository info
    repo_owner: str
    repo_name: str
    repo_ref: str

    # State
    status: SessionStatus
    error_message: str | None = None

    # Internal fields (NOT for client exposure)
    internal_port: int | None = None
    container_instance: str | None = None

    # Security
    access_token: str

    @computed_field
    @property
    def repo_full_name(self) -> str:
        """Full repository name."""
        return f"{self.repo_owner}/{self.repo_name}"

    @computed_field
    @property
    def is_active(self) -> bool:
        """Check if session is in an active state."""
        return self.status in (
            SessionStatus.PENDING,
            SessionStatus.CLONING,
            SessionStatus.INSTALLING,
            SessionStatus.STARTING,
            SessionStatus.READY,
        )

    @computed_field
    @property
    def is_expired(self) -> bool:
        """Check if session has exceeded its lifetime."""
        return datetime.now(self.expires_at.tzinfo) > self.expires_at


class SessionResponse(BaseModel):
    """Session response for API clients.
    
    This model ONLY includes fields safe to expose externally.
    Internal fields (ports, paths, instance IDs) are excluded.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(..., description="Session identifier")
    status: SessionStatus = Field(..., description="Current session status")
    
    # Repository info
    repo_owner: str = Field(..., description="Repository owner")
    repo_name: str = Field(..., description="Repository name")
    repo_ref: str = Field(..., description="Git reference")

    # Timestamps
    created_at: datetime = Field(..., description="Session creation time")
    expires_at: datetime = Field(..., description="Session expiration time")

    # Error info (if failed)
    error_message: str | None = Field(None, description="Error message if status is 'failed'")

    # Preview URL (computed based on settings)
    preview_url: str | None = Field(None, description="URL to access the preview")

    @classmethod
    def from_db(
        cls,
        session: SessionInDB,
        preview_url: str | None = None,
    ) -> "SessionResponse":
        """Create response from database record.
        
        Args:
            session: Database session record
            preview_url: Computed preview URL (requires settings)
        """
        return cls(
            id=session.id,
            status=session.status,
            repo_owner=session.repo_owner,
            repo_name=session.repo_name,
            repo_ref=session.repo_ref,
            created_at=session.created_at,
            expires_at=session.expires_at,
            error_message=session.error_message,
            preview_url=preview_url if session.status == SessionStatus.READY else None,
        )


class SessionListResponse(BaseModel):
    """Response for listing multiple sessions."""

    sessions: list[SessionResponse]
    total: int = Field(..., description="Total number of sessions (before pagination)")


class CreateSessionRequest(BaseModel):
    """API request to create a new session."""

    repo_owner: str = Field(
        ...,
        min_length=1,
        max_length=39,
        pattern=r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$",
        description="GitHub repository owner",
        examples=["octocat", "my-org"],
    )
    repo_name: str = Field(
        ...,
        min_length=1,
        max_length=100,
        pattern=r"^[a-zA-Z0-9._-]+$",
        description="GitHub repository name",
        examples=["my-app", "vite-project"],
    )
    repo_ref: str = Field(
        default="main",
        min_length=1,
        max_length=256,
        description="Git branch, tag, or commit SHA",
        examples=["main", "develop", "v1.0.0", "abc1234"],
    )
    github_token: str | None = Field(
        default=None,
        description="GitHub installation access token for private repos",
    )
    force_new: bool = Field(
        default=False,
        description="Force creation of a new session even if one exists for this repo/ref. "
                    "Set to True when you want a fresh environment (e.g., after code changes).",
    )


class SessionLogsResponse(BaseModel):
    """Response containing session logs."""

    session_id: str
    status: SessionStatus
    logs: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Log entries from Cloud Logging",
    )
    has_more: bool = Field(
        default=False,
        description="Whether more logs are available",
    )


class ErrorResponse(BaseModel):
    """Standard error response."""

    error: str = Field(..., description="Error type/code")
    message: str = Field(..., description="Human-readable error message")
    details: dict[str, Any] | None = Field(None, description="Additional error details")
