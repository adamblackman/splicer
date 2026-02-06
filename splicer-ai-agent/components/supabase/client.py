import os
from supabase import create_client, Client

def supabase_client() -> Client:
    """
    Initialize and return the Supabase client.
    
    Requires environment variables:
    - SUPABASE_URL
    - SUPABASE_PUBLISHABLE_KEY
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY")
    
    if not url or not key:
        raise ValueError("Supabase credentials (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) not found in environment variables.")

    return create_client(url, key)
