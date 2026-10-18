"""Who a tool call is working for, and helpers for handing results to the model.

The identity comes from `config["configurable"]["langgraph_auth_user"]`, which the
LangGraph server sets from `auth.py` and overrides if a client tries to send it. Tools
read it through `ToolRuntime`, so the model never sees or chooses it.
"""

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID

from langchain.tools import ToolRuntime
from langchain_core.runnables import RunnableConfig


@dataclass(frozen=True)
class AgentUser:
    """Who the agent is working for. Set by the auth layer, never by the client."""

    user_id: str
    entity_id: str


def agent_user_from_config(config: RunnableConfig | None) -> AgentUser:
    """The authenticated user of this run. Raises PermissionError if there is none."""
    raw = ((config or {}).get("configurable") or {}).get("langgraph_auth_user")
    if raw is None:
        raise PermissionError("This agent only works for a signed-in user.")

    def pick(key: str) -> str | None:
        # The server hands over a dict-like proxy of what auth.py returned.
        getter = getattr(raw, "get", None)
        value = getter(key) if callable(getter) else getattr(raw, key, None)
        return str(value) if value else None

    user_id, entity_id = pick("identity"), pick("entity_id")
    if not user_id or not entity_id:
        raise PermissionError(
            "This agent only works for a signed-in user with a business."
        )
    return AgentUser(user_id=user_id, entity_id=entity_id)


def agent_user(runtime: ToolRuntime) -> AgentUser:
    """The signed-in user a tool is running for. Raises PermissionError if none."""
    return agent_user_from_config(runtime.config)


def progress(runtime: ToolRuntime, text: str) -> None:
    """Tell the UI what the agent is doing (the `custom` stream), if anyone listens."""
    writer = getattr(runtime, "stream_writer", None)
    if writer is not None:
        try:
            writer({"progress": text})
        except Exception:  # nosec B110 - progress is best-effort, never fails a tool
            pass


def json_safe(value: Any) -> Any:
    """Database values as JSON: money as a 2-dp number, dates as ISO strings."""
    if isinstance(value, Decimal):
        return float(round(value, 2))
    if isinstance(value, float):
        return round(value, 2)
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value
