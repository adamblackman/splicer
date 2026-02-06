"""
PostgreSQL checkpointer backed by Supabase database.

Usage:
    async with get_checkpointer() as checkpointer:
        graph = workflow.compile(checkpointer=checkpointer)
        result = await graph.ainvoke(input_data, config)
"""
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator
from urllib.parse import urlparse, urlunparse, quote

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver


def get_db_uri() -> str:
    """
    Get the Supabase PostgreSQL connection URI from environment.
    
    Ensures sslmode=require is set for secure connections.
    
    Returns:
        str: PostgreSQL connection URI with SSL enabled.
        
    Raises:
        ValueError: If POSTGRES_URI_CUSTOM environment variable is not set.
    """
    uri = os.environ.get("POSTGRES_URI_CUSTOM")
    if not uri:
        raise ValueError(
            "POSTGRES_URI_CUSTOM environment variable not set. "
            "Set it to your Supabase PostgreSQL connection string."
        )
    
    # Ensure sslmode=require is set for Supabase connections
    if "sslmode=" not in uri:
        separator = "&" if "?" in uri else "?"
        uri = f"{uri}{separator}sslmode=require"
    
    return uri


@asynccontextmanager
async def get_checkpointer() -> AsyncIterator[AsyncPostgresSaver]:
    """
    Create and yield an AsyncPostgresSaver connected to Supabase.
        
    Yields:
        AsyncPostgresSaver: Configured checkpointer instance.
        
    Example:
        async with get_checkpointer() as checkpointer:
            graph = workflow.compile(checkpointer=checkpointer)
            config = {"configurable": {"thread_id": "my-thread"}}
            result = await graph.ainvoke({"input": "data"}, config)
    """
    db_uri = get_db_uri()
    async with AsyncPostgresSaver.from_conn_string(db_uri) as checkpointer:
        yield checkpointer


async def setup_checkpointer() -> None:
    """
    MUST be called once before first use of the checkpointer.

    Initialize the checkpoint tables in the Supabase database.
    
    This method creates the necessary tables (checkpoints, checkpoint_writes,
    checkpoint_migrations) if they don't exist.
    
    Run this via: python -c "import asyncio; from components.memory import setup_checkpointer; asyncio.run(setup_checkpointer())"
    
    Or use the setup script: python scripts/setup_db.py
    """
    async with get_checkpointer() as checkpointer:
        await checkpointer.setup()
        print("Checkpoint tables created successfully in Supabase.")