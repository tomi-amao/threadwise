"""Settings for AI Agent module."""

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent, AgentState
from pydantic import BaseModel

from langchain.chat_models import init_chat_model

load_dotenv(dotenv_path=".env", override=True)

class CustomState(AgentState):  
    user_name: str

class CustomContext(BaseModel):
    user_id: str

def get_local_llm(model_name: str = "local-model"):
    """Get local LLM instance following AI Sandbox patterns."""
    return ChatOpenAI(
        model=model_name,  # Following AI Sandbox pattern
        base_url="http://localhost:1234/v1",
        # base_url="http://host.docker.internal:1234/v1", # Use this if running in Docker
        api_key="not-needed",
        temperature=0.7,
        streaming=True,
    )

def get_chat_model(model:str = "google_genai:gemini-2.5-flash-lite"):
    """Get LLM instance based on model name"""
    llm = init_chat_model(model)
    return llm
# def get_local_llm_streaming():
#     """Get streaming LLM instance."""
#     return ChatOpenAI(
#         model="local-model",
#         base_url="http://localhost:1234/v1",
#         api_key="not-needed",
#         temperature=0.7,
#         streaming=True,
#     )
