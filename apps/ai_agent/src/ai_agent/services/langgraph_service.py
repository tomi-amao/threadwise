"""
LangGraph service for handling chat requests and agent interactions.
"""

import os
import json
import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime

from fastapi import logger

try:
    from langgraph_sdk import get_client
except ImportError:
    print("Warning: langgraph_sdk not available")
    get_client = None


class LangGraphService:
    """Service for interacting with LangGraph client."""

    def __init__(self):
        self.client = None
        self.base_url = os.getenv("LANGGRAPH_BASE_URL", "http://localhost:2024")
        self.assistant = None
        
    async def initialize(self):
        """Initialize the LangGraph client."""
        if not get_client:
            print("LangGraph SDK not available")
            return False
            
        try:
            self.client = get_client(url=self.base_url)
            return True
        except Exception as e:
            print(f"Failed to initialize LangGraph client: {e}")
            return False

    async def health_check(self) -> Dict[str, Any]:
        """Check if LangGraph service is healthy."""
        try:
            if not self.client:
                await self.initialize()
            print(self.assistant)
            if not self.client:
                return {"status": "error", "message": "LangGraph client not initialized"}
            assistants_count = await self.client.assistants.count()


            return {
                "status": "healthy",
                "base_url": self.base_url,
                "assistants_count": assistants_count
            }
        except Exception as e:
            return {
                "status": "error", 
                "message": f"LangGraph service unreachable: {str(e)}"
            }
    async def list_assistants(self) -> Dict[str, Any]:
        """List all available assistants."""
        try:
            if not self.client:
                await self.initialize()
            if not self.client:
                return {"status": "error", "message": "LangGraph client not initialized"}
            assistants = await self.client.assistants.search()
            assistants_list = []
            for assistant in assistants:
                assistant_details = await self.client.assistants.get(assistant["assistant_id"])
                assistants_list.append(assistant_details)
            return {
                "status": "success",
                "assistants": assistants_list
            }
        except Exception as e:
            return {
                "status": "error", 
                "message": f"Failed to list assistants: {str(e)}"
            }

    async def create_thread(self, assistant_id) -> Dict[str, Any]:
        """Create a new conversation thread."""
        try:
            if not self.client:
                await self.initialize()
             
            thread = await self.client.threads.create()
            return {
                "thread_id": thread["thread_id"],
                "assistant_id": assistant_id,
                "status": "created"
            }
        except Exception as e:
            raise Exception(f"Failed to create thread: {str(e)}")

    async def create_assistant(self, graph_name: str, model_name: str, assistant_name: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Create a new assistant."""
        try:
            if not self.client:
                await self.initialize()
            if not self.client:
                return {"status": "error", "message": "LangGraph client not initialized"}
            
            assistant = await self.client.assistants.create(
                graph_name,
                context={"model_name": model_name, **(context or {})},
                name=assistant_name
            )
            self.assistant = assistant
            return {
                "status": "success",
                "assistant": assistant
            }
        except Exception as e:
            return {
                "status": "error", 
                "message": f"Failed to create assistant: {str(e)}"
            }
    async def send_message(
        self, 
        content: str, 
        thread_id: Optional[str] = None,
        attachments: Optional[List[dict]] = None,
        assistant_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Send a message to the LangGraph agent."""
        try:
            if not self.client:
                await self.initialize()
            
            # Create thread if not provided
            if not thread_id:
                thread_result = await self.create_thread(assistant_id=assistant_id)
                thread_id = thread_result["thread_id"]


            # Prepare message input
            message_input = {
                "messages": [{"role": "human", "content": content}]
            }
            
            # Add attachments if provided
            if attachments:
                message_input["attachments"] = attachments
            # logger.info(f"Sending message to thread {thread_id}: {message_input} Assistant ID: {self.assistant['assistant_id']}")

            print(f"Sending message to thread {thread_id}: {message_input} Assistant ID: {assistant_id}")
            # Create and run the thread
            run = await self.client.runs.create(
                thread_id=thread_id,
                assistant_id=assistant_id,
                input=message_input
            )
            print(f"Run created: {run}")    
            # Wait for completion
            await self.client.runs.join(thread_id=thread_id, run_id=run["run_id"])
            
            # Get the response
            state = await self.client.threads.get_state(thread_id=thread_id)
            
            # Extract the last message from the agent
            messages = state.get("values", {}).get("messages", [])
            if messages:
                last_message = messages[-1]
                response_content = last_message.get("content", "No response")
            else:
                response_content = "No response from agent"
            
            return {
                "content": response_content,
                "thread_id": thread_id,
                "assistant_id": assistant_id,
                "timestamp": datetime.now(),
                "status": "success"
            }
            
        except Exception as e:
            raise Exception(f"Failed to send message: {str(e)}")

    async def get_thread_messages(self, thread_id: str) -> List[Dict[str, Any]]:
        """Get all messages from a thread."""
        try:
            if not self.client:
                await self.initialize()
            
            state = await self.client.threads.get_state(thread_id=thread_id)
            messages = state.get("values", {}).get("messages", [])
            
            formatted_messages = []
            for msg in messages:
                formatted_messages.append({
                    "role": msg.get("role", "unknown"),
                    "content": msg.get("content", ""),
                    "timestamp": msg.get("timestamp", datetime.now())
                })
            
            return formatted_messages
            
        except Exception as e:
            raise Exception(f"Failed to get thread messages: {str(e)}")

    async def delete_thread(self, thread_id: str) -> Dict[str, Any]:
        """Delete a conversation thread."""
        try:
            if not self.client:
                await self.initialize()
            
            await self.client.threads.delete(thread_id=thread_id)
            return {"status": "deleted", "thread_id": thread_id}
            
        except Exception as e:
            raise Exception(f"Failed to delete thread: {str(e)}")
