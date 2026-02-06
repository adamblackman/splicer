from langchain.chat_models import init_chat_model
from langchain_core.rate_limiters import InMemoryRateLimiter

rate_limiter = InMemoryRateLimiter(
    requests_per_second=2,
    check_every_n_seconds=0.1,
    max_bucket_size=20,
)

def get_model(thinking_level=None):
    """Create a gemini-3-pro-preview model with optional thinking_level parameter."""
    config = {}
    if thinking_level:
        config["thinking_level"] = thinking_level
    
    return init_chat_model(
        model="google_genai:gemini-3-pro-preview",
        rate_limiter=rate_limiter,
        max_retries=3,
        **config
    )
