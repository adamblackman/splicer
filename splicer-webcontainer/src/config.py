"""Application configuration using Pydantic Settings.

All configuration is loaded from environment variables.
Secrets should be injected via Cloud Run secrets, not stored in code.
"""

import secrets
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=None,  # Don't load .env files in production
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ==========================================================================
    # Server Configuration
    # ==========================================================================
    port: int = Field(default=8080, description="HTTP server port")
    host: str = Field(default="0.0.0.0", description="HTTP server host")
    environment: Literal["development", "staging", "production"] = Field(
        default="production", description="Deployment environment"
    )
    debug: bool = Field(default=False, description="Enable debug mode")

    # Instance identification for multi-instance coordination
    # Cloud Run provides K_REVISION, we generate a unique suffix per instance
    k_revision: str = Field(default="local", description="Cloud Run revision name")
    instance_id: str = Field(
        default_factory=lambda: secrets.token_hex(8),
        description="Unique instance identifier",
    )

    @property
    def full_instance_id(self) -> str:
        """Full instance identifier combining revision and unique ID."""
        return f"{self.k_revision}-{self.instance_id}"

    # ==========================================================================
    # API Security
    # ==========================================================================
    cloud_run_webcontainer_secret: str = Field(
        ..., description="Shared secret for authenticating requests from Edge Functions"
    )

    # ==========================================================================
    # Supabase Configuration
    # ==========================================================================
    supabase_url: str = Field(..., description="Supabase project URL")
    supabase_secret_key: str = Field(
        ..., description="Supabase secret API key (not publishable)"
    )

    @field_validator("supabase_secret_key")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        """Warn if using publishable key instead of secret key."""
        if v.startswith("eyJ") and "anon" in v.lower():
            raise ValueError(
                "Use SUPABASE_SECRET_KEY (service role), not the publishable/anon key"
            )
        return v

    # ==========================================================================
    # GitHub Configuration
    # ==========================================================================
    # Note: GitHub authentication is now handled per-session via github_token
    # passed in the CreateSessionRequest. No static PAT or App credentials needed.

    # ==========================================================================
    # Workspace Configuration
    # ==========================================================================
    workspace_base_dir: str = Field(
        default="/tmp/workspaces",
        description="Base directory for session workspaces",
    )

    # ==========================================================================
    # Session Timeouts (seconds)
    # ==========================================================================
    session_idle_timeout: int = Field(
        default=600,  # 10 minutes
        ge=60,
        le=3600,
        description="Session idle timeout (no preview traffic)",
    )
    session_max_lifetime: int = Field(
        default=3600,  # 60 minutes
        ge=300,
        le=7200,
        description="Maximum session lifetime",
    )
    session_startup_timeout: int = Field(
        default=180,  # 3 minutes
        ge=30,
        le=600,
        description="Timeout for app to become ready",
    )

    # ==========================================================================
    # Port Allocation
    # ==========================================================================
    port_range_start: int = Field(
        default=3000,
        ge=1024,
        le=65000,
        description="Start of port range for dev servers",
    )
    port_range_end: int = Field(
        default=4000,
        ge=1025,
        le=65535,
        description="End of port range for dev servers",
    )

    @field_validator("port_range_end")
    @classmethod
    def validate_port_range(cls, v: int, info) -> int:
        """Ensure port range end is greater than start."""
        if "port_range_start" in info.data and v <= info.data["port_range_start"]:
            raise ValueError("port_range_end must be greater than port_range_start")
        return v

    # ==========================================================================
    # Resource Limits
    # ==========================================================================
    max_concurrent_sessions: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum concurrent sessions per instance",
    )
    max_log_size_bytes: int = Field(
        default=1_000_000,  # 1MB
        ge=10_000,
        description="Maximum log size to retain per session",
    )

    # ==========================================================================
    # Preview URL Configuration
    # ==========================================================================
    base_url: str | None = Field(
        default=None,
        description="Base URL for preview links (e.g., https://preview.example.com)",
    )
    preview_path_prefix: str = Field(
        default="/preview",
        description="Path prefix for preview routes (used for fallback path-based routing)",
    )
    
    # Subdomain-based preview configuration
    preview_domain: str | None = Field(
        default=None,
        description="Domain for subdomain-based previews (e.g., preview.splicer.run)",
    )
    use_subdomain_routing: bool = Field(
        default=False,
        description="Enable subdomain-based routing ({session_id}.preview.splicer.run)",
    )

    def get_preview_url(self, session_id: str, access_token: str) -> str:
        """Generate the preview URL for a session.
        
        When subdomain routing is enabled:
            https://{session_id}.preview.splicer.run/?token={access_token}
        
        When using path-based routing (fallback):
            https://preview.example.com/preview/{session_id}/?token={access_token}
        """
        if self.use_subdomain_routing and self.preview_domain:
            # Subdomain-based URL: {session_id}.{preview_domain}
            return f"https://{session_id}.{self.preview_domain}/?token={access_token}"
        
        # Fallback to path-based routing
        base = self.base_url or f"http://{self.host}:{self.port}"
        return f"{base}{self.preview_path_prefix}/{session_id}/?token={access_token}"
    
    def extract_session_from_host(self, host: str) -> str | None:
        """Extract session ID from subdomain in Host header.
        
        Args:
            host: Host header value (e.g., 'abc123.preview.splicer.run' or 'abc123.preview.splicer.run:443')
            
        Returns:
            Session ID if subdomain routing is enabled and host matches, None otherwise
        """
        if not self.use_subdomain_routing or not self.preview_domain:
            return None
        
        # Remove port if present
        host = host.split(":")[0].lower()
        preview_domain = self.preview_domain.lower()
        
        # Check if host ends with .{preview_domain}
        expected_suffix = f".{preview_domain}"
        if not host.endswith(expected_suffix):
            return None
        
        # Extract subdomain (session_id)
        session_id = host[: -len(expected_suffix)]
        
        # Validate it looks like a session ID (not empty, no dots)
        if not session_id or "." in session_id:
            return None
        
        return session_id

    # ==========================================================================
    # Google Cloud Configuration
    # ==========================================================================
    google_cloud_project: str | None = Field(
        default=None, alias="GOOGLE_CLOUD_PROJECT", description="GCP project ID"
    )
    enable_cloud_logging: bool = Field(
        default=True, description="Enable Google Cloud Logging integration"
    )


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings.
    
    Uses lru_cache to ensure settings are only loaded once.
    """
    return Settings()
