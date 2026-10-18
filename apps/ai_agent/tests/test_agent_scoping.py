"""The chat graph only ever works for the signed-in user's business."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import HumanMessage

from ai_agent.agents import graph_agent

USER = {"identity": "user-1", "entity_id": "entity-1"}


def _config(user=USER):
    return {"configurable": {"langgraph_auth_user": user} if user else {}}


def test_analytics_refuses_a_run_with_no_signed_in_user():
    state = {"messages": [HumanMessage(content="what is my revenue?")]}
    with patch.object(graph_agent, "create_agent") as create:
        result = asyncio.run(graph_agent.analytics_agent_node(state, _config(None)))
    create.assert_not_called()  # no tools were even built
    assert "signed-in user" in result["messages"][0].content


def test_analytics_builds_its_tools_for_the_caller_only():
    built = {}

    def fake_tools(user):
        built["user"] = user
        return []

    agent = MagicMock()
    agent.ainvoke = AsyncMock(return_value={"messages": []})
    state = {"messages": [HumanMessage(content="revenue?")]}
    with (
        patch.object(graph_agent, "build_sql_tools", fake_tools),
        patch.object(graph_agent, "create_agent", return_value=agent),
        patch.object(graph_agent, "_get_local_model"),
    ):
        asyncio.run(graph_agent.analytics_agent_node(state, _config()))
    assert (built["user"].user_id, built["user"].entity_id) == ("user-1", "entity-1")


def test_document_search_is_limited_to_the_callers_namespace():
    service = MagicMock()
    service.hybrid_search_with_rerank = AsyncMock(return_value=[])
    state = {
        "messages": [HumanMessage(content="find my invoice")],
        "query_type": "analytics",
    }
    with (
        patch.object(graph_agent, "get_embedding_service", return_value=service),
        patch.object(
            graph_agent, "infer_document_category_filter", AsyncMock(return_value=None)
        ),
    ):
        asyncio.run(graph_agent.retrieve_context_node(state, _config()))
    assert service.hybrid_search_with_rerank.call_args.kwargs["namespace"] == "entity-1"


def test_document_search_is_skipped_without_a_signed_in_user():
    service = MagicMock()
    service.hybrid_search_with_rerank = AsyncMock(return_value=[])
    state = {
        "messages": [HumanMessage(content="find my invoice")],
        "query_type": "analytics",
    }
    with patch.object(graph_agent, "get_embedding_service", return_value=service):
        result = asyncio.run(graph_agent.retrieve_context_node(state, _config(None)))
    service.hybrid_search_with_rerank.assert_not_called()
    assert result == {"retrieved_context": None}
