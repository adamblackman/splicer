# syntax=docker/dockerfile:1

# =============================================================================
# Splicer Webcontainer
# Multi-stage build optimized for Google Cloud Run
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build stage - install dependencies
# -----------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# -----------------------------------------------------------------------------
# Stage 2: Runtime stage - minimal production image
# -----------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# Security: Run as non-root user
RUN groupadd --gid 1000 appgroup \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home appuser

WORKDIR /app

# Install runtime dependencies required for workspace operations
# - git: Clone repositories
# - nodejs + npm: Run Node.js dev servers
# - curl: Health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm yarn \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY --chown=appuser:appgroup src/ ./src/

# Create workspace directory with appropriate permissions
RUN mkdir -p /tmp/workspaces && chown -R appuser:appgroup /tmp/workspaces

# Switch to non-root user
USER appuser

# Environment variables (defaults, overridden by Cloud Run)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    WORKSPACE_BASE_DIR=/tmp/workspaces \
    # Timeout configurations (seconds)
    SESSION_IDLE_TIMEOUT=600 \
    SESSION_MAX_LIFETIME=3600 \
    SESSION_STARTUP_TIMEOUT=180

# Expose port (Cloud Run uses PORT env var)
EXPOSE 8080

# Health check for local development (Cloud Run uses its own)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Run the application
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
