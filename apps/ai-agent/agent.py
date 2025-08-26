"""LangGraph single-node graph template.

Returns a predefined response. Replace logic and configuration as needed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, TypedDict

from langgraph.graph import StateGraph
from langgraph.runtime import Runtime

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage

from dotenv import load_dotenv




load_dotenv(dotenv_path=".env", override=True)

model = ChatOpenAI(
    model="openai/gpt-oss-20b",
    base_url="http://localhost:1234/v1",
    # base_url="http://host.docker.internal:1234/v1", # Use this if running in Docker
    api_key="not-needed",
    temperature=0.7, # Adjust temperature for creativity
    streaming=True,  # Set to True for streaming responses
)


class Context(TypedDict):
    """Context parameters for the agent.

    Set these when creating assistants OR when invoking the graph.
    See: https://langchain-ai.github.io/langgraph/cloud/how-tos/configuration_cloud/
    """

    model_name: str


@dataclass
class State:
    """Input state for the agent.

    Defines the initial structure of incoming data.
    See: https://langchain-ai.github.io/langgraph/concepts/low_level/#state
    """

    question: str = "example"
    answer: str = ""


async def call_model(state: State, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Process input and returns output.

    Can use runtime context to alter behavior.
    """
    print(f"Input state: {state}")
    print(f"Runtime context: {runtime}")
    context = runtime.context or {}
    messages = [
    SystemMessage("You are an expert in general topics."),
    HumanMessage(f"Question: {state.question}"),
]

    result = await model.ainvoke(messages
    )
    return {
        "answer": f"{result.content}"
    }


# Define the graph
graph = (
    StateGraph(State, context_schema=Context)
    .add_node(call_model)
    .add_edge("__start__", "call_model")
    .compile(name="threadwise-financial-agent")
)

# graph.invoke(
#     State,
#     context={"llm_provider": "openai-opensource"}
# )
