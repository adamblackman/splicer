"""Process manager for dev server lifecycle.

Handles starting, monitoring, and stopping Node.js dev server processes.
Each session gets its own process running on a unique port.
"""

import asyncio
import os
import signal
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx
import psutil

from src.config import get_settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ProcessInfo:
    """Information about a running process."""

    pid: int
    port: int
    session_id: str
    command: list[str]
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    process: asyncio.subprocess.Process | None = None


class PortAllocator:
    """Thread-safe port allocator for dev servers."""

    def __init__(self, start: int, end: int):
        """Initialize port allocator.
        
        Args:
            start: Start of port range (inclusive)
            end: End of port range (inclusive)
        """
        self._start = start
        self._end = end
        self._allocated: set[int] = set()
        self._lock = asyncio.Lock()

    async def allocate(self) -> int | None:
        """Allocate an available port.
        
        Returns:
            Available port number or None if all ports are in use
        """
        async with self._lock:
            for port in range(self._start, self._end + 1):
                if port not in self._allocated and not self._is_port_in_use(port):
                    self._allocated.add(port)
                    return port
        return None

    async def release(self, port: int) -> None:
        """Release an allocated port.
        
        Args:
            port: Port number to release
        """
        async with self._lock:
            self._allocated.discard(port)

    def _is_port_in_use(self, port: int) -> bool:
        """Check if a port is in use by any process.
        
        Args:
            port: Port number to check
            
        Returns:
            True if port is in use
        """
        try:
            for conn in psutil.net_connections(kind="inet"):
                if conn.laddr.port == port:
                    return True
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            pass
        return False


class ProcessManager:
    """Manages dev server processes for preview sessions.
    
    Responsibilities:
    - Allocate unique ports for each session
    - Start dev server processes
    - Monitor process health
    - Wait for server readiness
    - Graceful and forced shutdown
    """

    def __init__(self):
        """Initialize process manager."""
        self._settings = get_settings()
        self._port_allocator = PortAllocator(
            self._settings.port_range_start,
            self._settings.port_range_end,
        )
        self._processes: dict[str, ProcessInfo] = {}
        self._lock = asyncio.Lock()

    async def start_process(
        self,
        session_id: str,
        workspace_path: Path,
        command: list[str],
        framework: str | None = None,
        on_ready: Callable[[int], None] | None = None,
    ) -> ProcessInfo:
        """Start a dev server process.
        
        Args:
            session_id: Session identifier
            workspace_path: Path to workspace directory
            command: Command to execute
            framework: Detected framework (vite, nextjs, etc.) for base path injection
            on_ready: Optional callback when server is ready
            
        Returns:
            ProcessInfo for the started process
            
        Raises:
            RuntimeError: If no ports available or process fails to start
        """
        log = get_logger(__name__, session_id=session_id)

        # Allocate a port
        port = await self._port_allocator.allocate()
        if port is None:
            raise RuntimeError("No available ports for dev server")

        log.info(f"Starting dev server on port {port}")

        # Prepare environment
        env = self._get_process_env(workspace_path, port, session_id)

        # Modify command to use allocated port and base path if needed
        modified_command = self._inject_server_flags(command, port, session_id, framework)

        try:
            # Start the process
            process = await asyncio.create_subprocess_exec(
                *modified_command,
                cwd=str(workspace_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                start_new_session=True,  # Create new process group for clean shutdown
            )

            process_info = ProcessInfo(
                pid=process.pid,
                port=port,
                session_id=session_id,
                command=modified_command,
                process=process,
            )

            async with self._lock:
                self._processes[session_id] = process_info

            log.info(f"Process started with PID {process.pid}")

            # Start background task to monitor process output
            asyncio.create_task(self._stream_output(session_id, process))

            return process_info

        except Exception as e:
            # Release the port if process failed to start
            await self._port_allocator.release(port)
            raise RuntimeError(f"Failed to start process: {e}")

    async def wait_for_ready(
        self,
        session_id: str,
        timeout: float | None = None,
    ) -> bool:
        """Wait for dev server to become ready (responding to HTTP requests).
        
        Args:
            session_id: Session identifier
            timeout: Maximum time to wait (defaults to startup timeout)
            
        Returns:
            True if server is ready, False if timeout or process died
        """
        log = get_logger(__name__, session_id=session_id)

        if timeout is None:
            timeout = float(self._settings.session_startup_timeout)

        process_info = self._processes.get(session_id)
        if not process_info:
            return False

        port = process_info.port
        url = f"http://127.0.0.1:{port}/"

        start_time = asyncio.get_event_loop().time()
        check_interval = 0.5  # Start with 500ms
        max_interval = 5.0  # Max 5 seconds between checks

        async with httpx.AsyncClient(timeout=5.0) as client:
            while asyncio.get_event_loop().time() - start_time < timeout:
                # Check if process is still running
                if process_info.process and process_info.process.returncode is not None:
                    log.error(f"Process died with code {process_info.process.returncode}")
                    return False

                try:
                    response = await client.get(url)
                    # Any response (even error pages) means server is up
                    if response.status_code < 500:
                        log.info(f"Server ready (status {response.status_code})")
                        return True
                except (httpx.ConnectError, httpx.ConnectTimeout):
                    # Server not ready yet
                    pass
                except Exception as e:
                    log.debug(f"Health check error: {e}")

                # Exponential backoff
                await asyncio.sleep(check_interval)
                check_interval = min(check_interval * 1.5, max_interval)

        log.error(f"Server failed to become ready within {timeout}s")
        return False

    async def stop_process(
        self,
        session_id: str,
        graceful_timeout: float = 10.0,
    ) -> bool:
        """Stop a dev server process.
        
        Attempts graceful shutdown first (SIGTERM), then forces (SIGKILL).
        
        Args:
            session_id: Session identifier
            graceful_timeout: Time to wait for graceful shutdown
            
        Returns:
            True if process was stopped, False if not found
        """
        log = get_logger(__name__, session_id=session_id)

        async with self._lock:
            process_info = self._processes.pop(session_id, None)

        if not process_info:
            return False

        port = process_info.port
        process = process_info.process

        try:
            if process and process.returncode is None:
                log.info(f"Stopping process {process_info.pid}")

                # Try graceful shutdown first
                try:
                    # Send SIGTERM to the process group
                    os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass

                try:
                    await asyncio.wait_for(process.wait(), timeout=graceful_timeout)
                    log.info("Process terminated gracefully")
                except asyncio.TimeoutError:
                    # Force kill
                    log.warning("Graceful shutdown timeout, forcing kill")
                    try:
                        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass

                    try:
                        await asyncio.wait_for(process.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        log.error("Failed to kill process")

        finally:
            # Always release the port
            await self._port_allocator.release(port)

        return True

    async def get_process_info(self, session_id: str) -> ProcessInfo | None:
        """Get information about a running process.
        
        Args:
            session_id: Session identifier
            
        Returns:
            ProcessInfo or None if not found
        """
        return self._processes.get(session_id)

    async def is_process_alive(self, session_id: str) -> bool:
        """Check if a process is still running.
        
        Args:
            session_id: Session identifier
            
        Returns:
            True if process is running
        """
        process_info = self._processes.get(session_id)
        if not process_info or not process_info.process:
            return False

        return process_info.process.returncode is None

    async def stop_all_processes(self) -> int:
        """Stop all running processes (used during shutdown).
        
        Returns:
            Number of processes stopped
        """
        session_ids = list(self._processes.keys())
        count = 0

        for session_id in session_ids:
            if await self.stop_process(session_id, graceful_timeout=5.0):
                count += 1

        logger.info(f"Stopped {count} processes")
        return count

    async def _stream_output(
        self,
        session_id: str,
        process: asyncio.subprocess.Process,
    ) -> None:
        """Stream process output to logs.
        
        Args:
            session_id: Session identifier
            process: Process to stream from
        """
        log = get_logger(__name__, session_id=session_id)

        async def read_stream(stream, level: str):
            while True:
                line = await stream.readline()
                if not line:
                    break
                decoded = line.decode().rstrip()
                if level == "stdout":
                    log.debug(f"[stdout] {decoded}")
                else:
                    log.debug(f"[stderr] {decoded}")

        try:
            await asyncio.gather(
                read_stream(process.stdout, "stdout"),
                read_stream(process.stderr, "stderr"),
            )
        except Exception as e:
            log.debug(f"Output streaming ended: {e}")

    def _get_process_env(
        self,
        workspace_path: Path,
        port: int,
        session_id: str,
    ) -> dict[str, str]:
        """Get environment variables for the dev server process.
        
        Args:
            workspace_path: Path to workspace
            port: Allocated port number
            session_id: Session identifier for base path
            
        Returns:
            Environment dictionary
        """
        env = os.environ.copy()

        # Set port via common environment variables
        env["PORT"] = str(port)
        env["DEV_PORT"] = str(port)

        # Vite-specific
        env["VITE_PORT"] = str(port)
        
        # Check if subdomain routing is enabled
        use_subdomain = self._settings.use_subdomain_routing and self._settings.preview_domain
        
        if use_subdomain:
            # With subdomain routing, everything runs at root - no base path needed
            # The session is identified by subdomain: {session_id}.preview.domain.com
            preview_host = f"{session_id}.{self._settings.preview_domain}"
            
            # Configure Vite HMR to connect through the subdomain
            # These are used by our injected vite config or client-side detection
            env["VITE_HMR_PROTOCOL"] = "wss"
            env["VITE_HMR_HOST"] = preview_host
            env["VITE_HMR_PORT"] = "443"
            env["VITE_HMR_CLIENT_PORT"] = "443"
            
            # No base path needed for subdomain routing
            env["BASE_PATH"] = "/"
            env["PUBLIC_URL"] = "/"
        else:
            # Path-based routing: /preview/{session_id}/
            base_path = f"/preview/{session_id}/"
            
            # Base path environment variables for various frameworks
            env["BASE_PATH"] = base_path
            env["PUBLIC_URL"] = base_path  # Create React App (only works in build, not dev)
            env["ASSET_PREFIX"] = base_path  # Next.js (partial support)
            
            # Vite HMR configuration for path-based routing
            env["VITE_HMR_PROTOCOL"] = "wss"
            env["VITE_HMR_HOST"] = ""  # Let Vite auto-detect
        
        # Tell Vite we're behind a proxy
        env["VITE_CJS_IGNORE_WARNING"] = "true"

        # Ensure node_modules/.bin is in PATH
        node_bin = workspace_path / "node_modules" / ".bin"
        if "PATH" in env:
            env["PATH"] = f"{node_bin}:{env['PATH']}"

        # Disable browser auto-open
        env["BROWSER"] = "none"

        # Set host to allow external connections (within container)
        env["HOST"] = "0.0.0.0"

        # Disable update checks
        env["NO_UPDATE_NOTIFIER"] = "1"

        return env

    def _inject_server_flags(
        self,
        command: list[str],
        port: int,
        session_id: str,
        framework: str | None,
    ) -> list[str]:
        """Inject port and host flags into command for dev server.
        
        Handles package manager commands (npm, yarn, pnpm) that run scripts,
        ensuring flags are passed correctly to the underlying dev server.
        
        With subdomain routing enabled, no base path injection is needed since
        each session gets its own subdomain and runs at root.
        
        Args:
            command: Original command
            port: Port number
            session_id: Session identifier
            framework: Detected framework (vite, react, etc.)
            
        Returns:
            Modified command with port and host flags
        """
        if not command:
            return command
            
        modified = list(command)

        # Check if react-scripts (uses PORT/HOST env vars, not flags)
        is_react_scripts = any("react-scripts" in arg for arg in modified)
        if is_react_scripts:
            # react-scripts uses PORT and HOST environment variables
            # which are already set in _get_process_env()
            return modified

        # Check existing flags
        port_flags = ["--port", "-p", "-P"]
        has_port = any(flag in modified for flag in port_flags)
        
        host_flags = ["--host", "-H", "--hostname"]
        has_host = any(flag in modified for flag in host_flags)

        # Detect package manager run commands
        # npm requires "--" separator to pass args to scripts
        # yarn and pnpm pass args through directly
        is_npm_run = (
            len(modified) >= 3 
            and modified[0] == "npm" 
            and modified[1] == "run"
        )
        is_npm_start = (
            len(modified) >= 2 
            and modified[0] == "npm" 
            and modified[1] == "start"
        )
        is_yarn = len(modified) >= 2 and modified[0] == "yarn"
        is_pnpm = len(modified) >= 2 and modified[0] == "pnpm"

        # Build flags to add
        flags_to_add = []
        
        if not has_port:
            flags_to_add.extend(["--port", str(port)])
        
        if not has_host:
            # Always add --host for web dev servers to bind to 0.0.0.0
            # This is required for external access (e.g., in containers)
            flags_to_add.append("--host")

        # Note: We do NOT inject --base flag
        # - With subdomain routing: Not needed, everything runs at root
        # - With path routing: Causes redirect loops (proxy strips prefix)
        # URL resolution is handled by proxy HTML rewriting for path-based routing

        if not flags_to_add:
            return modified

        # For npm, insert "--" separator before flags if not present
        if is_npm_run or is_npm_start:
            if "--" not in modified:
                modified.append("--")
            modified.extend(flags_to_add)
        elif is_yarn or is_pnpm:
            # yarn and pnpm pass extra args directly to scripts
            modified.extend(flags_to_add)
        else:
            # Direct command (vite, next, etc.) or npx
            modified.extend(flags_to_add)

        return modified


def get_process_manager() -> ProcessManager:
    """Get process manager instance."""
    return ProcessManager()
