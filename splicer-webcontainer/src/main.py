"""FastAPI application entry point.

This is the main application that ties together:
- API routes (sessions, preview, health)
- Lifecycle management (startup, shutdown)
- Background tasks (cleanup expired/idle sessions)
- Middleware (CORS, logging)
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from src.config import get_settings
from src.api.routes import sessions_router, preview_router, health_router
from src.api.routes.health import set_ready
from src.services.session_manager import init_session_manager, get_session_manager
from src.services.proxy import get_proxy_service
from src.utils.logging import setup_logging, get_logger

# Initialize logging early
settings = get_settings()
setup_logging(
    environment=settings.environment,
    log_level="DEBUG" if settings.debug else "INFO",
)

logger = get_logger(__name__)


# Background task for cleanup
_cleanup_task: asyncio.Task | None = None


async def cleanup_loop() -> None:
    """Background task that periodically cleans up expired and idle sessions."""
    logger.info("Starting cleanup background task")

    while True:
        try:
            await asyncio.sleep(60)  # Check every minute

            manager = get_session_manager()

            # Clean up expired sessions
            expired_count = await manager.cleanup_expired_sessions()
            if expired_count > 0:
                logger.info(f"Cleaned up {expired_count} expired sessions")

            # Clean up idle sessions
            idle_count = await manager.cleanup_idle_sessions()
            if idle_count > 0:
                logger.info(f"Cleaned up {idle_count} idle sessions")

        except asyncio.CancelledError:
            logger.info("Cleanup task cancelled")
            break
        except Exception as e:
            logger.error(f"Error in cleanup loop: {e}")
            # Continue running despite errors


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager.
    
    Handles startup and shutdown logic:
    - Startup: Initialize services, recover orphaned sessions, start cleanup task
    - Shutdown: Stop all sessions, cleanup, close connections
    """
    global _cleanup_task

    logger.info(f"Starting Splicer Preview Orchestrator (instance: {settings.full_instance_id})")

    # Initialize session manager and recover orphaned sessions
    try:
        await init_session_manager()
        logger.info("Session manager initialized")
    except Exception as e:
        logger.error(f"Failed to initialize session manager: {e}")
        raise

    # Start background cleanup task
    _cleanup_task = asyncio.create_task(cleanup_loop())

    # Mark service as ready
    set_ready(True)
    logger.info("Service is ready")

    yield  # Application runs here

    # Shutdown
    logger.info("Shutting down...")
    set_ready(False)

    # Cancel cleanup task
    if _cleanup_task:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass

    # Shutdown session manager (stops all sessions, cleans up workspaces)
    try:
        manager = get_session_manager()
        await manager.shutdown()
    except Exception as e:
        logger.error(f"Error during session manager shutdown: {e}")

    # Close proxy HTTP client
    try:
        proxy = get_proxy_service()
        await proxy.close()
    except Exception as e:
        logger.error(f"Error closing proxy client: {e}")

    logger.info("Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="Splicer Preview Orchestrator",
    description="""
    Backend control plane for ephemeral GitHub repository previews.
    
    ## Features
    - Create preview sessions for GitHub repositories
    - Automatic dependency installation and dev server startup
    - Proxy preview traffic with WebSocket support for HMR
    - Session lifecycle management with timeouts
    
    ## Usage
    1. Create a session with POST /api/sessions
    2. Poll GET /api/sessions/{id} until status is "ready"
    3. Use the preview_url in an iframe
    4. Delete the session when done
    """,
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url="/redoc" if settings.environment != "production" else None,
)


# Configure CORS
# Production domains only: spliceronline.com and subdomains (HTTPS)
# Note: FastAPI CORSMiddleware doesn't support wildcard subdomains, so we list them explicitly
ALLOWED_ORIGINS = [
    "https://spliceronline.com",
    "https://www.spliceronline.com",
    "https://preview.spliceronline.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Session-ID"],
)


# Request logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all incoming requests."""
    start_time = datetime.now(timezone.utc)

    # Skip logging for health checks to reduce noise
    if request.url.path in ("/health", "/ready", "/"):
        return await call_next(request)

    response = await call_next(request)

    duration_ms = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000

    logger.info(
        f"{request.method} {request.url.path} - {response.status_code} ({duration_ms:.0f}ms)",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
        },
    )

    return response


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Handle uncaught exceptions."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)

    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "message": "An unexpected error occurred",
        },
    )


class SubdomainRoutingMiddleware:
    """Middleware that routes subdomain requests to the preview handler.
    
    When subdomain routing is enabled, requests to {session_id}.preview.splicer.run
    are rewritten to /preview/{session_id}/{path} internally.
    
    This allows Vite and other dev servers to use root-relative URLs (like /src/App.tsx)
    without any path rewriting issues.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._settings = get_settings()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        # Get host header
        headers = dict(scope.get("headers", []))
        host = headers.get(b"host", b"").decode("latin-1")

        # Try to extract session ID from subdomain
        session_id = self._settings.extract_session_from_host(host)

        if session_id:
            # Subdomain request - rewrite path internally to use preview routes
            original_path = scope.get("path", "/")
            
            # Store original info in scope for logging/debugging
            scope["subdomain_session_id"] = session_id
            scope["subdomain_original_host"] = host
            
            # Rewrite to internal preview path: /preview/{session_id}/{original_path}
            # Strip leading slash from original path to avoid double slashes
            path_suffix = original_path.lstrip("/")
            new_path = f"/preview/{session_id}/{path_suffix}"
            
            # Update scope with rewritten path
            scope = dict(scope)
            scope["path"] = new_path
            
            # Also update raw_path if present
            if "raw_path" in scope:
                scope["raw_path"] = new_path.encode("latin-1")

            logger.debug(
                f"Subdomain routing: {host}{original_path} -> {new_path}",
                extra={"session_id": session_id},
            )

        await self.app(scope, receive, send)


# Add subdomain routing middleware (must be added before routers are mounted)
if settings.use_subdomain_routing:
    app.add_middleware(SubdomainRoutingMiddleware)
    logger.info(f"Subdomain routing enabled for *.{settings.preview_domain}")


# Mount routers
app.include_router(health_router)
app.include_router(sessions_router)
app.include_router(preview_router)


# For local development
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.environment == "development",
        log_level="debug" if settings.debug else "info",
    )
