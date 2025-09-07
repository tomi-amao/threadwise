"""Test script for AI Agent using LangGraph SDK."""

import asyncio
from pprint import pprint

from langgraph_sdk import get_client

client = get_client(
    url="http://localhost:8123"
)  # Adjust if your LangServe instance is running elsewhere


async def main():
    """Create an assistant and run a thread with it."""
    openai_assistant = await client.assistants.create(
        # "agent" is the name of a graph we deployed
        "threadwise-financial-agent",
        context={"model_name": "openai"},
        name="ThreadWise Assistant",
    )
    pprint(f"Assistant Info: {openai_assistant}")

    thread = await client.threads.create()
    pprint(f"Thread Info: {thread}")
    input = {
        "messages": [
            {
                "role": "human",
                "content": "Make your answer short. Why is the sun yellow/orange?",
            }
        ]
    }
    async for event in client.runs.stream(
        thread["thread_id"],
        # this is where we specify the assistant id to use
        openai_assistant["assistant_id"],
        input=input,
        stream_mode="values",
    ):
        print(f"Receiving event of type: {event.event}")
        print(event.data)
        print("\n\n")


asyncio.run(main())
