# agent/main.py
"""AI Agent API built with FastAPI.

This module provides a simple REST API for managing messages with
basic CRUD operations and statistics endpoints.
"""
import os
from datetime import datetime
from typing import List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(
    title="AI Agent API",
    description="A simple AI Agent API built with FastAPI",
    version="0.1.0",
)


# Pydantic models
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
    return {"message": "Welcome to AI Agent API", "version": "0.1.0", "docs": "/docs"}


@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-agent",
    }


@app.post("/messages", response_model=MessageResponse)
def create_message(message: Message):
    """Create a new message."""
    global message_counter
    message_counter += 1

    new_message = {
        "id": message_counter,
        "content": message.content,
        "timestamp": datetime.now(),
        "status": "created",
    }

    messages.append(new_message)
    return new_message


@app.get("/messages", response_model=List[MessageResponse])
def get_messages():
    """Get all messages."""
    return messages


@app.get("/messages/{message_id}", response_model=MessageResponse)
def get_message(message_id: int):
    """Get a specific message by ID."""
    for message in messages:
        if message["id"] == message_id:
            return message

    raise HTTPException(status_code=404, detail="Message not found")


@app.delete("/messages/{message_id}")
def delete_message(message_id: int):
    """Delete a specific message by ID."""
    global messages
    for i, message in enumerate(messages):
        if message["id"] == message_id:
            deleted_message = messages.pop(i)
            return {"message": "Message deleted", "deleted": deleted_message}

    raise HTTPException(status_code=404, detail="Message not found")


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


if __name__ == "__main__":
    # Use environment variables for host and port configuration
    # Default to localhost for security, but allow override for containers
    host = os.getenv("HOST", "127.0.0.1")  # Default to localhost
    port = int(os.getenv("PORT", "8000"))

    uvicorn.run("main:app", host=host, port=port, reload=True, log_level="info")
