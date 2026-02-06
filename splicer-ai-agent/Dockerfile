# Dockerfile for Splicer Agent on Cloud Run
# Custom FastAPI server with Postgres checkpointing
#
# Uses GitHub's Remote MCP Server (HTTP transport) for serverless compatibility.
# No local github-mcp-server binary required.

FROM python:3.12-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install system dependencies required for some Python packages
# Note: curl removed - no longer needed since we use GitHub's Remote MCP Server (HTTP transport)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# GitHub MCP Server binary is NOT needed - we use GitHub's Remote MCP Server
# via HTTP transport at https://api.githubcopilot.com/mcp/
# This is the recommended approach for serverless environments (Cloud Run, Lambda, etc.)

# Install uv for fast dependency management
RUN pip install uv

# Copy ALL project files needed for installation
# (pyproject.toml references agent/ and components/ as packages)
COPY pyproject.toml ./
COPY uv.lock ./
COPY README.md ./
COPY agent/ ./agent/
COPY components/ ./components/
COPY server.py ./

# Install dependencies (now that all package directories exist)
RUN uv pip install --system .

# Cloud Run sets PORT environment variable, default to 8080 (Cloud Run default)
ENV PORT=8080

# Expose the port (Cloud Run ignores this, uses PORT env var)
EXPOSE 8080

# Health check endpoint (custom server provides /ok)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${PORT}/ok')" || exit 1

# Run the custom FastAPI server with uvicorn
# This server implements LangGraph API endpoints with Postgres checkpointing
CMD ["sh", "-c", "python -m uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
