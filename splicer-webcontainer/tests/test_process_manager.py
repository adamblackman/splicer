"""Tests for process manager port injection."""

import pytest
from unittest.mock import patch, MagicMock


class TestInjectPortIntoCommand:
    """Tests for ProcessManager._inject_port_into_command()."""

    @pytest.fixture
    def manager(self):
        """Create a ProcessManager instance with mocked settings."""
        mock_settings = MagicMock()
        mock_settings.port_range_start = 3000
        mock_settings.port_range_end = 4000

        with patch(
            "src.services.process_manager.get_settings", return_value=mock_settings
        ):
            from src.services.process_manager import ProcessManager

            return ProcessManager()

    # Test npm run commands
    def test_npm_run_dev_injects_separator_and_flags(self, manager):
        """Test that 'npm run dev' gets -- separator before port and host flags."""
        command = ["npm", "run", "dev"]
        result = manager._inject_port_into_command(command, 3001)

        assert "--" in result, "Should have -- separator for npm run"
        separator_idx = result.index("--")
        assert "--port" in result[separator_idx:]
        assert "3001" in result[separator_idx:]
        assert "--host" in result[separator_idx:]

    def test_npm_run_start_injects_separator(self, manager):
        """Test that 'npm run start' gets -- separator."""
        command = ["npm", "run", "start"]
        result = manager._inject_port_into_command(command, 3002)

        assert result == ["npm", "run", "start", "--", "--port", "3002", "--host"]

    def test_npm_start_no_run_keyword(self, manager):
        """Test that 'npm start' (without run) gets -- separator."""
        command = ["npm", "start"]
        result = manager._inject_port_into_command(command, 3003)

        # npm start is shorthand for npm run start, still needs --
        assert "--" in result
        assert "--port" in result
        assert "--host" in result

    # Test yarn commands
    def test_yarn_dev_injects_flags_directly(self, manager):
        """Test that 'yarn dev' gets flags appended (yarn passes them through)."""
        command = ["yarn", "dev"]
        result = manager._inject_port_into_command(command, 3004)

        # Yarn automatically passes extra args to the script
        assert "--port" in result
        assert "3004" in result
        assert "--host" in result

    def test_yarn_run_dev_injects_flags(self, manager):
        """Test that 'yarn run dev' gets flags appended."""
        command = ["yarn", "run", "dev"]
        result = manager._inject_port_into_command(command, 3005)

        assert "--port" in result
        assert "3005" in result
        assert "--host" in result

    # Test pnpm commands
    def test_pnpm_dev_injects_flags(self, manager):
        """Test that 'pnpm dev' gets flags appended."""
        command = ["pnpm", "dev"]
        result = manager._inject_port_into_command(command, 3006)

        assert "--port" in result
        assert "3006" in result
        assert "--host" in result

    def test_pnpm_run_dev_injects_flags(self, manager):
        """Test that 'pnpm run dev' gets flags appended."""
        command = ["pnpm", "run", "dev"]
        result = manager._inject_port_into_command(command, 3007)

        assert "--port" in result
        assert "3007" in result
        assert "--host" in result

    # Test direct tool commands (not through package manager)
    def test_direct_vite_command(self, manager):
        """Test direct 'vite' command gets port and host."""
        command = ["vite"]
        result = manager._inject_port_into_command(command, 3008)

        assert result == ["vite", "--port", "3008", "--host"]

    def test_npx_vite_command(self, manager):
        """Test 'npx vite' command gets port and host."""
        command = ["npx", "vite"]
        result = manager._inject_port_into_command(command, 3009)

        assert "--port" in result
        assert "3009" in result
        assert "--host" in result

    def test_direct_next_dev_command(self, manager):
        """Test 'next dev' command gets port and host."""
        command = ["next", "dev"]
        result = manager._inject_port_into_command(command, 3010)

        assert "--port" in result
        assert "3010" in result
        # Next.js uses --hostname, but our generic --host should work too
        # or we might need to handle this specially

    # Test react-scripts (uses PORT env var)
    def test_react_scripts_no_port_flag(self, manager):
        """Test that react-scripts doesn't get --port flag (uses PORT env)."""
        command = ["react-scripts", "start"]
        result = manager._inject_port_into_command(command, 3011)

        # react-scripts should NOT get --port flag (it uses PORT env)
        assert "--port" not in result
        # Also shouldn't get --host (CRA respects HOST env)
        # The original command should be preserved

    def test_npx_react_scripts_no_port_flag(self, manager):
        """Test that 'npx react-scripts start' doesn't get --port flag."""
        command = ["npx", "react-scripts", "start"]
        result = manager._inject_port_into_command(command, 3012)

        assert "--port" not in result

    # Test edge cases
    def test_port_already_specified(self, manager):
        """Test that existing --port flag is preserved."""
        command = ["npm", "run", "dev", "--", "--port", "5000"]
        result = manager._inject_port_into_command(command, 3013)

        # Should not add another --port
        assert result.count("--port") == 1
        assert "5000" in result
        assert "3013" not in result

    def test_host_already_specified(self, manager):
        """Test that existing --host flag is preserved."""
        command = ["npm", "run", "dev", "--", "--host"]
        result = manager._inject_port_into_command(command, 3014)

        # Should not add another --host
        assert result.count("--host") == 1

    def test_empty_command_list(self, manager):
        """Test handling of empty command."""
        command = []
        result = manager._inject_port_into_command(command, 3015)

        # Should handle gracefully
        assert isinstance(result, list)

    def test_does_not_modify_original_command(self, manager):
        """Test that original command list is not modified."""
        command = ["npm", "run", "dev"]
        original = command.copy()

        manager._inject_port_into_command(command, 3016)

        assert command == original


class TestPortInjectionIntegration:
    """Integration tests for port injection with realistic scenarios."""

    @pytest.fixture
    def manager(self):
        """Create a ProcessManager instance."""
        mock_settings = MagicMock()
        mock_settings.port_range_start = 3000
        mock_settings.port_range_end = 4000

        with patch(
            "src.services.process_manager.get_settings", return_value=mock_settings
        ):
            from src.services.process_manager import ProcessManager

            return ProcessManager()

    def test_typical_vite_react_project(self, manager):
        """Test typical Vite + React project (npm run dev)."""
        # This is the most common case from WorkspaceManager
        command = ["npm", "run", "dev"]
        result = manager._inject_port_into_command(command, 3000)

        # Result should be: npm run dev -- --port 3000 --host
        assert result[0:3] == ["npm", "run", "dev"]
        assert "--" in result
        assert "--port" in result
        assert "--host" in result

    def test_typical_nextjs_project(self, manager):
        """Test typical Next.js project."""
        command = ["npm", "run", "dev"]
        result = manager._inject_port_into_command(command, 3000)

        # Next.js accepts --port via -- separator
        assert result[0:3] == ["npm", "run", "dev"]
        assert "--" in result
        assert "--port" in result

    def test_yarn_vite_project(self, manager):
        """Test Vite project with yarn."""
        command = ["yarn", "dev"]
        result = manager._inject_port_into_command(command, 3000)

        # Yarn passes args through directly
        assert result[0:2] == ["yarn", "dev"]
        assert "--port" in result
        assert "3000" in result
        assert "--host" in result
