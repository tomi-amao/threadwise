"""Cost limits and the turn log.

`TurnBudgetMiddleware` stops a turn that has already used more model tokens than allowed
(a loop of long tool results can cost far more than it is worth). It checks *before* the
next model call, never after one that asked for tools, so it can never leave a tool call
without its result in the thread.

`TurnLogMiddleware` writes one structured line per turn, and one per model failure, to
the `ai_agent.turns` logger: the business as a hash, how long it took, how many model
and tool calls, tokens, which tools, and how it ended. Those lines are the latency, cost
and error dashboard (docs/operations.md); they never contain a question, an answer or a
figure.
"""

import json
import logging
import time
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.config import get_config

from ..core.tracing import pseudonym
from ..tools.identity import agent_user_from_config

turns_log = logging.getLogger("ai_agent.turns")

OVER_BUDGET_REPLY = (
    "That question needed more than I can work through in one go, so I stopped. "
    "Try asking for something narrower, such as one period or one customer."
)


def turn_messages(messages: list[Any]) -> list[Any]:
    """The messages of the current turn: everything after the last human message."""
    start = max(
        (i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1
    )
    return messages[start + 1 :]


def tokens_used(messages: list[Any]) -> int:
    return sum(
        int((getattr(m, "usage_metadata", None) or {}).get("total_tokens", 0))
        for m in messages
        if isinstance(m, AIMessage)
    )


class TurnBudgetMiddleware(AgentMiddleware):
    def __init__(self, token_cap: int) -> None:
        super().__init__()
        self.token_cap = token_cap

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        used = tokens_used(turn_messages(state.get("messages", [])))
        if used <= self.token_cap:
            return None
        turns_log.info(
            "assistant_turn_over_budget %s",
            json.dumps({"tokens": used, "cap": self.token_cap}),
        )
        return {"messages": [AIMessage(content=OVER_BUDGET_REPLY)], "jump_to": "end"}


def _entity_hash() -> str | None:
    try:
        return pseudonym(agent_user_from_config(get_config()).entity_id, "entity")
    except Exception:  # no signed-in user: nothing to name
        return None


class TurnLogMiddleware(AgentMiddleware):
    """One line per turn and per model failure. Cannot fail a turn."""

    async def abefore_agent(self, state: Any, runtime: Any) -> dict[str, Any]:
        return {"turn_started": time.monotonic()}

    async def aafter_agent(self, state: Any, runtime: Any) -> None:
        try:
            turn = turn_messages(state.get("messages", []))
            record = {
                "business": _entity_hash(),
                "seconds": (
                    round(time.monotonic() - state["turn_started"], 2)
                    if state.get("turn_started") is not None
                    else None
                ),
                "model_calls": sum(1 for m in turn if isinstance(m, AIMessage)),
                "tool_calls": [
                    c["name"]
                    for m in turn
                    if isinstance(m, AIMessage)
                    for c in (m.tool_calls or [])
                ],
                "tool_errors": sum(
                    1
                    for m in turn
                    if isinstance(m, ToolMessage) and m.status == "error"
                ),
                "tokens": tokens_used(turn),
                "outcome": "guarded" if state.get("guard_answered") else "answered",
            }
            turns_log.info("assistant_turn %s", json.dumps(record))
        except Exception:  # nosec B110 - logging must never fail a turn
            pass

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        started = time.monotonic()
        try:
            return await handler(request)
        except Exception as exc:
            # The type only: a provider's message can quote the prompt.
            turns_log.warning(
                "assistant_model_error %s",
                json.dumps(
                    {
                        "business": _entity_hash(),
                        "error": type(exc).__name__,
                        "seconds": round(time.monotonic() - started, 2),
                    }
                ),
            )
            raise
