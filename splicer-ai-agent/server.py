"""
Custom FastAPI server for Splicer Agent.

Implements LangGraph API-compatible endpoints with Postgres checkpointing.
Replaces `langgraph dev` to enable persistent checkpointing without a license.

Endpoints:
    - POST /runs/stream: Stream agent execution with SSE (requires Bearer JWT)
    - POST /threads/{thread_id}/runs/{run_id}/cancel: Cancel a running execution
    - GET /ok: Health check endpoint

Security:
    - /runs/stream requires a Bearer JWT issued by the Edge Function
    - JWT contains github_token, thread_id, and user sub
    - CORS configured for specific frontend origins only
"""
import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from agent.graph import compile_graph

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============ Configuration ============

# JWT Configuration
JWT_SECRET_ENV = "CLOUD_RUN_STREAM_SECRET"
JWT_ALGORITHM = "HS256"
JWT_ISSUER = "supabase-edge"
JWT_AUDIENCE = "splicer-cloudrun"

# CORS Configuration - production domains only (HTTPS)
# spliceronline.com and subdomains
ALLOWED_ORIGINS = [
    "https://spliceronline.com",
    "https://www.spliceronline.com",
    "https://preview.spliceronline.com",
]


def get_jwt_secret() -> str | None:
    """Get the JWT secret for stream token verification."""
    return os.environ.get(JWT_SECRET_ENV)


def get_db_uri() -> str | None:
    """Get the Supabase PostgreSQL connection URI from environment."""
    uri = os.environ.get("POSTGRES_URI_CUSTOM")
    if not uri:
        return None
    
    # Ensure sslmode=require for Supabase connections
    if "sslmode=" not in uri:
        separator = "&" if "?" in uri else "?"
        uri = f"{uri}{separator}sslmode=require"
    
    return uri


def verify_stream_token(authorization: str | None) -> dict[str, Any]:
    """
    Verify the Bearer JWT token from the Authorization header.
    
    Args:
        authorization: The Authorization header value (e.g., "Bearer <token>")
        
    Returns:
        The decoded JWT payload containing github_token, thread_id, sub
        
    Raises:
        HTTPException: If token is missing, invalid, or expired
    """
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Missing Authorization header"}
        )
    
    # Extract Bearer token
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Invalid Authorization header format. Expected: Bearer <token>"}
        )
    
    token = parts[1]
    
    # Get secret
    secret = get_jwt_secret()
    if not secret:
        logger.error("CLOUD_RUN_STREAM_SECRET not configured")
        raise HTTPException(
            status_code=500,
            detail={"error": "Internal server error"}
        )
    
    try:
        # Decode and verify JWT
        payload = jwt.decode(
            token,
            secret,
            algorithms=[JWT_ALGORITHM],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
            options={"require": ["exp", "sub", "iss", "aud"]}
        )
        
        # Ensure required claims are present
        if not payload.get("github_token"):
            raise HTTPException(
                status_code=401,
                detail={"error": "Token missing required github_token claim"}
            )
        
        return payload
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail={"error": "Token expired"}
        )
    except jwt.InvalidIssuerError:
        raise HTTPException(
            status_code=401,
            detail={"error": "Invalid token issuer"}
        )
    except jwt.InvalidAudienceError:
        raise HTTPException(
            status_code=401,
            detail={"error": "Invalid token audience"}
        )
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid token: {e}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Invalid token"}
        )


# ============ Global State ============

# Active runs that can be cancelled
_active_runs: dict[str, asyncio.Event] = {}

# Limit concurrent runs per instance to prevent resource exhaustion
MAX_CONCURRENT_RUNS = 10
_run_semaphore = asyncio.Semaphore(MAX_CONCURRENT_RUNS)

# Checkpointer instance (initialized in lifespan)
_checkpointer: AsyncPostgresSaver | None = None

# Compiled graph (initialized in lifespan)
_graph = None


# ============ Lifespan ============

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup resources."""
    global _checkpointer, _graph
    
    db_uri = get_db_uri()
    
    if db_uri:
        logger.info("Initializing Postgres checkpointer...")
        # Create checkpointer context manager and enter it
        _checkpointer_ctx = AsyncPostgresSaver.from_conn_string(db_uri)
        _checkpointer = await _checkpointer_ctx.__aenter__()
        logger.info("Postgres checkpointer initialized successfully")
    else:
        logger.warning("POSTGRES_URI_CUSTOM not set - running without persistence")
        _checkpointer = None
    
    # Compile graph with checkpointer
    _graph = compile_graph(checkpointer=_checkpointer)
    logger.info("Graph compiled successfully")
    
    yield
    
    # Cleanup
    if _checkpointer:
        logger.info("Closing Postgres checkpointer...")
        await _checkpointer_ctx.__aexit__(None, None, None)
        logger.info("Postgres checkpointer closed")


# ============ FastAPI App ============

app = FastAPI(
    title="Splicer Agent API",
    description="Custom LangGraph API server with Postgres checkpointing",
    lifespan=lifespan,
)

# Add CORS middleware for direct browser requests
# Only allow specific frontend origins (no wildcards for security)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,  # We use Bearer tokens, not cookies
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Run-Id"],  # Allow frontend to read run_id header
)


# ============ Request/Response Models ============

class RunStreamRequest(BaseModel):
    """Request body for /runs/stream endpoint."""
    assistant_id: str = "splicer"
    input: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    stream_mode: list[str] = Field(default=["updates"])


# ============ SSE Formatting ============

def format_sse_event(event_type: str, data: Any) -> str:
    """Format data as an SSE event."""
    json_data = json.dumps(data, default=str)
    return f"event: {event_type}\ndata: {json_data}\n\n"


def serialize_message_chunk(chunk: Any) -> dict:
    """Serialize a message chunk for SSE streaming."""
    if hasattr(chunk, "model_dump"):
        return chunk.model_dump()
    if hasattr(chunk, "dict"):
        return chunk.dict()
    if hasattr(chunk, "__dict__"):
        return {k: v for k, v in chunk.__dict__.items() if not k.startswith("_")}
    return {"content": str(chunk)}


def serialize_state_update(node_name: str, state_delta: Any) -> dict:
    """Serialize a state update for SSE streaming."""
    if isinstance(state_delta, dict):
        # Filter out non-serializable items and messages (too verbose)
        serializable = {}
        for k, v in state_delta.items():
            if k == "messages":
                # Just include message count, not full content
                continue
            try:
                json.dumps(v, default=str)
                serializable[k] = v
            except (TypeError, ValueError):
                serializable[k] = str(v)
        return {node_name: serializable}
    return {node_name: str(state_delta)}


# ============ Stream Generator ============

async def stream_run(
    input_data: dict[str, Any],
    config: dict[str, Any],
    stream_modes: list[str],
    run_id: str,
    cancel_event: asyncio.Event,
) -> AsyncIterator[str]:
    """
    Stream the graph execution as SSE events.
    
    Yields SSE-formatted events matching LangGraph API format:
    - metadata: Run metadata at start
    - updates: State updates after each node
    - messages: LLM token chunks (if streaming messages)
    - error: Error events
    - end: Stream completion
    """
    global _graph
    
    if _graph is None:
        yield format_sse_event("error", {"error": "Graph not initialized"})
        return
    
    # Emit metadata event
    thread_id = config.get("configurable", {}).get("thread_id", str(uuid.uuid4()))
    yield format_sse_event("metadata", {
        "run_id": run_id,
        "thread_id": thread_id,
    })
    
    try:
        # Determine stream mode for LangGraph
        # Frontend requests ["messages", "updates"]
        lg_stream_modes = []
        if "updates" in stream_modes:
            lg_stream_modes.append("updates")
        if "messages" in stream_modes:
            lg_stream_modes.append("messages")
        if not lg_stream_modes:
            lg_stream_modes = ["updates"]
        
        # Stream the graph
        async for chunk in _graph.astream(
            input_data,
            config=config,
            stream_mode=lg_stream_modes,
        ):
            # Check for cancellation
            if cancel_event.is_set():
                yield format_sse_event("error", {"error": "Run cancelled"})
                return
            
            # Handle different chunk formats based on stream mode
            if isinstance(chunk, tuple) and len(chunk) == 2:
                # Multiple stream modes: (mode, data)
                mode, data = chunk
                
                if mode == "updates":
                    # Updates are {node_name: state_delta}
                    if isinstance(data, dict):
                        for node_name, state_delta in data.items():
                            serialized = serialize_state_update(node_name, state_delta)
                            yield format_sse_event("updates", serialized)
                
                elif mode == "messages":
                    # Messages are (message_chunk, metadata)
                    if isinstance(data, tuple) and len(data) == 2:
                        msg_chunk, metadata = data
                        serialized_chunk = serialize_message_chunk(msg_chunk)
                        serialized_meta = metadata if isinstance(metadata, dict) else {}
                        yield format_sse_event("messages", [serialized_chunk, serialized_meta])
                    else:
                        yield format_sse_event("messages", [serialize_message_chunk(data), {}])
            
            elif isinstance(chunk, dict):
                # Single stream mode (updates): {node_name: state_delta}
                for node_name, state_delta in chunk.items():
                    serialized = serialize_state_update(node_name, state_delta)
                    yield format_sse_event("updates", serialized)
            
            else:
                # Unknown format - log and skip
                logger.warning(f"Unknown chunk format: {type(chunk)}")
        
        # Emit end event
        yield format_sse_event("end", {})
        
    except asyncio.CancelledError:
        yield format_sse_event("error", {"error": "Run cancelled"})
        yield format_sse_event("end", {})  # Always send end event
    except BaseException as e:
        # Catch BaseException to handle ExceptionGroups from TaskGroups
        logger.exception("Error during graph execution")
        error_msg = str(e)
        # For ExceptionGroups, extract the first exception message
        if hasattr(e, 'exceptions') and e.exceptions:
            error_msg = str(e.exceptions[0])
        yield format_sse_event("error", {"error": "Error occurred during processing"})
        yield format_sse_event("end", {})  # Always send end event after error
    finally:
        # Clean up active run and release concurrency slot
        if run_id in _active_runs:
            del _active_runs[run_id]
        _run_semaphore.release()


# ============ API Endpoints ============

@app.get("/ok")
async def health_check():
    """Health check endpoint for Cloud Run."""
    return {"status": "ok"}


@app.post("/runs/stream")
async def runs_stream(request: Request, body: RunStreamRequest):
    """
    Stream agent execution with JWT authentication.
    
    Implements LangGraph API /runs/stream endpoint with SSE streaming.
    Requires a Bearer JWT token from the Edge Function containing:
    - github_token: GitHub installation access token
    - thread_id: The thread ID for checkpointing
    - sub: User ID for audit logging
    
    The JWT is issued by the Edge Function's /stream-token endpoint
    and verified here using the shared CLOUD_RUN_STREAM_SECRET.
    """
    # ============ Concurrency Check ============
    # Reject if too many runs are already active on this instance
    if _run_semaphore.locked():
        raise HTTPException(
            status_code=429,
            detail={"error": "Server is at capacity. Please try again shortly."}
        )
    
    # ============ JWT Authentication ============
    # Verify Bearer token and extract claims
    authorization = request.headers.get("Authorization")
    token_payload = verify_stream_token(authorization)
    
    # Extract claims from verified token
    github_token = token_payload.get("github_token")
    token_thread_id = token_payload.get("thread_id")
    user_id = token_payload.get("sub")
    
    logger.info(f"Authenticated stream request from user {user_id}")
    
    # ============ Request Processing ============
    # Extract input and config from request body
    input_data = body.input
    config = body.config
    stream_modes = body.stream_mode
    
    # Ensure configurable section exists
    if "configurable" not in config:
        config["configurable"] = {}
    
    # Use thread_id from token (authoritative) or body, or generate new
    if token_thread_id:
        config["configurable"]["thread_id"] = token_thread_id
    elif "thread_id" not in config["configurable"]:
        config["configurable"]["thread_id"] = str(uuid.uuid4())
    
    # Inject github_token from JWT (this is the secure path)
    # Graph nodes access it via config["configurable"]["github_token"]
    config["configurable"]["github_token"] = github_token
    
    # Also inject user_id for audit/ownership tracking
    config["configurable"]["user_id"] = user_id
    
    # Generate run ID
    run_id = str(uuid.uuid4())
    
    # Create cancellation event
    cancel_event = asyncio.Event()
    _active_runs[run_id] = cancel_event
    
    thread_id = config["configurable"]["thread_id"]
    logger.info(f"Starting run {run_id} for thread {thread_id} (user: {user_id})")
    
    # Acquire semaphore slot (released in stream_run's finally block)
    await _run_semaphore.acquire()
    
    return StreamingResponse(
        stream_run(input_data, config, stream_modes, run_id, cancel_event),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Run-Id": run_id,
        },
    )


@app.post("/threads/{thread_id}/runs/{run_id}/cancel")
async def cancel_run(thread_id: str, run_id: str, action: str = "interrupt"):
    """
    Cancel a running execution.
    
    Args:
        thread_id: The thread ID (not used, but part of LangGraph API)
        run_id: The run ID to cancel
        action: Cancel action type (default: "interrupt")
    """
    if run_id in _active_runs:
        logger.info(f"Cancelling run {run_id}")
        _active_runs[run_id].set()
        return JSONResponse({"status": "cancelled"})
    
    # Run not found - might have already completed
    logger.info(f"Run {run_id} not found for cancellation (may have completed)")
    return JSONResponse({"status": "not_found"})


# ============ Main Entry Point ============

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
