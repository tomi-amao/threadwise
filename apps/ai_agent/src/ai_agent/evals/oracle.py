"""The oracle: a scripted stand-in for a perfect model, so the pipeline is testable
without one.

It makes the tool calls a good model would make for a case (`Case.calls`) and then
words the answer from what the tools *actually returned* (`Case.say`). It never sees
the expected figures, which come from the seed's manifest, so a tool returning a
wrong number, a leak, or a broken middleware shows up as a failed case even though
no LLM is involved.

It proves the machine works. Whether a real model picks the right tools and states
the right figures is what the nightly run against a real model measures.
"""

import json
import uuid
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from ..agents.ui_middleware import _Proposal
from .cases import Case, Results

# Follow-ups the small oracle offers: distinct, short, about what the tools answer.
FOLLOW_UPS = [
    {"label": "Cash position", "prompt": "How much cash do I have?"},
    {"label": "Overdue invoices", "prompt": "Which invoices are overdue?"},
    {"label": "Profit this year", "prompt": "What is my profit this financial year?"},
]


class OracleModel(BaseChatModel):
    case: Any  # a Case; typed loosely so pydantic does not copy it

    @property
    def _llm_type(self) -> str:
        return "oracle"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "OracleModel":
        return self

    def _generate(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        case: Case = self.case
        system = "\n".join(
            str(m.content) for m in messages if isinstance(m, SystemMessage)
        )
        start = max(
            (i for i, m in enumerate(messages) if isinstance(m, HumanMessage)),
            default=0,
        )
        this_turn = messages[start + 1 :]
        tool_results = [m for m in this_turn if isinstance(m, ToolMessage)]
        if case.calls and not any(isinstance(m, AIMessage) for m in this_turn):
            message = AIMessage(
                content="",
                tool_calls=[
                    {"name": name, "args": args, "id": f"c{uuid.uuid4().hex[:8]}"}
                    for name, args in case.calls
                ],
            )
        else:
            message = AIMessage(content=self._answer(case, tool_results, system))
        return ChatResult(generations=[ChatGeneration(message=message)])

    @staticmethod
    def _answer(case: Case, tool_results: list[ToolMessage], system: str) -> str:
        results = Results()
        for m in tool_results:
            try:
                value = json.loads(str(m.content))
            except ValueError:
                value = {"error": str(m.content)}
            results.add(m.name or "", value)
        try:
            if case.say:
                return case.say(results, system)
        except (KeyError, IndexError, TypeError):
            return "A tool did not return what I needed."
        return case.reply or ""


class OracleSmallModel(BaseChatModel):
    """The small model's part: the follow-up step, which asks for structured output."""

    @property
    def _llm_type(self) -> str:
        return "oracle-small"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "OracleSmallModel":
        return self

    def _generate(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": _Proposal.__name__,
                    "args": {"items": FOLLOW_UPS},
                    "id": f"p{uuid.uuid4().hex[:8]}",
                }
            ],
        )
        return ChatResult(generations=[ChatGeneration(message=message)])
