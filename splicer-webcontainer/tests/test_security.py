"""Tests for security utilities."""

import pytest

from src.utils.security import (
    generate_access_token,
    validate_access_token,
    constant_time_compare,
    sanitize_repo_identifier,
    sanitize_git_ref,
    is_safe_path_component,
    generate_session_id,
)


class TestAccessToken:
    """Tests for access token generation and validation."""

    def test_generate_access_token_format(self):
        """Token should have correct prefix and length."""
        token = generate_access_token()
        
        assert token.startswith("spl_")
        # 32 bytes base64 encoded is ~43 chars + 4 char prefix
        assert len(token) >= 40

    def test_generate_access_token_unique(self):
        """Each generated token should be unique."""
        tokens = [generate_access_token() for _ in range(100)]
        assert len(set(tokens)) == 100

    def test_validate_access_token_valid(self):
        """Valid tokens should pass validation."""
        token = generate_access_token()
        assert validate_access_token(token) is True

    def test_validate_access_token_none(self):
        """None should fail validation."""
        assert validate_access_token(None) is False

    def test_validate_access_token_empty(self):
        """Empty string should fail validation."""
        assert validate_access_token("") is False

    def test_validate_access_token_wrong_prefix(self):
        """Token with wrong prefix should fail."""
        assert validate_access_token("wrong_abc123") is False

    def test_validate_access_token_too_short(self):
        """Too short token should fail."""
        assert validate_access_token("spl_abc") is False

    def test_validate_access_token_invalid_chars(self):
        """Token with invalid characters should fail."""
        assert validate_access_token("spl_abc!@#$%^&*()") is False


class TestConstantTimeCompare:
    """Tests for constant time string comparison."""

    def test_equal_strings(self):
        """Equal strings should return True."""
        assert constant_time_compare("abc123", "abc123") is True

    def test_unequal_strings(self):
        """Unequal strings should return False."""
        assert constant_time_compare("abc123", "abc124") is False

    def test_different_lengths(self):
        """Strings of different lengths should return False."""
        assert constant_time_compare("short", "longer string") is False

    def test_empty_strings(self):
        """Empty strings should be equal."""
        assert constant_time_compare("", "") is True


class TestSanitizeRepoIdentifier:
    """Tests for repository identifier sanitization."""

    def test_valid_owner_and_name(self):
        """Valid owner and name should pass."""
        result = sanitize_repo_identifier("octocat", "Hello-World")
        assert result == ("octocat", "Hello-World")

    def test_valid_with_numbers(self):
        """Owner and name with numbers should pass."""
        result = sanitize_repo_identifier("user123", "repo-v2")
        assert result == ("user123", "repo-v2")

    def test_owner_with_hyphen(self):
        """Owner with hyphen should pass."""
        result = sanitize_repo_identifier("my-org", "repo")
        assert result == ("my-org", "repo")

    def test_owner_starting_with_hyphen(self):
        """Owner starting with hyphen should fail."""
        result = sanitize_repo_identifier("-invalid", "repo")
        assert result is None

    def test_owner_ending_with_hyphen(self):
        """Owner ending with hyphen should fail."""
        result = sanitize_repo_identifier("invalid-", "repo")
        assert result is None

    def test_owner_double_hyphen(self):
        """Owner with double hyphen should fail."""
        result = sanitize_repo_identifier("invalid--owner", "repo")
        assert result is None

    def test_owner_too_long(self):
        """Owner over 39 characters should fail."""
        result = sanitize_repo_identifier("a" * 40, "repo")
        assert result is None

    def test_repo_name_with_dots(self):
        """Repo name with dots should pass."""
        result = sanitize_repo_identifier("owner", "my.repo.name")
        assert result == ("owner", "my.repo.name")

    def test_repo_name_starting_with_dot(self):
        """Repo name starting with dot should fail."""
        result = sanitize_repo_identifier("owner", ".hidden")
        assert result is None

    def test_repo_name_too_long(self):
        """Repo name over 100 characters should fail."""
        result = sanitize_repo_identifier("owner", "a" * 101)
        assert result is None

    def test_empty_owner(self):
        """Empty owner should fail."""
        result = sanitize_repo_identifier("", "repo")
        assert result is None

    def test_empty_name(self):
        """Empty name should fail."""
        result = sanitize_repo_identifier("owner", "")
        assert result is None

    def test_whitespace_trimmed(self):
        """Whitespace should be trimmed."""
        result = sanitize_repo_identifier("  owner  ", "  repo  ")
        assert result == ("owner", "repo")


class TestSanitizeGitRef:
    """Tests for git reference sanitization."""

    def test_valid_branch(self):
        """Valid branch name should pass."""
        assert sanitize_git_ref("main") == "main"
        assert sanitize_git_ref("develop") == "develop"
        assert sanitize_git_ref("feature/new-feature") == "feature/new-feature"

    def test_valid_tag(self):
        """Valid tag should pass."""
        assert sanitize_git_ref("v1.0.0") == "v1.0.0"

    def test_valid_commit_sha(self):
        """Valid commit SHA should pass."""
        sha = "abc123def456"
        assert sanitize_git_ref(sha) == sha

    def test_ref_with_spaces(self):
        """Ref with spaces should fail."""
        assert sanitize_git_ref("invalid ref") is None

    def test_ref_starting_with_slash(self):
        """Ref starting with slash should fail."""
        assert sanitize_git_ref("/invalid") is None

    def test_ref_starting_with_dot(self):
        """Ref starting with dot should fail."""
        assert sanitize_git_ref(".invalid") is None

    def test_ref_ending_with_slash(self):
        """Ref ending with slash should fail."""
        assert sanitize_git_ref("invalid/") is None

    def test_ref_ending_with_lock(self):
        """Ref ending with .lock should fail."""
        assert sanitize_git_ref("branch.lock") is None

    def test_ref_double_slash(self):
        """Ref with double slash should fail."""
        assert sanitize_git_ref("feature//branch") is None

    def test_empty_ref(self):
        """Empty ref should fail."""
        assert sanitize_git_ref("") is None

    def test_none_ref(self):
        """None ref should fail."""
        assert sanitize_git_ref(None) is None

    def test_ref_too_long(self):
        """Ref over 256 characters should fail."""
        assert sanitize_git_ref("a" * 257) is None


class TestIsSafePathComponent:
    """Tests for path component safety check."""

    def test_safe_components(self):
        """Safe path components should pass."""
        assert is_safe_path_component("file.txt") is True
        assert is_safe_path_component("my-folder") is True
        assert is_safe_path_component("123") is True

    def test_dot_traversal(self):
        """Dot traversal should fail."""
        assert is_safe_path_component(".") is False
        assert is_safe_path_component("..") is False

    def test_tilde(self):
        """Tilde (home directory) should fail."""
        assert is_safe_path_component("~") is False

    def test_absolute_path(self):
        """Absolute paths should fail."""
        assert is_safe_path_component("/etc") is False
        assert is_safe_path_component("\\windows") is False

    def test_null_byte(self):
        """Null bytes should fail."""
        assert is_safe_path_component("file\x00.txt") is False

    def test_empty(self):
        """Empty string should fail."""
        assert is_safe_path_component("") is False


class TestGenerateSessionId:
    """Tests for session ID generation."""

    def test_format(self):
        """Session ID should be 32 hex characters."""
        session_id = generate_session_id()
        assert len(session_id) == 32
        assert all(c in "0123456789abcdef" for c in session_id)

    def test_unique(self):
        """Each session ID should be unique."""
        ids = [generate_session_id() for _ in range(100)]
        assert len(set(ids)) == 100
