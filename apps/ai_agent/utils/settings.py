"""Settings for AI Agent module."""

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

load_dotenv(dotenv_path=".env", override=True)


def get_local_llm():
    """Get local LLM instance following AI Sandbox patterns."""
    return ChatOpenAI(
        model="local-model",  # Following AI Sandbox pattern
        base_url="http://localhost:1234/v1",
        # base_url="http://host.docker.internal:1234/v1", # Use this if running in Docker
        api_key="not-needed",
        temperature=0.7,
        streaming=True,
    )


def get_local_llm_streaming():
    """Get streaming LLM instance."""
    return ChatOpenAI(
        model="local-model",
        base_url="http://localhost:1234/v1",
        api_key="not-needed",
        temperature=0.7,
        streaming=True,
    )
