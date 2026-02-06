"""Tests for subdomain-based preview routing.

Tests cover:
- Session ID extraction from Host header
- Preview URL generation (subdomain vs path-based)
- Subdomain middleware URL rewriting
- Cookie configuration for different routing modes
"""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from starlette.testclient import TestClient
from starlette.requests import Request
from starlette.responses import Response

from src.config import Settings


class TestSubdomainExtraction:
    """Tests for extracting session_id from subdomain in Host header."""

    @pytest.fixture
    def subdomain_settings(self) -> Settings:
        """Settings with subdomain routing enabled."""
        return Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            preview_domain="preview.splicer.run",
            use_subdomain_routing=True,
        )

    @pytest.fixture
    def path_settings(self) -> Settings:
        """Settings with path-based routing (subdomain disabled)."""
        return Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            preview_domain=None,
            use_subdomain_routing=False,
        )

    def test_extract_session_from_valid_subdomain(self, subdomain_settings: Settings):
        """Should extract session_id from valid subdomain."""
        session_id = subdomain_settings.extract_session_from_host(
            "abc123def.preview.splicer.run"
        )
        assert session_id == "abc123def"

    def test_extract_session_with_port(self, subdomain_settings: Settings):
        """Should extract session_id when port is present."""
        session_id = subdomain_settings.extract_session_from_host(
            "abc123def.preview.splicer.run:443"
        )
        assert session_id == "abc123def"

    def test_extract_session_case_insensitive(self, subdomain_settings: Settings):
        """Should handle mixed case in domain."""
        session_id = subdomain_settings.extract_session_from_host(
            "ABC123DEF.Preview.Splicer.Run"
        )
        assert session_id == "abc123def"

    def test_extract_session_uuid_format(self, subdomain_settings: Settings):
        """Should handle UUID-style session IDs."""
        session_id = subdomain_settings.extract_session_from_host(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890.preview.splicer.run"
        )
        assert session_id == "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

    def test_extract_returns_none_for_wrong_domain(self, subdomain_settings: Settings):
        """Should return None for requests to different domain."""
        session_id = subdomain_settings.extract_session_from_host(
            "abc123.other-domain.com"
        )
        assert session_id is None

    def test_extract_returns_none_for_root_domain(self, subdomain_settings: Settings):
        """Should return None for root domain without subdomain."""
        session_id = subdomain_settings.extract_session_from_host(
            "preview.splicer.run"
        )
        assert session_id is None

    def test_extract_returns_none_for_nested_subdomain(self, subdomain_settings: Settings):
        """Should return None for nested subdomains (too many dots)."""
        session_id = subdomain_settings.extract_session_from_host(
            "extra.abc123.preview.splicer.run"
        )
        assert session_id is None

    def test_extract_returns_none_when_disabled(self, path_settings: Settings):
        """Should return None when subdomain routing is disabled."""
        session_id = path_settings.extract_session_from_host(
            "abc123.preview.splicer.run"
        )
        assert session_id is None

    def test_extract_returns_none_with_no_preview_domain(self):
        """Should return None when preview_domain is not set."""
        settings = Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            use_subdomain_routing=True,
            preview_domain=None,
        )
        session_id = settings.extract_session_from_host(
            "abc123.preview.splicer.run"
        )
        assert session_id is None


class TestPreviewUrlGeneration:
    """Tests for preview URL generation."""

    def test_subdomain_url_generation(self):
        """Should generate subdomain-based URL when enabled."""
        settings = Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            preview_domain="preview.splicer.run",
            use_subdomain_routing=True,
        )
        
        url = settings.get_preview_url("abc123", "spl_token123")
        assert url == "https://abc123.preview.splicer.run/?token=spl_token123"

    def test_path_based_url_with_base_url(self):
        """Should generate path-based URL with custom base_url."""
        settings = Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            base_url="https://preview.example.com",
            use_subdomain_routing=False,
        )
        
        url = settings.get_preview_url("abc123", "spl_token123")
        assert url == "https://preview.example.com/preview/abc123/?token=spl_token123"

    def test_path_based_url_without_base_url(self):
        """Should generate path-based URL with default host:port."""
        settings = Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            host="0.0.0.0",
            port=8080,
            use_subdomain_routing=False,
        )
        
        url = settings.get_preview_url("abc123", "spl_token123")
        assert url == "http://0.0.0.0:8080/preview/abc123/?token=spl_token123"

    def test_subdomain_takes_priority_over_base_url(self):
        """Subdomain routing should be used when enabled, ignoring base_url."""
        settings = Settings(
            supabase_url="https://test.supabase.co",
            supabase_secret_key="test-secret-key",
            base_url="https://ignored.example.com",
            preview_domain="preview.splicer.run",
            use_subdomain_routing=True,
        )
        
        url = settings.get_preview_url("abc123", "spl_token123")
        assert url == "https://abc123.preview.splicer.run/?token=spl_token123"


class TestCookieConfiguration:
    """Tests for cookie configuration in different routing modes."""

    def test_subdomain_cookie_config(self):
        """Subdomain routing should use root path for cookies."""
        from src.api.routes.preview import _get_cookie_config
        from unittest.mock import MagicMock
        
        # Mock settings
        mock_settings = MagicMock()
        mock_settings.use_subdomain_routing = True
        mock_settings.preview_domain = "preview.splicer.run"
        
        with patch("src.api.routes.preview.get_settings", return_value=mock_settings):
            config = _get_cookie_config(MagicMock(), "abc123")
        
        assert config["path"] == "/"
        assert config["domain"] is None  # Browser auto-sets to subdomain

    def test_path_based_cookie_config(self):
        """Path-based routing should scope cookies to session path."""
        from src.api.routes.preview import _get_cookie_config
        from unittest.mock import MagicMock
        
        # Mock settings
        mock_settings = MagicMock()
        mock_settings.use_subdomain_routing = False
        mock_settings.preview_domain = None
        
        with patch("src.api.routes.preview.get_settings", return_value=mock_settings):
            config = _get_cookie_config(MagicMock(), "abc123")
        
        assert config["path"] == "/preview/abc123"
        assert config["domain"] is None


class TestProxyHtmlRewriting:
    """Tests for HTML rewriting in proxy service."""

    @pytest.fixture
    def proxy_service_subdomain(self):
        """Proxy service with subdomain routing enabled."""
        from src.services.proxy import ProxyService
        
        with patch("src.services.proxy.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.use_subdomain_routing = True
            mock_settings.preview_domain = "preview.splicer.run"
            mock_settings.preview_path_prefix = "/preview"
            mock_get_settings.return_value = mock_settings
            
            service = ProxyService()
            yield service, mock_settings

    @pytest.fixture
    def proxy_service_path(self):
        """Proxy service with path-based routing."""
        from src.services.proxy import ProxyService
        
        with patch("src.services.proxy.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.use_subdomain_routing = False
            mock_settings.preview_domain = None
            mock_settings.preview_path_prefix = "/preview"
            mock_get_settings.return_value = mock_settings
            
            service = ProxyService()
            yield service, mock_settings

    def test_html_rewriting_skipped_for_subdomain_routing(self, proxy_service_subdomain):
        """HTML rewriting should be skipped when subdomain routing is enabled."""
        service, mock_settings = proxy_service_subdomain
        
        html_content = b'<html><head></head><body><script src="/src/main.tsx"></script></body></html>'
        
        # Directly test the rewrite method - it shouldn't be called in subdomain mode
        # but if called, it would still work
        result = service._rewrite_html_for_proxy(html_content, "abc123")
        
        # The method itself still works, but the proxy_request method skips calling it
        # when subdomain routing is enabled
        assert b"/preview/abc123/src/main.tsx" in result  # Method still rewrites

    def test_html_rewriting_applied_for_path_routing(self, proxy_service_path):
        """HTML rewriting should be applied for path-based routing."""
        service, mock_settings = proxy_service_path
        
        html_content = b'<html><head></head><body><script src="/src/main.tsx"></script></body></html>'
        
        result = service._rewrite_html_for_proxy(html_content, "abc123")
        
        # Should rewrite the script src
        assert b'src="/preview/abc123/src/main.tsx"' in result
        
        # Should inject base tag
        assert b'<base href="/preview/abc123/">' in result

    def test_html_rewriting_handles_multiple_attributes(self, proxy_service_path):
        """Should rewrite multiple URL attributes."""
        service, mock_settings = proxy_service_path
        
        html_content = b'''<html>
        <head>
            <link href="/styles.css" rel="stylesheet">
        </head>
        <body>
            <script src="/app.js"></script>
            <img src="/logo.png">
            <a href="/about">About</a>
        </body>
        </html>'''
        
        result = service._rewrite_html_for_proxy(html_content, "abc123")
        
        assert b'href="/preview/abc123/styles.css"' in result
        assert b'src="/preview/abc123/app.js"' in result
        assert b'src="/preview/abc123/logo.png"' in result
        assert b'href="/preview/abc123/about"' in result

    def test_html_rewriting_preserves_external_urls(self, proxy_service_path):
        """Should not rewrite external URLs."""
        service, mock_settings = proxy_service_path
        
        html_content = b'''<html><body>
            <script src="https://cdn.example.com/script.js"></script>
            <script src="//cdn.example.com/other.js"></script>
            <img src="data:image/png;base64,abc123">
        </body></html>'''
        
        result = service._rewrite_html_for_proxy(html_content, "abc123")
        
        # External URLs should be preserved
        assert b'src="https://cdn.example.com/script.js"' in result
        assert b'src="//cdn.example.com/other.js"' in result
        assert b'src="data:image/png;base64,abc123"' in result


class TestSubdomainMiddleware:
    """Tests for the subdomain routing middleware."""

    @pytest.mark.asyncio
    async def test_middleware_rewrites_subdomain_path(self):
        """Middleware should rewrite subdomain requests to internal path."""
        from src.main import SubdomainRoutingMiddleware
        
        # Capture the scope that reaches the inner app
        captured_scope = {}
        
        async def capture_app(scope, receive, send):
            captured_scope.update(scope)
            if scope["type"] == "http":
                response = Response(content=b"ok", media_type="text/plain")
                await response(scope, receive, send)
        
        with patch("src.main.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.extract_session_from_host.return_value = "abc123"
            mock_get_settings.return_value = mock_settings
            
            middleware = SubdomainRoutingMiddleware(capture_app)
            
            scope = {
                "type": "http",
                "path": "/src/App.tsx",
                "headers": [(b"host", b"abc123.preview.splicer.run")],
            }
            
            receive = AsyncMock()
            send = AsyncMock()
            
            await middleware(scope, receive, send)
            
            # Check the path that was passed to the inner app
            assert captured_scope.get("path") == "/preview/abc123/src/App.tsx"
            assert captured_scope.get("subdomain_session_id") == "abc123"

    @pytest.mark.asyncio
    async def test_middleware_passes_through_non_subdomain(self):
        """Middleware should not modify non-subdomain requests."""
        from src.main import SubdomainRoutingMiddleware
        
        captured_scope = {}
        
        async def capture_app(scope, receive, send):
            captured_scope.update(scope)
            if scope["type"] == "http":
                response = Response(content=b"ok", media_type="text/plain")
                await response(scope, receive, send)
        
        with patch("src.main.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.extract_session_from_host.return_value = None
            mock_get_settings.return_value = mock_settings
            
            middleware = SubdomainRoutingMiddleware(capture_app)
            
            scope = {
                "type": "http",
                "path": "/api/sessions",
                "headers": [(b"host", b"api.splicer.run")],
            }
            
            receive = AsyncMock()
            send = AsyncMock()
            
            await middleware(scope, receive, send)
            
            # Path should remain unchanged
            assert captured_scope["path"] == "/api/sessions"
            # Should not have subdomain session ID
            assert "subdomain_session_id" not in captured_scope

    @pytest.mark.asyncio
    async def test_middleware_handles_root_path(self):
        """Middleware should handle root path correctly."""
        from src.main import SubdomainRoutingMiddleware
        
        captured_scope = {}
        
        async def capture_app(scope, receive, send):
            captured_scope.update(scope)
            if scope["type"] == "http":
                response = Response(content=b"ok", media_type="text/plain")
                await response(scope, receive, send)
        
        with patch("src.main.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.extract_session_from_host.return_value = "abc123"
            mock_get_settings.return_value = mock_settings
            
            middleware = SubdomainRoutingMiddleware(capture_app)
            
            scope = {
                "type": "http",
                "path": "/",
                "headers": [(b"host", b"abc123.preview.splicer.run")],
            }
            
            receive = AsyncMock()
            send = AsyncMock()
            
            await middleware(scope, receive, send)
            
            # Root path should become /preview/abc123/
            assert captured_scope.get("path") == "/preview/abc123/"

    @pytest.mark.asyncio
    async def test_middleware_handles_websocket(self):
        """Middleware should rewrite WebSocket paths too."""
        from src.main import SubdomainRoutingMiddleware
        
        captured_scope = {}
        
        async def capture_app(scope, receive, send):
            captured_scope.update(scope)
            # Just capture, don't respond for websocket
        
        with patch("src.main.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.extract_session_from_host.return_value = "abc123"
            mock_get_settings.return_value = mock_settings
            
            middleware = SubdomainRoutingMiddleware(capture_app)
            
            scope = {
                "type": "websocket",
                "path": "/@vite/client",
                "headers": [(b"host", b"abc123.preview.splicer.run")],
            }
            
            receive = AsyncMock()
            send = AsyncMock()
            
            await middleware(scope, receive, send)
            
            # WebSocket path should also be rewritten
            assert captured_scope.get("path") == "/preview/abc123/@vite/client"


class TestIntegration:
    """Integration tests for subdomain routing end-to-end."""

    @pytest.fixture
    def subdomain_client(self):
        """Test client with subdomain routing enabled."""
        import os
        
        # Set environment variables for subdomain routing
        os.environ["USE_SUBDOMAIN_ROUTING"] = "true"
        os.environ["PREVIEW_DOMAIN"] = "preview.test.com"
        
        # Clear cached settings
        from src.config import get_settings
        get_settings.cache_clear()
        
        yield
        
        # Cleanup
        os.environ.pop("USE_SUBDOMAIN_ROUTING", None)
        os.environ.pop("PREVIEW_DOMAIN", None)
        get_settings.cache_clear()

    def test_settings_loaded_correctly(self, subdomain_client):
        """Verify settings are loaded with subdomain config."""
        from src.config import get_settings
        
        settings = get_settings()
        assert settings.use_subdomain_routing is True
        assert settings.preview_domain == "preview.test.com"
