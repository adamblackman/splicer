"""HTTP and WebSocket proxy for preview routing.

Proxies traffic from the preview URL to the internal dev server port.
Handles:
- HTTP requests (with proper header forwarding)
- WebSocket connections (critical for HMR/hot reload)
- Path rewriting to strip preview prefix
- Base tag injection for proper URL resolution
"""

import asyncio
import re
from typing import AsyncIterator
from urllib.parse import urljoin

import httpx
from fastapi import Request, Response, WebSocket, WebSocketDisconnect
from starlette.responses import StreamingResponse

from src.config import get_settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

# Headers that should not be forwarded to the backend
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

# Headers that need special handling
SPECIAL_HEADERS = {
    "host",
    "content-length",
    "content-encoding",
}


class ProxyService:
    """Proxy service for forwarding requests to dev servers."""

    def __init__(self):
        """Initialize proxy service."""
        self._settings = get_settings()
        # Reusable HTTP client for proxying
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=False,  # Let the client handle redirects
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def proxy_request(
        self,
        request: Request,
        target_port: int,
        session_id: str,
        path: str = "",
    ) -> Response:
        """Proxy an HTTP request to the dev server.
        
        Args:
            request: Incoming FastAPI request
            target_port: Internal port of the dev server
            session_id: Session ID for logging
            path: Path to forward (after stripping preview prefix)
            
        Returns:
            Response from the dev server
        """
        log = get_logger(__name__, session_id=session_id)

        # Build target URL
        target_url = f"http://127.0.0.1:{target_port}/{path}"
        if request.url.query:
            target_url = f"{target_url}?{request.url.query}"

        # Prepare headers
        headers = self._prepare_request_headers(request)

        # Get request body
        body = await request.body()

        log.debug(f"Proxying {request.method} {path} -> port {target_port}")

        try:
            # Make the proxied request
            response = await self._client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

            # Prepare response headers
            response_headers = self._prepare_response_headers(response.headers)

            # Handle streaming responses (e.g., SSE)
            if self._is_streaming_response(response):
                return StreamingResponse(
                    self._stream_response(response),
                    status_code=response.status_code,
                    headers=response_headers,
                    media_type=response.headers.get("content-type"),
                )

            content = response.content
            content_type = response.headers.get("content-type", "")

            # Only rewrite HTML for path-based routing (not needed for subdomain routing)
            # Subdomain routing serves everything at root, so no path rewriting is needed
            if "text/html" in content_type and not self._settings.use_subdomain_routing:
                content = self._rewrite_html_for_proxy(content, session_id)

            return Response(
                content=content,
                status_code=response.status_code,
                headers=response_headers,
                media_type=content_type,
            )

        except httpx.ConnectError as e:
            log.warning(f"Connection error: {e}")
            return Response(
                content="Dev server is not reachable",
                status_code=502,
                media_type="text/plain",
            )

        except httpx.TimeoutException as e:
            log.warning(f"Timeout: {e}")
            return Response(
                content="Request to dev server timed out",
                status_code=504,
                media_type="text/plain",
            )

        except Exception as e:
            log.error(f"Proxy error: {e}")
            return Response(
                content="Proxy error",
                status_code=500,
                media_type="text/plain",
            )

    async def proxy_websocket(
        self,
        websocket: WebSocket,
        target_port: int,
        session_id: str,
        path: str = "",
    ) -> None:
        """Proxy a WebSocket connection to the dev server.
        
        This is critical for HMR (Hot Module Replacement) to work.
        
        Args:
            websocket: Incoming WebSocket connection
            target_port: Internal port of the dev server
            session_id: Session ID for logging
            path: Path to forward
        """
        log = get_logger(__name__, session_id=session_id)

        # Build target WebSocket URL
        target_url = f"ws://127.0.0.1:{target_port}/{path}"
        if websocket.url.query:
            target_url = f"{target_url}?{websocket.url.query}"

        log.debug(f"Proxying WebSocket -> port {target_port}/{path}")

        # Accept the incoming WebSocket
        await websocket.accept()

        try:
            # Connect to the backend WebSocket
            import websockets
            
            async with websockets.connect(
                target_url,
                extra_headers=self._prepare_ws_headers(websocket),
            ) as backend_ws:
                # Create bidirectional relay tasks
                client_to_server = asyncio.create_task(
                    self._relay_ws(websocket, backend_ws, "client->server")
                )
                server_to_client = asyncio.create_task(
                    self._relay_ws_reverse(backend_ws, websocket, "server->client")
                )

                # Wait for either direction to close
                done, pending = await asyncio.wait(
                    [client_to_server, server_to_client],
                    return_when=asyncio.FIRST_COMPLETED,
                )

                # Cancel the other task
                for task in pending:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass

        except websockets.exceptions.WebSocketException as e:
            log.warning(f"WebSocket error: {e}")
        except WebSocketDisconnect:
            log.debug("Client disconnected")
        except Exception as e:
            log.error(f"WebSocket proxy error: {e}")
        finally:
            # Ensure client websocket is closed
            try:
                await websocket.close()
            except Exception:
                pass

    async def _relay_ws(
        self,
        source: WebSocket,
        dest,  # websockets.WebSocketClientProtocol
        direction: str,
    ) -> None:
        """Relay messages from FastAPI WebSocket to websockets client.
        
        Args:
            source: FastAPI WebSocket
            dest: websockets client connection
            direction: Direction label for logging
        """
        try:
            while True:
                message = await source.receive()
                
                if message["type"] == "websocket.receive":
                    if "text" in message:
                        await dest.send(message["text"])
                    elif "bytes" in message:
                        await dest.send(message["bytes"])
                elif message["type"] == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def _relay_ws_reverse(
        self,
        source,  # websockets.WebSocketClientProtocol
        dest: WebSocket,
        direction: str,
    ) -> None:
        """Relay messages from websockets client to FastAPI WebSocket.
        
        Args:
            source: websockets client connection
            dest: FastAPI WebSocket
            direction: Direction label for logging
        """
        try:
            async for message in source:
                if isinstance(message, str):
                    await dest.send_text(message)
                elif isinstance(message, bytes):
                    await dest.send_bytes(message)
        except Exception:
            pass

    def _prepare_request_headers(self, request: Request) -> dict[str, str]:
        """Prepare headers for the proxied request.
        
        Filters out hop-by-hop headers and adjusts host.
        
        Args:
            request: Incoming request
            
        Returns:
            Headers dict for the proxied request
        """
        headers = {}

        for key, value in request.headers.items():
            key_lower = key.lower()

            # Skip hop-by-hop and special headers
            if key_lower in HOP_BY_HOP_HEADERS:
                continue
            if key_lower in SPECIAL_HEADERS:
                continue

            headers[key] = value

        # Add forwarding headers
        client_host = request.client.host if request.client else "unknown"
        headers["X-Forwarded-For"] = client_host
        headers["X-Forwarded-Proto"] = request.url.scheme
        headers["X-Forwarded-Host"] = request.headers.get("host", "")

        return headers

    def _prepare_response_headers(
        self,
        response_headers: httpx.Headers,
    ) -> dict[str, str]:
        """Prepare headers for the proxied response.
        
        Args:
            response_headers: Headers from backend response
            
        Returns:
            Filtered headers dict
        """
        headers = {}

        for key, value in response_headers.items():
            key_lower = key.lower()

            # Skip hop-by-hop headers
            if key_lower in HOP_BY_HOP_HEADERS:
                continue

            # Skip content-encoding (httpx handles decompression)
            if key_lower == "content-encoding":
                continue

            # Skip content-length (will be recalculated)
            if key_lower == "content-length":
                continue

            headers[key] = value

        # Add security headers for iframe embedding
        # Allow embedding (remove X-Frame-Options if present)
        headers.pop("x-frame-options", None)
        headers.pop("X-Frame-Options", None)

        # Set permissive CSP for preview (the preview is sandboxed anyway)
        # Don't override if backend sets it
        if "content-security-policy" not in {k.lower() for k in headers}:
            headers["Content-Security-Policy"] = "frame-ancestors *"

        return headers

    def _prepare_ws_headers(self, websocket: WebSocket) -> dict[str, str]:
        """Prepare headers for WebSocket connection to backend.
        
        Args:
            websocket: Incoming WebSocket
            
        Returns:
            Headers dict
        """
        headers = {}

        for key, value in websocket.headers.items():
            key_lower = key.lower()

            # Skip WebSocket-specific headers that will be set by the library
            if key_lower in {"upgrade", "connection", "sec-websocket-key", 
                            "sec-websocket-version", "sec-websocket-extensions"}:
                continue

            # Skip host
            if key_lower == "host":
                continue

            headers[key] = value

        return headers

    def _rewrite_html_for_proxy(self, content: bytes, session_id: str) -> bytes:
        """Rewrite HTML to fix URL resolution when proxied via path-based routing.
        
        NOTE: This is only used for path-based routing (/preview/{session_id}/...).
        When subdomain routing is enabled ({session_id}.preview.splicer.run), this
        rewriting is skipped because everything runs at root and no URL mangling is needed.
        
        Dev servers like Vite serve HTML with root-relative paths (e.g., /src/main.tsx).
        When proxied through /preview/{session_id}/, these paths break because
        the browser requests /src/main.tsx instead of /preview/{session_id}/src/main.tsx.
        
        The <base> tag doesn't help because it only affects relative URLs, not
        root-relative URLs (those starting with /).
        
        This method rewrites the HTML to:
        1. Convert root-relative URLs to include the preview path prefix
        2. Inject a <base> tag as a fallback for truly relative URLs
        
        LIMITATION: This does NOT fix JavaScript imports like `import "/src/App.tsx"`.
        JS imports resolve relative to the domain root regardless of where the script
        was loaded from. This is why subdomain routing is the preferred solution.
        
        Args:
            content: HTML content bytes
            session_id: Session ID for constructing the base path
            
        Returns:
            Modified HTML content with URLs rewritten
        """
        try:
            html = content.decode("utf-8")
        except UnicodeDecodeError:
            # Not valid UTF-8, return as-is
            return content

        prefix = self._settings.preview_path_prefix
        base_path = f"{prefix}/{session_id}"

        # Rewrite root-relative URLs in common HTML attributes
        # This handles src="/...", href="/...", etc.
        # We need to be careful not to rewrite:
        # - Protocol URLs (http://, https://, //)
        # - Data URLs (data:)
        # - Already-rewritten URLs
        
        # Pattern matches: attribute="/ but not attribute="// or attribute="/preview/
        # Handles: src, href, action, data, poster, srcset (simplified)
        
        def rewrite_url(match: re.Match) -> str:
            attr = match.group(1)  # e.g., 'src'
            quote = match.group(2)  # " or '
            path = match.group(3)  # e.g., '/src/main.tsx'
            
            # Don't rewrite if it's already our preview path
            if path.startswith(f"{prefix}/"):
                return match.group(0)
            
            # Rewrite to include the preview path
            new_path = f"{base_path}{path}"
            return f'{attr}={quote}{new_path}'

        # Match src="/path", href="/path", etc. but not src="//cdn" or src="http"
        url_pattern = r'((?:src|href|action|data|poster))=(["\'])(/(?!/)[^"\']*)'
        html = re.sub(url_pattern, rewrite_url, html, flags=re.IGNORECASE)

        # Also handle srcset which has a different format: srcset="/img1.png 1x, /img2.png 2x"
        def rewrite_srcset(match: re.Match) -> str:
            quote = match.group(1)
            srcset_value = match.group(2)
            
            def rewrite_srcset_url(url_match: re.Match) -> str:
                path = url_match.group(1)
                rest = url_match.group(2) or ""
                if path.startswith("/") and not path.startswith("//") and not path.startswith(f"{prefix}/"):
                    return f"{base_path}{path}{rest}"
                return url_match.group(0)
            
            # Match URLs in srcset (url followed by optional descriptor like 1x, 2x, 100w)
            rewritten = re.sub(r'(/[^\s,]+)(\s+[^,]*)?', rewrite_srcset_url, srcset_value)
            return f'srcset={quote}{rewritten}'

        html = re.sub(r'srcset=(["\'])([^"\']+)', rewrite_srcset, html, flags=re.IGNORECASE)

        # Inject <base> tag as fallback for any relative URLs we might have missed
        base_href = f"{base_path}/"
        base_tag = f'<base href="{base_href}">'

        if not re.search(r"<base\s+[^>]*>", html, re.IGNORECASE):
            if "<head>" in html.lower():
                html = re.sub(
                    r"(<head[^>]*>)",
                    rf"\1\n    {base_tag}",
                    html,
                    count=1,
                    flags=re.IGNORECASE,
                )
            elif "<html" in html.lower():
                html = re.sub(
                    r"(<html[^>]*>)",
                    rf"\1\n<head>\n    {base_tag}\n</head>",
                    html,
                    count=1,
                    flags=re.IGNORECASE,
                )
            else:
                html = f"{base_tag}\n{html}"

        return html.encode("utf-8")

    def _is_streaming_response(self, response: httpx.Response) -> bool:
        """Check if response should be streamed.
        
        Args:
            response: Backend response
            
        Returns:
            True if response should be streamed
        """
        content_type = response.headers.get("content-type", "")

        # Stream SSE responses
        if "text/event-stream" in content_type:
            return True

        # Stream large responses
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > 1_000_000:  # 1MB
            return True

        return False

    async def _stream_response(
        self,
        response: httpx.Response,
    ) -> AsyncIterator[bytes]:
        """Stream response content.
        
        Args:
            response: Backend response
            
        Yields:
            Response chunks
        """
        async for chunk in response.aiter_bytes():
            yield chunk


# Singleton instance
_proxy_service: ProxyService | None = None


def get_proxy_service() -> ProxyService:
    """Get proxy service singleton.
    
    Returns:
        ProxyService instance
    """
    global _proxy_service
    if _proxy_service is None:
        _proxy_service = ProxyService()
    return _proxy_service
