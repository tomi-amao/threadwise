"""Search the business's own uploaded documents (one vector namespace per business)."""

import logging
from typing import Any

from langchain.tools import ToolRuntime, tool

from ..services.embedding_service import get_embedding_service
from .identity import agent_user, progress

logger = logging.getLogger(__name__)


@tool
async def search_documents(
    query: str, runtime: ToolRuntime, limit: int = 5
) -> dict[str, Any]:
    """Search the documents this business has uploaded (invoices, receipts,
    contracts, notes) for passages about `query`. For figures, use the data tools.
    """
    user = agent_user(runtime)
    progress(runtime, "Searching your documents")
    results = await get_embedding_service().hybrid_search_with_rerank(
        query=query,
        limit=max(1, min(limit, 10)),
        namespace=user.entity_id,  # never the default namespace: that is everyone's
        similarity_threshold=0.3,
        rerank=True,
    )
    passages = [
        {
            "text": r.get("content", ""),
            "source": (r.get("metadata") or {}).get("source"),
            "score": round(float(r.get("score") or 0), 3),
        }
        for r in results
        if "error" not in r
    ]
    if any("error" in r for r in results):
        logger.warning("Document search failed for one or more results")
    return {"query": query, "passages": passages}
