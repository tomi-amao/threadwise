# agent/main.py
"""AI Agent API built with FastAPI.

This module provides a unified REST API for both LangGraph chat functionality
and embedding services for the ThreadWise platform.
"""
import os
from datetime import datetime
from typing import List, Optional, Dict, Any
import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Import services
try:
    from .services.embedding_service import embedding_service
    from .services.langgraph_service import LangGraphService
except ImportError:
    try:
        from ai_agent.services.embedding_service import embedding_service
        from ai_agent.services.langgraph_service import LangGraphService
    except ImportError:
        embedding_service = None
        LangGraphService = None
        print("Warning: Services not available")
from fastapi import Body

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize services
langgraph_service = LangGraphService() if LangGraphService else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    # Startup
    if langgraph_service:
        await langgraph_service.initialize()
        logger.info("LangGraph service initialized")
    
    if embedding_service:
        logger.info("Embedding service available")
    
    yield
    
    # Shutdown
    logger.info("Application shutting down")


app = FastAPI(
    title="ThreadWise AI Agent API",
    description="Unified AI Agent API with LangGraph chat and embedding services",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for chat
class ChatMessage(BaseModel):
    """Pydantic model for chat message data."""
    content: str
    thread_id: Optional[str] = None
    assistant_id: Optional[str] = None
    attachments: Optional[List[dict]] = None


class ChatResponse(BaseModel):
    """Pydantic model for chat response."""
    content: str
    thread_id: str
    assistant_id: str
    timestamp: datetime
    status: str


class ThreadCreateResponse(BaseModel):
    """Response model for thread creation."""
    thread_id: str
    assistant_id: str
    status: str


# Pydantic models for embeddings
class EmbedFileRequest(BaseModel):
    """Request model for file embedding from storage"""
    file_type: str
    file_url: str


class EmbedFileResponse(BaseModel):
    """Response model for file embedding"""
    success: bool
    documentId: Optional[str] = None
    chunks: Optional[int] = None
    filename: str
    error: Optional[str] = None


class SearchRequest(BaseModel):
    """Request model for document search"""
    query: str
    limit: Optional[int] = 5


class SearchResponse(BaseModel):
    """Response model for document search"""
    results: List[dict]


# Legacy message models (for backwards compatibility)
class Message(BaseModel):
    """Pydantic model for incoming message data."""
    id: Optional[int] = None
    content: str
    timestamp: Optional[datetime] = None


class MessageResponse(BaseModel):
    """Pydantic model for API message responses."""
    id: int
    content: str
    timestamp: datetime
    status: str


# In-memory storage (for demo purposes)
messages = []
message_counter = 0


@app.get("/")
def read_root():
    """Welcome endpoint."""
    return {
        "message": "Welcome to ThreadWise AI Agent API",
        "version": "0.1.0",
        "docs": "/docs",
        "services": {
            "chat": "enabled" if langgraph_service else "disabled",
            "embeddings": "enabled" if embedding_service else "disabled"
        }
    }


@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-agent",
        "chat_service": "enabled" if langgraph_service else "disabled",
        "embedding_service": "enabled" if embedding_service else "disabled"
    }


# ======================================
# CHAT ENDPOINTS (LangGraph Integration)
# ======================================

@app.get("/chat/health")
async def chat_health():
    """Check LangGraph service health."""
    if not langgraph_service:
        return {"status": "error", "message": "LangGraph service not available"}
    
    try:
        health_status = await langgraph_service.health_check()
        return health_status
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/chat", response_model=ChatResponse)
async def send_chat_message(message: ChatMessage):
    """Send a message to the LangGraph agent."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.send_message(
            content=message.content,
            thread_id=message.thread_id,
            attachments=message.attachments,
            assistant_id=message.assistant_id
        )
        return ChatResponse(**response)
    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/threads", response_model=ThreadCreateResponse)
async def create_chat_thread():
    """Create a new chat thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.create_thread()
        return ThreadCreateResponse(**response)
    except Exception as e:
        logger.error(f"Thread creation error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/threads/{thread_id}/messages")
async def get_thread_messages(thread_id: str):
    """Get all messages from a thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        messages_data = await langgraph_service.get_thread_messages(thread_id)
        return {"messages": messages_data}
    except Exception as e:
        logger.error(f"Get messages error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/chat/threads/{thread_id}")
async def delete_chat_thread(thread_id: str):
    """Delete a chat thread."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.delete_thread(thread_id)
        return response
    except Exception as e:
        logger.error(f"Thread deletion error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/chat/assistants")
async def list_assistants():
    """List all available assistants."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.list_assistants()
        return response
    except Exception as e:
        logger.error(f"List assistants error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    
class CreateAssistantRequest(BaseModel):
    graph_name: str
    model_name: str
    assistant_name: str
    context: Optional[Dict[str, Any]] = None

@app.post("/chat/assistants")
async def create_assistant(request: CreateAssistantRequest):
    """Create a new assistant."""
    if not langgraph_service:
        raise HTTPException(status_code=503, detail="LangGraph service not available")
    
    try:
        response = await langgraph_service.create_assistant(
            graph_name=request.graph_name,
            model_name=request.model_name,
            assistant_name=request.assistant_name,
            context=request.context
        )
        return response
    except Exception as e:
        logger.error(f"Create assistant error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
# ===========================================
# EMBEDDING ENDPOINTS (Vector Storage)
# ===========================================

@app.get("/embeddings/health")
def embeddings_health():
    """Check embedding service health."""
    if not embedding_service:
        return {"status": "error", "message": "Embedding service not available"}
    
    try:
        # Simple health check for embedding service
        return {
            "status": "healthy",
            "service": "embedding_service",
            "model": embedding_service.embeddings.model_name,
            "vector_store": embedding_service.supabase.storage.list_buckets(),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/embeddings/embed", response_model=EmbedFileResponse)
async def embed_file(request: EmbedFileRequest):
    """Embed a file from Supabase storage."""
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        result = await embedding_service.embed_file(
            file_url=request.file_url,
            filename=request.file_url.split("/")[-1],
            file_type=request.file_type
        )
        return EmbedFileResponse(**result)
    except Exception as e:
        logger.error(f"Embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embeddings/search", response_model=SearchResponse)
async def search_documents(request: SearchRequest):
    """Search documents using vector similarity."""
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        results = await embedding_service.search_documents(
            query=request.query,
            limit=request.limit or 5
        )
        return SearchResponse(results=results)
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/embeddings/{filename}")
async def delete_document_embeddings(filename: str):
    """Delete embeddings for a specific document."""
    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")
    
    try:
        result = await embedding_service.delete_document_embeddings(filename)
        return result
    except Exception as e:
        logger.error(f"Delete embeddings error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))





@app.get("/stats")
def get_stats():
    """Get API statistics."""
    return {
        "total_messages": len(messages),
        "api_version": "0.1.0",
        "uptime": "running",
        "last_message_time": (
            messages[-1]["timestamp"].isoformat() if messages else None
        ),
    }


# # ================================
# # MAIN ENTRY POINT
# # ================================

# if __name__ == "__main__":
#     uvicorn.run(
#         "ai_agent.main:app",
#         host="0.0.0.0",
#         port=8000,
#         reload=True,
#         log_level="info",
#     )
