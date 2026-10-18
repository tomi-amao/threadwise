"""The graph the LangGraph server serves (langgraph.json -> `chat_graph:agent`).

Kept apart from `chat_agent.py` because building it constructs the configured models,
which needs their API keys; tests import `chat_agent.build_agent` without them.
"""

from ai_agent.agents.chat_agent import build_agent

agent = build_agent()
