"""Security utilities for token generation and validation.

Access tokens are used to authenticate preview URL access,
preventing session enumeration and unauthorized access.
"""

import hashlib
import hmac
import secrets
import time
from typing import Literal

# Token configuration
TOKEN_BYTES = 32  # 256 bits of entropy
TOKEN_PREFIX = "spl_"  # Prefix for easy identification


def generate_access_token() -> str:
    """Generate a cryptographically secure access token.
    
    Returns:
        URL-safe access token with prefix (e.g., "spl_abc123...")
    """
    raw_token = secrets.token_urlsafe(TOKEN_BYTES)
    return f"{TOKEN_PREFIX}{raw_token}"


def validate_access_token(token: str | None) -> bool:
    """Validate access token format.
    
    This only validates the format, not whether the token exists in the database.
    Database validation should be done separately.
    
    Args:
        token: Token to validate
        
    Returns:
        True if token format is valid
    """
    if not token:
        return False
    
    if not token.startswith(TOKEN_PREFIX):
        return False
    
    # Check minimum length (prefix + base64 encoded 32 bytes)
    if len(token) < len(TOKEN_PREFIX) + 20:
        return False
    
    # Check for valid URL-safe base64 characters after prefix
    token_body = token[len(TOKEN_PREFIX):]
    valid_chars = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    if not all(c in valid_chars for c in token_body):
        return False
    
    return True


def constant_time_compare(a: str, b: str) -> bool:
    """Compare two strings in constant time to prevent timing attacks.
    
    Args:
        a: First string
        b: Second string
        
    Returns:
        True if strings are equal
    """
    return hmac.compare_digest(a.encode(), b.encode())


def sanitize_repo_identifier(owner: str, name: str) -> tuple[str, str] | None:
    """Sanitize and validate GitHub repository identifier.
    
    Args:
        owner: Repository owner (user or org)
        name: Repository name
        
    Returns:
        Tuple of (sanitized_owner, sanitized_name) or None if invalid
    """
    # GitHub username/org rules:
    # - May only contain alphanumeric characters or hyphens
    # - Cannot have multiple consecutive hyphens
    # - Cannot begin or end with a hyphen
    # - Maximum 39 characters
    
    # GitHub repo name rules:
    # - May contain alphanumeric, hyphen, underscore, period
    # - Cannot start with a period
    # - Maximum 100 characters
    
    def is_valid_owner(s: str) -> bool:
        if not s or len(s) > 39:
            return False
        if s.startswith("-") or s.endswith("-"):
            return False
        if "--" in s:
            return False
        return all(c.isalnum() or c == "-" for c in s)
    
    def is_valid_repo_name(s: str) -> bool:
        if not s or len(s) > 100:
            return False
        if s.startswith("."):
            return False
        valid_chars = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
        return all(c in valid_chars for c in s)
    
    owner = owner.strip()
    name = name.strip()
    
    if not is_valid_owner(owner) or not is_valid_repo_name(name):
        return None
    
    return (owner, name)


def sanitize_git_ref(ref: str) -> str | None:
    """Sanitize and validate a Git reference (branch, tag, or commit).
    
    Args:
        ref: Git reference to validate
        
    Returns:
        Sanitized ref or None if invalid
    """
    if not ref:
        return None
    
    ref = ref.strip()
    
    # Maximum reasonable length
    if len(ref) > 256:
        return None
    
    # Git ref rules (simplified):
    # - Cannot contain: space, ~, ^, :, ?, *, [, \, control chars
    # - Cannot start with / or .
    # - Cannot end with /
    # - Cannot contain //
    # - Cannot end with .lock
    
    forbidden_chars = set(" ~^:?*[\\\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f")
    
    if any(c in forbidden_chars for c in ref):
        return None
    
    if ref.startswith("/") or ref.startswith("."):
        return None
    
    if ref.endswith("/") or ref.endswith(".lock"):
        return None
    
    if "//" in ref:
        return None
    
    return ref


def is_safe_path_component(component: str) -> bool:
    """Check if a path component is safe (no path traversal).
    
    Args:
        component: Single path component to check
        
    Returns:
        True if safe, False if potentially dangerous
    """
    if not component:
        return False
    
    # Block path traversal
    if component in (".", "..", "~"):
        return False
    
    # Block absolute paths on Unix and Windows
    if component.startswith("/") or component.startswith("\\"):
        return False
    
    # Block null bytes
    if "\x00" in component:
        return False
    
    return True


def generate_session_id() -> str:
    """Generate a unique session identifier.
    
    Returns:
        UUID-like session ID
    """
    # Use secrets for cryptographic randomness
    return secrets.token_hex(16)  # 128 bits, 32 hex chars


def validate_api_key(provided_key: str | None, expected_key: str) -> bool:
    """Validate API key using constant-time comparison.
    
    Args:
        provided_key: API key from request header
        expected_key: Expected API key from configuration
        
    Returns:
        True if keys match, False otherwise
    """
    if not provided_key or not expected_key:
        return False
    
    return constant_time_compare(provided_key, expected_key)
