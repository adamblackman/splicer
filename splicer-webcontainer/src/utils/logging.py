"""Logging configuration with Google Cloud Logging integration.

In Cloud Run, logs written to stdout/stderr are automatically captured by
Cloud Logging. This module provides structured JSON logging that integrates
well with Cloud Logging's features (severity, labels, trace context).
"""

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

# Cloud Logging severity levels
# https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
SEVERITY_MAP = {
    logging.DEBUG: "DEBUG",
    logging.INFO: "INFO",
    logging.WARNING: "WARNING",
    logging.ERROR: "ERROR",
    logging.CRITICAL: "CRITICAL",
}


class CloudLoggingFormatter(logging.Formatter):
    """JSON formatter compatible with Google Cloud Logging.
    
    Outputs structured JSON that Cloud Logging can parse for:
    - Severity levels
    - Timestamps
    - Labels and custom fields
    - Error reporting integration
    """

    def __init__(self, service_name: str = "preview-orchestrator"):
        super().__init__()
        self.service_name = service_name

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON for Cloud Logging."""
        # Base log entry
        log_entry: dict[str, Any] = {
            "severity": SEVERITY_MAP.get(record.levelno, "DEFAULT"),
            "message": record.getMessage(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "logging.googleapis.com/sourceLocation": {
                "file": record.pathname,
                "line": record.lineno,
                "function": record.funcName,
            },
        }

        # Add service context
        log_entry["serviceContext"] = {"service": self.service_name}

        # Add logger name as label
        if record.name:
            log_entry["logging.googleapis.com/labels"] = {"logger": record.name}

        # Add extra fields from the record
        if hasattr(record, "session_id"):
            log_entry["session_id"] = record.session_id
        if hasattr(record, "repo"):
            log_entry["repo"] = record.repo
        if hasattr(record, "instance_id"):
            log_entry["instance_id"] = record.instance_id

        # Add exception info if present
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)
            # Format for Error Reporting
            log_entry["@type"] = (
                "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"
            )

        # Add any extra data attached to the record
        if hasattr(record, "extra_data") and record.extra_data:
            log_entry["data"] = record.extra_data

        return json.dumps(log_entry, default=str)


class LocalFormatter(logging.Formatter):
    """Human-readable formatter for local development."""

    COLORS = {
        "DEBUG": "\033[36m",  # Cyan
        "INFO": "\033[32m",  # Green
        "WARNING": "\033[33m",  # Yellow
        "ERROR": "\033[31m",  # Red
        "CRITICAL": "\033[35m",  # Magenta
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        """Format log record with colors for terminal."""
        level_color = self.COLORS.get(record.levelname, "")
        
        # Base message
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        message = f"{level_color}{record.levelname:8}{self.RESET} {timestamp} [{record.name}] {record.getMessage()}"

        # Add session context if present
        context_parts = []
        if hasattr(record, "session_id"):
            context_parts.append(f"session={record.session_id[:8]}")
        if hasattr(record, "repo"):
            context_parts.append(f"repo={record.repo}")

        if context_parts:
            message += f" ({', '.join(context_parts)})"

        # Add exception if present
        if record.exc_info:
            message += f"\n{self.formatException(record.exc_info)}"

        return message


class SessionLoggerAdapter(logging.LoggerAdapter):
    """Logger adapter that adds session context to all log messages."""

    def process(self, msg: str, kwargs: dict) -> tuple[str, dict]:
        """Add session context to the log record."""
        extra = kwargs.get("extra", {})
        extra.update(self.extra)
        kwargs["extra"] = extra
        return msg, kwargs


def setup_logging(
    environment: str = "production",
    log_level: str = "INFO",
    service_name: str = "preview-orchestrator",
) -> None:
    """Configure logging for the application.
    
    Args:
        environment: Deployment environment (production, development, staging)
        log_level: Minimum log level to capture
        service_name: Service name for Cloud Logging context
    """
    # Get root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # Remove existing handlers
    root_logger.handlers.clear()

    # Create stdout handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG)

    # Use appropriate formatter based on environment
    if environment == "development":
        formatter = LocalFormatter()
    else:
        formatter = CloudLoggingFormatter(service_name=service_name)

    handler.setFormatter(formatter)
    root_logger.addHandler(handler)

    # Reduce noise from third-party libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(
    name: str,
    session_id: str | None = None,
    repo: str | None = None,
    instance_id: str | None = None,
) -> logging.Logger | SessionLoggerAdapter:
    """Get a logger instance, optionally with session context.
    
    Args:
        name: Logger name (typically __name__)
        session_id: Optional session ID for context
        repo: Optional repo identifier for context
        instance_id: Optional instance ID for context
    
    Returns:
        Logger or LoggerAdapter with context
    """
    logger = logging.getLogger(name)

    # If context is provided, wrap in adapter
    if session_id or repo or instance_id:
        extra = {}
        if session_id:
            extra["session_id"] = session_id
        if repo:
            extra["repo"] = repo
        if instance_id:
            extra["instance_id"] = instance_id
        return SessionLoggerAdapter(logger, extra)

    return logger
