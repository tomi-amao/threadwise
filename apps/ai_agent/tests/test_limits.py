"""Cost limits and the turn log: what a runaway turn costs, and what is logged."""

import asyncio
import json
import logging
import uuid
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from ai_agent.agents import chat_agent
from ai_agent.agents.chat_agent import build_agent
from ai_agent.agents.limits_middleware import (
    OVER_BUDGET_REPLY,
    tokens_used,
    turn_messages,
)

from .test_chat_agent import (
    USER_STUB,
    ScriptedModel,
    _stub_coverage,
    _stub_profile,
    _stub_sources,
)


@pytest.fixture(autouse=True)
def _stub_business(monkeypatch):
    monkeypatch.setattr(chat_agent, "load_profile", _stub_profile)
    monkeypatch.setattr(chat_agent, "load_coverage", _stub_coverage)
    monkeypatch.setattr(chat_agent, "load_sources", _stub_sources)


def used(total: int, **kwargs: Any) -> AIMessage:
    message = AIMessage(**kwargs)
    message.usage_metadata = {
        "input_tokens": total - 10,
        "output_tokens": 10,
        "total_tokens": total,
    }
    return message


def ask(
    model: ScriptedModel, cap: int | None = None, text: str = "go"
) -> dict[str, Any]:
    agent = build_agent(
        model,
        small_model=model,
        use_fallback=False,
        follow_ups=False,
        turn_token_cap=cap,
        checkpointer=InMemorySaver(),
    )
    config = {
        "configurable": {
            "thread_id": uuid.uuid4().hex,
            "langgraph_auth_user": USER_STUB,
        }
    }
    return asyncio.run(
        agent.ainvoke({"messages": [HumanMessage(text)]}, config, context={})
    )


def test_tokens_are_counted_for_this_turn_only():
    earlier = used(900, content="old")
    messages = [
        earlier,
        HumanMessage("now"),
        used(40, content=""),
        used(60, content="a"),
    ]
    assert tokens_used(turn_messages(messages)) == 100


def test_a_turn_over_its_token_budget_stops_and_says_why_without_leaving_calls_dangling():
    model = ScriptedModel(
        script=[
            used(
                60,
                content="",
                tool_calls=[{"name": "cash_position", "args": {}, "id": "a"}],
            ),
            used(
                60,
                content="",
                tool_calls=[{"name": "cash_position", "args": {}, "id": "b"}],
            ),
            AIMessage(content="never reached"),
        ]
    )
    # Cap 100: after the first call (60) it goes on; after the second (120) it stops.
    state = ask(model, cap=100)
    assert state["messages"][-1].content == OVER_BUDGET_REPLY
    asked = [m for m in state["messages"] if isinstance(m, AIMessage) and m.tool_calls]
    answered = {m.tool_call_id for m in state["messages"] if m.type == "tool"}
    # Every tool call that was asked for has its result: the thread stays valid.
    assert {c["id"] for m in asked for c in m.tool_calls} == answered
    assert len(model.seen) == 2  # the third model call was never made


def test_a_turn_within_budget_is_untouched():
    model = ScriptedModel(script=[used(50, content="Fine.")])
    assert ask(model, cap=100)["messages"][-1].content == "Fine."


def test_each_turn_writes_one_line_without_anything_the_user_said(caplog):
    caplog.set_level(logging.INFO, logger="ai_agent.turns")
    model = ScriptedModel(
        script=[
            used(
                70,
                content="",
                tool_calls=[{"name": "get_business_profile", "args": {}, "id": "a"}],
            ),
            used(30, content="The secret answer £1,234.56"),
        ]
    )
    # The profile tool reads the database, which this test does not need.
    try:
        ask(model, text="what is my confidential question")
    except (
        Exception
    ):  # the tool may fail without a database; the log line is what matters
        pass
    lines = [r.getMessage() for r in caplog.records if r.name == "ai_agent.turns"]
    turn = next(line for line in lines if line.startswith("assistant_turn "))
    record = json.loads(turn.removeprefix("assistant_turn "))
    assert record["outcome"] == "answered" and record["tokens"] == 100
    assert record["model_calls"] == 2 and record["tool_calls"] == [
        "get_business_profile"
    ]
    assert len(record["business"]) == 32 and "entity" not in record["business"]
    # Dashboards must never hold a question, an answer or a figure.
    assert "confidential" not in turn and "1,234" not in turn and "secret" not in turn


def test_a_guarded_turn_is_logged_as_guarded(caplog):
    caplog.set_level(logging.INFO, logger="ai_agent.turns")
    agent = build_agent(
        ScriptedModel(script=[]),
        small_model=ScriptedModel(script=[]),
        use_fallback=False,
        follow_ups=False,
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": uuid.uuid4().hex}}  # no signed-in user
    asyncio.run(agent.ainvoke({"messages": [HumanMessage("hi")]}, config, context={}))
    lines = [r.getMessage() for r in caplog.records if r.name == "ai_agent.turns"]
    turn = next(line for line in lines if line.startswith("assistant_turn "))
    assert json.loads(turn.removeprefix("assistant_turn "))["outcome"] == "guarded"


def test_a_model_failure_is_logged_by_type_only_and_still_fails_the_turn(caplog):
    caplog.set_level(logging.INFO, logger="ai_agent.turns")

    class Exploding(ScriptedModel):
        def _generate(self, *args: Any, **kwargs: Any):
            raise RuntimeError("quota exceeded for prompt: my confidential question")

    with pytest.raises(Exception):
        ask(Exploding(script=[]), text="my confidential question")
    errors = [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("assistant_model_error ")
    ]
    assert errors and "RuntimeError" in errors[0]
    assert "confidential" not in errors[0]  # a provider's message can quote the prompt
