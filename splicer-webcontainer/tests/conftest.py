"""Pytest configuration and fixtures."""

import asyncio
import os
import tempfile
from pathlib import Path
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient

# Set test environment variables before importing app modules
os.environ["ENVIRONMENT"] = "development"
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ["SUPABASE_SECRET_KEY"] = "test-secret-key-not-real"
os.environ["WORKSPACE_BASE_DIR"] = tempfile.mkdtemp()


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def temp_workspace() -> Generator[Path, None, None]:
    """Create a temporary workspace directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def mock_supabase_client() -> MagicMock:
    """Create a mock Supabase client."""
    mock_client = MagicMock()
    
    # Mock table operations
    mock_table = MagicMock()
    mock_client.table.return_value = mock_table
    
    # Mock common operations
    mock_table.insert.return_value = mock_table
    mock_table.select.return_value = mock_table
    mock_table.update.return_value = mock_table
    mock_table.delete.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.is_.return_value = mock_table
    mock_table.in_.return_value = mock_table
    mock_table.lt.return_value = mock_table
    mock_table.not_.return_value = mock_table
    mock_table.limit.return_value = mock_table
    
    return mock_client


@pytest.fixture
def mock_session_data() -> dict:
    """Create mock session data."""
    from datetime import datetime, timezone, timedelta
    
    now = datetime.now(timezone.utc)
    
    return {
        "id": "test-session-id-12345678",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "last_activity_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=1)).isoformat(),
        "deleted_at": None,
        "repo_owner": "testowner",
        "repo_name": "testrepo",
        "repo_ref": "main",
        "status": "pending",
        "error_message": None,
        "internal_port": None,
        "container_instance": "test-instance",
        "access_token": "spl_test-access-token-12345678901234567890",
    }


@pytest.fixture
def sample_package_json() -> dict:
    """Sample package.json for testing."""
    return {
        "name": "test-app",
        "version": "1.0.0",
        "scripts": {
            "dev": "vite",
            "build": "vite build",
            "preview": "vite preview",
        },
        "dependencies": {
            "react": "^18.2.0",
            "react-dom": "^18.2.0",
        },
        "devDependencies": {
            "vite": "^5.0.0",
            "@vitejs/plugin-react": "^4.0.0",
        },
    }


@pytest.fixture
def mock_settings():
    """Create mock settings."""
    from src.config import Settings
    
    return Settings(
        port=8080,
        environment="development",
        supabase_url="https://test.supabase.co",
        supabase_secret_key="test-secret-key",
        workspace_base_dir="/tmp/test-workspaces",
        session_idle_timeout=600,
        session_max_lifetime=3600,
        session_startup_timeout=180,
        port_range_start=3000,
        port_range_end=4000,
    )
