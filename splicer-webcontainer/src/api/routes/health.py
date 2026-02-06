"""Health and readiness endpoints for Cloud Run.

Cloud Run uses these endpoints to determine:
- Liveness: Is the container running?
- Readiness: Is the container ready to serve traffic?
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Response
from pydantic import BaseModel

from src.config import get_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    timestamp: str
    instance_id: str
    version: str = "0.1.0"


class ReadinessResponse(BaseModel):
    """Readiness check response."""

    status: str
    timestamp: str
    checks: dict[str, bool]


# Track readiness state
_ready = False


def set_ready(ready: bool) -> None:
    """Set the readiness state.
    
    Called by the application lifecycle hooks.
    
    Args:
        ready: Whether the service is ready
    """
    global _ready
    _ready = ready


def is_ready() -> bool:
    """Check if the service is ready.
    
    Returns:
        True if ready
    """
    return _ready


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness check",
    description="Returns 200 if the service is alive. Used by Cloud Run for liveness probes.",
)
async def health_check() -> HealthResponse:
    """Liveness check endpoint.
    
    Always returns 200 if the server is running.
    """
    settings = get_settings()

    return HealthResponse(
        status="healthy",
        timestamp=datetime.now(timezone.utc).isoformat(),
        instance_id=settings.full_instance_id,
    )


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Readiness check",
    description="Returns 200 if the service is ready to serve traffic. Used by Cloud Run for readiness probes.",
)
async def readiness_check(response: Response) -> ReadinessResponse:
    """Readiness check endpoint.
    
    Returns 200 if all dependencies are connected and the service is ready.
    Returns 503 if not ready.
    """
    checks = {
        "initialized": _ready,
    }

    all_ready = all(checks.values())

    if not all_ready:
        response.status_code = 503

    return ReadinessResponse(
        status="ready" if all_ready else "not_ready",
        timestamp=datetime.now(timezone.utc).isoformat(),
        checks=checks,
    )


@router.get(
    "/",
    include_in_schema=False,
)
async def root() -> dict:
    """Root endpoint - basic info.
    
    Useful for verifying the service is deployed.
    """
    settings = get_settings()

    return {
        "service": "splicer-webcontainer",
        "version": "0.1.0",
        "instance": settings.full_instance_id,
    }
