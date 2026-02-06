"""Tests for workspace manager."""

import json
import pytest
from pathlib import Path

from src.services.workspace_manager import WorkspaceManager, PackageInfo


class TestWorkspaceManager:
    """Tests for WorkspaceManager."""

    @pytest.fixture
    def manager(self, temp_workspace: Path) -> WorkspaceManager:
        """Create a workspace manager with temp directory."""
        from unittest.mock import patch, MagicMock
        
        mock_settings = MagicMock()
        mock_settings.workspace_base_dir = str(temp_workspace)
        
        with patch("src.services.workspace_manager.get_settings", return_value=mock_settings):
            return WorkspaceManager()

    @pytest.mark.asyncio
    async def test_create_workspace(self, manager: WorkspaceManager):
        """Test workspace creation."""
        session_id = "test-session-123"
        
        path = await manager.create_workspace(session_id)
        
        assert path.exists()
        assert path.is_dir()
        assert session_id in str(path)

    @pytest.mark.asyncio
    async def test_create_workspace_invalid_id(self, manager: WorkspaceManager):
        """Test that invalid session IDs are rejected."""
        with pytest.raises(ValueError):
            await manager.create_workspace("../invalid")

        with pytest.raises(ValueError):
            await manager.create_workspace("test/../path")

    @pytest.mark.asyncio
    async def test_cleanup_workspace(self, manager: WorkspaceManager):
        """Test workspace cleanup."""
        session_id = "test-session-456"
        
        path = await manager.create_workspace(session_id)
        assert path.exists()
        
        # Add some files
        (path / "test.txt").write_text("test content")
        (path / "subdir").mkdir()
        (path / "subdir" / "nested.txt").write_text("nested")
        
        result = await manager.cleanup_workspace(session_id)
        
        assert result is True
        assert not path.exists()

    @pytest.mark.asyncio
    async def test_cleanup_nonexistent_workspace(self, manager: WorkspaceManager):
        """Test cleanup of non-existent workspace returns False."""
        result = await manager.cleanup_workspace("nonexistent-session")
        assert result is False

    @pytest.mark.asyncio
    async def test_detect_package_manager_npm(
        self,
        manager: WorkspaceManager,
        temp_workspace: Path,
    ):
        """Test detection of npm as package manager."""
        # Create package.json and package-lock.json
        package_json = {
            "name": "test",
            "scripts": {"dev": "vite"},
            "dependencies": {"react": "^18.0.0"},
        }
        (temp_workspace / "package.json").write_text(json.dumps(package_json))
        (temp_workspace / "package-lock.json").write_text("{}")
        
        result = await manager.detect_package_manager(temp_workspace)
        
        assert result is not None
        assert result.manager == "npm"
        assert result.lockfile == "package-lock.json"
        assert "dev" in result.scripts

    @pytest.mark.asyncio
    async def test_detect_package_manager_yarn(
        self,
        manager: WorkspaceManager,
        temp_workspace: Path,
    ):
        """Test detection of yarn as package manager."""
        package_json = {"name": "test", "scripts": {}}
        (temp_workspace / "package.json").write_text(json.dumps(package_json))
        (temp_workspace / "yarn.lock").write_text("")
        
        result = await manager.detect_package_manager(temp_workspace)
        
        assert result is not None
        assert result.manager == "yarn"
        assert result.lockfile == "yarn.lock"

    @pytest.mark.asyncio
    async def test_detect_package_manager_pnpm(
        self,
        manager: WorkspaceManager,
        temp_workspace: Path,
    ):
        """Test detection of pnpm as package manager."""
        package_json = {"name": "test", "scripts": {}}
        (temp_workspace / "package.json").write_text(json.dumps(package_json))
        (temp_workspace / "pnpm-lock.yaml").write_text("")
        
        result = await manager.detect_package_manager(temp_workspace)
        
        assert result is not None
        assert result.manager == "pnpm"
        assert result.lockfile == "pnpm-lock.yaml"

    @pytest.mark.asyncio
    async def test_detect_package_manager_no_package_json(
        self,
        manager: WorkspaceManager,
        temp_workspace: Path,
    ):
        """Test that None is returned when no package.json exists."""
        result = await manager.detect_package_manager(temp_workspace)
        assert result is None

    @pytest.mark.asyncio
    async def test_detect_framework_react(self, manager: WorkspaceManager):
        """Test detection of React framework."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "vite"},
            dependencies={"react": "^18.0.0", "react-dom": "^18.0.0"},
            dev_dependencies={"vite": "^5.0.0"},
        )
        
        result = await manager.detect_framework(package_info)
        assert result == "react"

    @pytest.mark.asyncio
    async def test_detect_framework_nextjs(self, manager: WorkspaceManager):
        """Test detection of Next.js framework."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "next dev"},
            dependencies={"next": "^14.0.0", "react": "^18.0.0"},
            dev_dependencies={},
        )
        
        result = await manager.detect_framework(package_info)
        assert result == "nextjs"

    @pytest.mark.asyncio
    async def test_detect_framework_vue(self, manager: WorkspaceManager):
        """Test detection of Vue framework."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "vite"},
            dependencies={"vue": "^3.0.0"},
            dev_dependencies={"vite": "^5.0.0"},
        )
        
        result = await manager.detect_framework(package_info)
        assert result == "vue"

    @pytest.mark.asyncio
    async def test_detect_framework_vite_only(self, manager: WorkspaceManager):
        """Test detection of Vite (no framework)."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "vite"},
            dependencies={},
            dev_dependencies={"vite": "^5.0.0"},
        )
        
        result = await manager.detect_framework(package_info)
        assert result == "vite"


class TestStartCommand:
    """Tests for start command determination."""

    @pytest.fixture
    def manager(self, temp_workspace: Path) -> WorkspaceManager:
        """Create a workspace manager."""
        from unittest.mock import patch, MagicMock
        
        mock_settings = MagicMock()
        mock_settings.workspace_base_dir = str(temp_workspace)
        
        with patch("src.services.workspace_manager.get_settings", return_value=mock_settings):
            return WorkspaceManager()

    def test_dev_script_npm(self, manager: WorkspaceManager):
        """Test that 'dev' script is preferred with npm."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "vite", "start": "node server.js"},
            dependencies={},
            dev_dependencies={},
        )
        
        result = manager._get_start_command(package_info, None)
        assert result == ["npm", "run", "dev"]

    def test_dev_script_yarn(self, manager: WorkspaceManager):
        """Test that 'dev' script is preferred with yarn."""
        package_info = PackageInfo(
            manager="yarn",
            lockfile="yarn.lock",
            scripts={"dev": "vite"},
            dependencies={},
            dev_dependencies={},
        )
        
        result = manager._get_start_command(package_info, None)
        assert result == ["yarn", "dev"]

    def test_start_script_fallback(self, manager: WorkspaceManager):
        """Test fallback to 'start' script."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"start": "react-scripts start"},
            dependencies={},
            dev_dependencies={},
        )
        
        result = manager._get_start_command(package_info, None)
        assert result == ["npm", "run", "start"]

    def test_nextjs_prefers_dev(self, manager: WorkspaceManager):
        """Test that Next.js prefers 'dev' over 'start'."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={"dev": "next dev", "start": "next start"},
            dependencies={},
            dev_dependencies={},
        )
        
        result = manager._get_start_command(package_info, "nextjs")
        assert result == ["npm", "run", "dev"]

    def test_vite_framework_fallback(self, manager: WorkspaceManager):
        """Test fallback to npx vite for Vite projects without scripts."""
        package_info = PackageInfo(
            manager="npm",
            lockfile="package-lock.json",
            scripts={},
            dependencies={},
            dev_dependencies={},
        )
        
        result = manager._get_start_command(package_info, "vite")
        assert result == ["npx", "vite", "--host"]
