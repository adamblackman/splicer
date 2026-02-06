"""Preview proxy routes.

Handles proxying requests to the dev server for a session.

Supports two routing modes:
1. Subdomain-based (preferred): {session_id}.preview.splicer.run/{path}?token={access_token}
   - Enables Vite and other dev servers to use root-relative URLs without issues
   - Middleware rewrites these to /preview/{session_id}/{path} internally

2. Path-based (fallback): /preview/{session_id}/{path}?token={access_token}
   - Used when subdomain routing is not configured
   - Requires HTML rewriting which doesn't work for JS imports

Security:
- Access token is required and validated (via query param or cookie)
- Sessions can only be proxied by the instance that owns them
- Activity is tracked for idle timeout
- Cookie is set after initial token validation for subsequent requests
"""

from fastapi import APIRouter, Request, WebSocket, HTTPException, Query, status, Cookie
from fastapi.responses import Response, HTMLResponse

from src.config import get_settings
from src.db.models import SessionStatus
from src.services.session_manager import get_session_manager
from src.services.proxy import get_proxy_service
from src.utils.logging import get_logger
from src.utils.security import validate_access_token

router = APIRouter(tags=["preview"])
logger = get_logger(__name__)

# Cookie name for session authentication
SESSION_COOKIE_PREFIX = "spl_preview_"


def _get_session_cookie_name(session_id: str) -> str:
    """Get the cookie name for a session."""
    return f"{SESSION_COOKIE_PREFIX}{session_id[:8]}"


def _get_preview_prefix() -> str:
    """Get the preview path prefix from settings."""
    return get_settings().preview_path_prefix


def _is_subdomain_request(request: Request) -> bool:
    """Check if this request came through subdomain routing middleware."""
    return hasattr(request.scope, "get") and request.scope.get("subdomain_session_id") is not None


def _get_cookie_config(request: Request, session_id: str) -> dict:
    """Get cookie configuration based on routing mode.
    
    For subdomain routing: Cookie is set for the session's subdomain with path "/"
    For path routing: Cookie is scoped to /preview/{session_id}
    """
    settings = get_settings()
    
    if settings.use_subdomain_routing and settings.preview_domain:
        # For subdomain routing, scope cookie to the session's subdomain
        # The cookie will be sent for all requests to {session_id}.preview.splicer.run
        return {
            "path": "/",  # Root path since everything is at root for subdomain
            "domain": None,  # Let browser set domain to the subdomain automatically
        }
    else:
        # For path routing, scope cookie to the session's preview path
        return {
            "path": f"/preview/{session_id}",
            "domain": None,
        }


@router.api_route(
    "/preview/{session_id}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def proxy_http(
    request: Request,
    session_id: str,
    path: str = "",
    token: str = Query(None, description="Access token for the session"),
) -> Response:
    """Proxy HTTP requests to the dev server.
    
    All HTTP methods are supported to allow full app functionality.
    Authentication can be via query parameter token OR session cookie.
    """
    log = get_logger(__name__, session_id=session_id)

    # Try to get token from query param first, then from cookie
    cookie_name = _get_session_cookie_name(session_id)
    cookie_token = request.cookies.get(cookie_name)
    
    # Use query token if provided, otherwise fall back to cookie
    effective_token = token if token else cookie_token
    token_from_cookie = token is None and cookie_token is not None

    # Validate token format
    if not validate_access_token(effective_token):
        log.warning("Invalid or missing access token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing access token",
        )

    # Validate session access
    manager = get_session_manager()
    is_valid, session, port = await manager.validate_access(session_id, effective_token)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )

    # Check session status
    if session.status == SessionStatus.FAILED:
        return HTMLResponse(
            content=_error_page(
                "Session Failed",
                session.error_message or "The preview session failed to start.",
                session_id,
            ),
            status_code=502,
        )

    if session.status in (SessionStatus.STOPPED,):
        return HTMLResponse(
            content=_error_page(
                "Session Stopped",
                "This preview session has been stopped.",
                session_id,
            ),
            status_code=410,
        )

    if session.status != SessionStatus.READY:
        return HTMLResponse(
            content=_loading_page(session.status, session_id),
            status_code=202,
        )

    if not is_valid or port is None:
        # Session exists but is on another instance or process not running
        settings = get_settings()
        if session.container_instance != settings.full_instance_id:
            log.info(f"Session owned by different instance: {session.container_instance}")
            
            # Attempt to recover the session on this instance
            log.info("Attempting session recovery...")
            recovered, new_port = await manager.recover_session(session_id)
            
            if recovered and new_port is not None:
                log.info(f"Session recovered successfully on port {new_port}")
                port = new_port
                is_valid = True
            else:
                # Recovery failed - return a user-friendly loading page
                return HTMLResponse(
                    content=_loading_page(SessionStatus.STARTING, session_id),
                    status_code=202,
                    headers={"Refresh": "3"},  # Auto-refresh after 3 seconds
                )
        
        if not is_valid or port is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session process not available",
            )

    # Update activity for idle timeout tracking
    await manager.update_activity(session_id)

    # Proxy the request
    proxy = get_proxy_service()
    response = await proxy.proxy_request(request, port, session_id, path)

    # Set session cookie if token was provided via query param (not cookie)
    # This allows subsequent requests (JS, CSS, images) to authenticate via cookie
    if not token_from_cookie and effective_token:
        cookie_config = _get_cookie_config(request, session_id)
        response.set_cookie(
            key=cookie_name,
            value=effective_token,
            httponly=True,
            secure=True,  # Only send over HTTPS
            samesite="none",  # Required for cross-origin iframe
            path=cookie_config["path"],
            domain=cookie_config.get("domain"),
            max_age=3600,  # 1 hour expiry
        )

    return response


@router.websocket("/preview/{session_id}/{path:path}")
async def proxy_websocket(
    websocket: WebSocket,
    session_id: str,
    path: str = "",
    token: str = Query(None, description="Access token for the session"),
) -> None:
    """Proxy WebSocket connections to the dev server.
    
    This is essential for HMR (Hot Module Replacement) to work.
    Authentication can be via query parameter token OR session cookie.
    """
    log = get_logger(__name__, session_id=session_id)

    # Try to get token from query param first, then from cookie
    cookie_name = _get_session_cookie_name(session_id)
    cookie_token = websocket.cookies.get(cookie_name)
    
    # Use query token if provided, otherwise fall back to cookie
    effective_token = token if token else cookie_token

    # Validate token format
    if not validate_access_token(effective_token):
        log.warning("Invalid or missing access token for WebSocket")
        await websocket.close(code=4001, reason="Invalid access token")
        return

    # Validate session access
    manager = get_session_manager()
    is_valid, session, port = await manager.validate_access(session_id, effective_token)

    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    if session.status != SessionStatus.READY:
        await websocket.close(code=4002, reason=f"Session not ready: {session.status}")
        return

    if not is_valid or port is None:
        await websocket.close(code=4003, reason="Session not available on this instance")
        return

    # Update activity
    await manager.update_activity(session_id)

    # Proxy the WebSocket
    proxy = get_proxy_service()
    await proxy.proxy_websocket(websocket, port, session_id, path)


def _loading_page(status: SessionStatus, session_id: str) -> str:
    """Generate a loading page while session is starting.
    
    Note: status_messages are hardcoded (safe to interpolate).
    session_id is not rendered to avoid leaking internal identifiers.
    
    Args:
        status: Current session status
        session_id: Session ID (unused in HTML, kept for API compatibility)
        
    Returns:
        HTML content
    """
    status_messages = {
        SessionStatus.PENDING: "Initializing...",
        SessionStatus.CLONING: "Cloning repository...",
        SessionStatus.INSTALLING: "Installing dependencies...",
        SessionStatus.STARTING: "Starting dev server...",
    }

    # Safe: message is always from the hardcoded dict above, never user input
    message = status_messages.get(status, "Setting up...")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="3">
    <title>Loading Preview</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }}
        .container {{
            text-align: center;
            padding: 2rem;
        }}
        .spinner {{
            width: 60px;
            height: 60px;
            border: 4px solid rgba(255,255,255,0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1.5rem;
        }}
        @keyframes spin {{
            to {{ transform: rotate(360deg); }}
        }}
        h1 {{
            font-size: 1.5rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
        }}
        p {{
            opacity: 0.8;
            font-size: 0.9rem;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>Setting up your preview</h1>
        <p>{message}</p>
    </div>
</body>
</html>"""


def _error_page(title: str, message: str, session_id: str) -> str:
    """Generate a static error page.
    
    Note: title, message, and session_id are intentionally NOT rendered
    in the HTML to prevent XSS via error messages from failed processes.
    Args are kept for API compatibility with callers.
    
    Returns:
        Static HTML content
    """
    return """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Preview Unavailable</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container {
            text-align: center;
            padding: 2rem;
            max-width: 500px;
        }
        .icon {
            font-size: 4rem;
            margin-bottom: 1rem;
        }
        h1 {
            font-size: 1.5rem;
            font-weight: 500;
            margin-bottom: 0.75rem;
        }
        p {
            opacity: 0.9;
            font-size: 0.95rem;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">&#9888;&#65039;</div>
        <h1>Preview Unavailable</h1>
        <p>This preview session is no longer available. Please start a new session.</p>
    </div>
</body>
</html>"""
