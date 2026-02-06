"""Tests for API endpoints."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone, timedelta

from fastapi.testclient import TestClient


@pytest.fixture
def mock_session_manager():
    """Create a mock session manager."""
    manager = AsyncMock()
    return manager


@pytest.fixture
def client(mock_session_manager, mock_supabase_client):
    """Create test client with mocked dependencies."""
    # We need to patch before importing the app
    with patch("src.services.session_manager.get_session_manager", return_value=mock_session_manager), \
         patch("src.db.client.get_supabase_client"), \
         patch("src.services.session_manager.init_session_manager", new_callable=AsyncMock):
        
        from src.main import app
        
        with TestClient(app) as client:
            yield client


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_health_check(self, client):
        """Test /health endpoint returns 200."""
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "timestamp" in data
        assert "instance_id" in data

    def test_readiness_check_not_ready(self, client):
        """Test /ready endpoint returns 503 when not ready."""
        from src.api.routes.health import set_ready
        
        set_ready(False)
        response = client.get("/ready")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "not_ready"

    def test_readiness_check_ready(self, client):
        """Test /ready endpoint returns 200 when ready."""
        from src.api.routes.health import set_ready
        
        set_ready(True)
        response = client.get("/ready")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ready"

    def test_root_endpoint(self, client):
        """Test root endpoint returns service info."""
        response = client.get("/")
        
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "splicer-webcontainer"
        assert "version" in data


class TestSessionEndpoints:
    """Tests for session management endpoints."""

    def test_create_session_success(self, client, mock_session_manager, mock_session_data):
        """Test successful session creation."""
        from src.db.models import SessionResponse, SessionStatus
        
        # Setup mock
        session_response = SessionResponse(
            id=mock_session_data["id"],
            status=SessionStatus.PENDING,
            repo_owner="testowner",
            repo_name="testrepo",
            repo_ref="main",
            created_at=datetime.now(timezone.utc),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            error_message=None,
            preview_url=None,
        )
        mock_session_manager.create_session.return_value = session_response
        
        with patch("src.api.routes.sessions.get_session_manager", return_value=mock_session_manager):
            response = client.post(
                "/api/sessions",
                json={
                    "repo_owner": "testowner",
                    "repo_name": "testrepo",
                    "repo_ref": "main",
                },
            )
        
        assert response.status_code == 202
        data = response.json()
        assert "session" in data
        assert data["session"]["repo_owner"] == "testowner"
        assert data["session"]["repo_name"] == "testrepo"

    def test_create_session_invalid_owner(self, client):
        """Test session creation with invalid owner."""
        response = client.post(
            "/api/sessions",
            json={
                "repo_owner": "-invalid-",
                "repo_name": "testrepo",
                "repo_ref": "main",
            },
        )
        
        assert response.status_code == 400
        data = response.json()
        assert "error" in data["detail"]

    def test_create_session_invalid_ref(self, client):
        """Test session creation with invalid git ref."""
        response = client.post(
            "/api/sessions",
            json={
                "repo_owner": "testowner",
                "repo_name": "testrepo",
                "repo_ref": "invalid ref with spaces",
            },
        )
        
        assert response.status_code == 400

    def test_get_session_success(self, client, mock_session_manager, mock_session_data):
        """Test getting session status."""
        from src.db.models import SessionResponse, SessionStatus
        
        session_response = SessionResponse(
            id=mock_session_data["id"],
            status=SessionStatus.READY,
            repo_owner="testowner",
            repo_name="testrepo",
            repo_ref="main",
            created_at=datetime.now(timezone.utc),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            error_message=None,
            preview_url="http://localhost:8080/preview/test-id/?token=abc",
        )
        mock_session_manager.get_session.return_value = session_response
        
        with patch("src.api.routes.sessions.get_session_manager", return_value=mock_session_manager):
            response = client.get(f"/api/sessions/{mock_session_data['id']}")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ready"
        assert data["preview_url"] is not None

    def test_get_session_not_found(self, client, mock_session_manager):
        """Test getting non-existent session."""
        mock_session_manager.get_session.return_value = None
        
        with patch("src.api.routes.sessions.get_session_manager", return_value=mock_session_manager):
            response = client.get("/api/sessions/nonexistent-id")
        
        assert response.status_code == 404

    def test_stop_session_success(self, client, mock_session_manager):
        """Test stopping a session."""
        mock_session_manager.stop_session.return_value = True
        
        with patch("src.api.routes.sessions.get_session_manager", return_value=mock_session_manager):
            response = client.delete("/api/sessions/test-session-id")
        
        assert response.status_code == 204

    def test_stop_session_not_found(self, client, mock_session_manager):
        """Test stopping non-existent session."""
        mock_session_manager.stop_session.return_value = False
        
        with patch("src.api.routes.sessions.get_session_manager", return_value=mock_session_manager):
            response = client.delete("/api/sessions/nonexistent-id")
        
        assert response.status_code == 404


class TestPreviewEndpoints:
    """Tests for preview proxy endpoints."""

    def test_preview_missing_token(self, client):
        """Test preview access without token."""
        response = client.get("/preview/test-session/")
        
        assert response.status_code == 401

    def test_preview_invalid_token(self, client):
        """Test preview access with invalid token format."""
        response = client.get("/preview/test-session/?token=invalid")
        
        assert response.status_code == 401

    def test_preview_session_not_found(self, client, mock_session_manager):
        """Test preview access for non-existent session."""
        mock_session_manager.validate_access.return_value = (False, None, None)
        
        with patch("src.api.routes.preview.get_session_manager", return_value=mock_session_manager):
            response = client.get(
                "/preview/nonexistent/?token=spl_validtokenformat1234567890123456"
            )
        
        assert response.status_code == 404

    def test_preview_session_not_ready(self, client, mock_session_manager, mock_session_data):
        """Test preview access when session is still loading."""
        from src.db.models import SessionInDB, SessionStatus
        
        session = SessionInDB(**{**mock_session_data, "status": SessionStatus.INSTALLING.value})
        mock_session_manager.validate_access.return_value = (False, session, None)
        
        with patch("src.api.routes.preview.get_session_manager", return_value=mock_session_manager):
            response = client.get(
                f"/preview/{mock_session_data['id']}/?token=spl_validtokenformat1234567890123456"
            )
        
        # Should return loading page with 202
        assert response.status_code == 202
        assert "Installing" in response.text or "Loading" in response.text
