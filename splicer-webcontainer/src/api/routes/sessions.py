"""Session management API endpoints.

Provides endpoints to:
- Create a new preview session
- Get session status
- Stop/cleanup a session
- List active sessions
"""

from fastapi import APIRouter, HTTPException, status, Header, Depends
from pydantic import BaseModel, Field

from src.config import get_settings
from src.db.models import (
    CreateSessionRequest,
    SessionResponse,
    SessionStatus,
    ErrorResponse,
)
from src.services.session_manager import get_session_manager
from src.utils.logging import get_logger
from src.utils.security import sanitize_repo_identifier, sanitize_git_ref, validate_api_key

logger = get_logger(__name__)


async def verify_api_key(x_api_key: str | None = Header(None)) -> None:
    """Dependency to verify API key for all session endpoints.
    
    Validates the X-API-Key header against CLOUD_RUN_WEBCONTAINER_SECRET.
    Raises HTTPException 401 if invalid or missing.
    """
    settings = get_settings()
    
    if not validate_api_key(x_api_key, settings.cloud_run_webcontainer_secret):
        logger.warning("Invalid or missing API key in request")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "unauthorized",
                "message": "Invalid or missing API key",
            },
        )


# Apply API key verification to all routes in this router
router = APIRouter(
    prefix="/api/sessions",
    tags=["sessions"],
    dependencies=[Depends(verify_api_key)],
)


class CreateSessionResponse(BaseModel):
    """Response for session creation."""

    session: SessionResponse
    message: str = "Session created. Setup in progress."


@router.post(
    "",
    response_model=CreateSessionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Create a new preview session",
    description="""
    Creates a new preview session for a GitHub repository.
    
    **Session Reuse:** By default, if an active session already exists for the 
    same repository and branch, it will be returned instead of creating a new one.
    Use `force_new=true` to always create a fresh session.
    
    The session will go through these states:
    1. `pending` - Session created, setup starting
    2. `cloning` - Cloning the repository
    3. `installing` - Installing dependencies
    4. `starting` - Starting the dev server
    5. `ready` - Preview is accessible (includes preview_url)
    
    If setup fails, status will be `failed` with an error message.
    
    The response includes a session ID that can be used to:
    - Poll for status updates
    - Access the preview once ready
    - Stop the session
    """,
    responses={
        202: {"description": "Session created, setup in progress"},
        200: {"description": "Existing session reused"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        503: {"model": ErrorResponse, "description": "Service unavailable"},
    },
)
async def create_session(request: CreateSessionRequest) -> CreateSessionResponse:
    """Create a new preview session or reuse an existing one."""
    # Validate and sanitize inputs
    sanitized = sanitize_repo_identifier(request.repo_owner, request.repo_name)
    if not sanitized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_repository",
                "message": "Invalid repository owner or name",
            },
        )

    owner, name = sanitized

    ref = sanitize_git_ref(request.repo_ref)
    if not ref:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_ref",
                "message": "Invalid git reference",
            },
        )

    action = "Creating" if request.force_new else "Finding or creating"
    logger.info(f"{action} session for {owner}/{name}@{ref}")

    try:
        manager = get_session_manager()
        session = await manager.create_session(
            owner,
            name,
            ref,
            github_token=request.github_token,
            force_new=request.force_new,
        )

        # Determine message based on whether we reused or created
        message = "Session created. Setup in progress."
        if session.status.value == "ready":
            message = "Existing session reused."
        elif session.status.value not in ("pending",):
            message = "Existing session found. Setup in progress."

        return CreateSessionResponse(session=session, message=message)

    except Exception as e:
        logger.error(f"Failed to create session: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "session_creation_failed",
                "message": "Failed to create session. Please try again.",
            },
        )


@router.get(
    "/{session_id}",
    response_model=SessionResponse,
    summary="Get session status",
    description="""
    Returns the current status of a preview session.
    
    When status is `ready`, the response includes `preview_url` that can be
    used to access the preview (e.g., in an iframe).
    
    Poll this endpoint to track setup progress.
    """,
    responses={
        200: {"description": "Session found"},
        404: {"model": ErrorResponse, "description": "Session not found"},
    },
)
async def get_session(session_id: str) -> SessionResponse:
    """Get session status and details."""
    manager = get_session_manager()
    session = await manager.get_session(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "session_not_found",
                "message": f"Session {session_id} not found",
            },
        )

    return session


@router.delete(
    "/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Stop and cleanup a session",
    description="""
    Stops a running session and cleans up all resources:
    - Terminates the dev server process
    - Removes the workspace directory
    - Marks the session as stopped in the database
    
    This operation is idempotent - calling it on an already stopped session
    will return success.
    """,
    responses={
        204: {"description": "Session stopped"},
        404: {"model": ErrorResponse, "description": "Session not found"},
    },
)
async def stop_session(session_id: str) -> None:
    """Stop and cleanup a session."""
    manager = get_session_manager()
    success = await manager.stop_session(session_id)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "session_not_found",
                "message": f"Session {session_id} not found",
            },
        )


class SessionListResponse(BaseModel):
    """Response for listing sessions."""

    sessions: list[SessionResponse]
    count: int = Field(description="Number of sessions returned")


@router.get(
    "",
    response_model=SessionListResponse,
    summary="List active sessions",
    description="""
    Returns a list of active sessions (not stopped or deleted).
    
    Primarily useful for debugging and monitoring.
    """,
    responses={
        200: {"description": "Sessions list"},
    },
)
async def list_sessions() -> SessionListResponse:
    """List active sessions."""
    from src.config import get_settings
    from src.db import get_supabase_client

    settings = get_settings()
    db = get_supabase_client()

    # Only list sessions for this instance (for safety)
    sessions_db = await db.list_active_sessions(
        instance_id=settings.full_instance_id,
        limit=50,
    )

    sessions = []
    for s in sessions_db:
        preview_url = None
        if s.status == SessionStatus.READY:
            preview_url = settings.get_preview_url(s.id, s.access_token)
        sessions.append(SessionResponse.from_db(s, preview_url))

    return SessionListResponse(
        sessions=sessions,
        count=len(sessions),
    )
