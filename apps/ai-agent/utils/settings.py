from langchain_openai import ChatOpenAI
from dotenv import load_dotenv

load_dotenv(dotenv_path=".env", override=True)

def get_local_llm():
    """Get local LLM instance following AI Sandbox patterns."""
    return ChatOpenAI(
        model="local-model",  # Following AI Sandbox pattern
        openai_api_base="http://localhost:1234/v1",
        openai_api_key="not-needed",
        temperature=0.7,
        streaming=True
    )

def get_local_llm_streaming():
    """Get streaming LLM instance."""
    return ChatOpenAI(
        model="local-model",
        openai_api_base="http://localhost:1234/v1",
        openai_api_key="not-needed",
        temperature=0.7,
        streaming=True
    )