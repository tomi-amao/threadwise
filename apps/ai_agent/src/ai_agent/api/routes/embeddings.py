"""Embedding endpoints for ThreadWise AI Agent."""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from ..schemas import (
    DeleteEmbeddingsRequest,
    DeleteNamespaceRequest,
    EmbedFileRequest,
    EmbedFileResponse,
    HybridSearchRequest,
    SearchRequest,
    SearchResponse,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def get_services():
    """Get service instances (lazy import to avoid circular deps)."""
    try:
        from ...services.embedding_service import get_embedding_service

        embedding_service = get_embedding_service()
    except ImportError:
        embedding_service = None

    try:
        from ...integrations.inngest import send_document_embedding_event
    except ImportError:
        send_document_embedding_event = None

    return embedding_service, send_document_embedding_event


@router.get("/health")
async def embeddings_health():
    """Check embedding service health."""
    embedding_service, _ = get_services()

    if not embedding_service:
        return {"status": "error", "message": "Embedding service not available"}

    try:
        # Full health check including Pinecone connection
        health_status = await embedding_service.health_check()
        health_status["timestamp"] = datetime.now().isoformat()
        return health_status
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/embed", response_model=EmbedFileResponse)
async def embed_file(request: EmbedFileRequest):
    """Embed a file with enriched metadata into Pinecone vector store.

    The file will be automatically categorized based on filename patterns.
    Provide entity_id for multi-tenant namespace isolation - each entity_id
    maps to a separate Pinecone namespace for efficient data isolation.
    """
    embedding_service, send_document_embedding_event = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    try:
        result = await embedding_service.embed_file(
            file_url=request.file_url,
            filename=request.file_url.split("/")[-1],
            file_type=request.file_type,
            entity_id=request.entity_id,
        )

        # Send event to Inngest for background processing (fire-and-forget)
        if send_document_embedding_event:
            asyncio.create_task(
                send_document_embedding_event(
                    document_id=result.get("documentId", ""),
                    filename=result.get("filename", ""),
                    entity_id=request.entity_id,
                    chunks=result.get("chunks", 0),
                    file_type=request.file_type,
                    success=result.get("success", False),
                )
            )

        return EmbedFileResponse(**result)
    except Exception as e:
        logger.error(f"Embedding error: {str(e)}")

        # Send error event to Inngest
        if send_document_embedding_event:
            asyncio.create_task(
                send_document_embedding_event(
                    document_id="",
                    filename=request.file_url.split("/")[-1],
                    entity_id=request.entity_id,
                    file_type=request.file_type,
                    success=False,
                    error=str(e),
                )
            )

        raise HTTPException(status_code=500, detail=str(e))


@router.post("/search", response_model=SearchResponse)
async def search_documents(request: SearchRequest):
    """Search documents using dense (semantic) vector similarity.

    This is pure semantic search - matches by meaning and relationships.
    For combined semantic + keyword search, use /embeddings/hybrid-search.

    Pinecone filter examples (use operator syntax):
    - {"document_category": {"$eq": "invoice"}} - Only invoice documents
    - {"file_type": {"$eq": "application/pdf"}} - Only PDF documents
    - {"chunk_index": {"$lt": 5}} - Only first 5 chunks

    Namespace: Use namespace parameter for multi-tenant searches. If not provided,
    searches in the "default" namespace.
    """
    embedding_service, _ = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    try:
        results = await embedding_service.search_documents(
            query=request.query,
            limit=request.limit or 5,
            namespace=request.namespace,
            filter_metadata=request.filter_metadata,
            similarity_threshold=request.similarity_threshold or 0.7,
        )
        return SearchResponse(
            results=results,
            query=request.query,
            namespace=request.namespace,
            filters_applied=request.filter_metadata,
            search_type="semantic",
        )
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/hybrid-search", response_model=SearchResponse)
async def hybrid_search_documents(request: HybridSearchRequest):
    """Search documents using hybrid (semantic + lexical) search with optional reranking.

    ## Two-Stage Retrieval Architecture:

    **Stage 1 - Hybrid Search:** Combines semantic and lexical matching
    - Dense vectors (semantic): Captures meaning and relationships
    - Sparse vectors (lexical): Captures exact keyword matches

    **Stage 2 - Reranking (default: enabled):** Cross-encoder model re-scores results
    - Uses bge-reranker-v2-m3 for precise relevance scoring
    - Retrieves more candidates initially, returns top N after reranking
    - Significantly improves relevance for RAG pipelines

    ## Parameters:

    **alpha** (float, 0.0-1.0): Balance between semantic and lexical search
    - alpha=1.0: Pure semantic search (meaning-based)
    - alpha=0.0: Pure lexical search (keyword-based)
    - alpha=0.7: Recommended default (70% semantic, 30% lexical)

    **rerank** (bool): Enable/disable reranking
    - true (default): Two-stage retrieval with reranking (best quality)
    - false: Single-stage hybrid search only (faster, less accurate)

    **rerank_candidates_multiplier** (int): Candidate retrieval multiplier
    - Default: 3 (retrieves 3× limit candidates for reranking)
    - Higher values: More candidates to choose from (slower but potentially better)
    - Lower values: Fewer candidates (faster but may miss relevant results)
    """
    embedding_service, _ = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    try:
        results = await embedding_service.hybrid_search_with_rerank(
            query=request.query,
            limit=request.limit or 5,
            namespace=request.namespace,
            filter_metadata=request.filter_metadata,
            alpha=request.alpha or 0.7,
            similarity_threshold=request.similarity_threshold or 0.0,
            rerank=request.rerank if request.rerank is not None else True,
            rerank_candidates_multiplier=request.rerank_candidates_multiplier or 3,
        )
        return SearchResponse(
            results=results,
            query=request.query,
            namespace=request.namespace,
            filters_applied=request.filter_metadata,
            search_type="hybrid_with_rerank" if request.rerank else "hybrid",
            alpha=request.alpha or 0.7,
        )
    except Exception as e:
        logger.error(f"Hybrid search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("")
async def delete_document_embeddings(request: DeleteEmbeddingsRequest):
    """Delete embeddings for a specific document by filename or document_id.

    Provide either filename or document_id (document_id is more precise).
    Uses hierarchical vector IDs for efficient deletion.
    """
    embedding_service, _ = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    if not request.filename and not request.document_id:
        raise HTTPException(
            status_code=400, detail="Must provide either filename or document_id"
        )

    try:
        result = await embedding_service.delete_file_embeddings(
            filename=request.filename,
            document_id=request.document_id,
            namespace=request.namespace,
        )
        return {
            "success": result,
            "deleted_by": "document_id" if request.document_id else "filename",
            "identifier": request.document_id or request.filename,
            "namespace": request.namespace or "default",
        }
    except Exception as e:
        logger.error(f"Delete embeddings error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/categories")
async def list_document_categories():
    """List available document categories for filtering."""
    return {
        "categories": [
            {"name": "invoice", "patterns": ["invoice", "bill", "receipt"]},
            {"name": "contract", "patterns": ["contract", "agreement", "terms"]},
            {"name": "report", "patterns": ["report", "analysis", "summary"]},
            {
                "name": "financial",
                "patterns": ["financial", "statement", "balance", "p&l", "profit"],
            },
            {"name": "legal", "patterns": ["legal", "compliance", "regulation"]},
            {"name": "hr", "patterns": ["employee", "hr", "payroll", "personnel"]},
            {"name": "general", "patterns": []},
        ],
        "usage": 'Use category name in filter_metadata with Pinecone operator syntax when searching, e.g., {"document_category": {"$eq": "invoice"}}',
        "operators": ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"],
    }


@router.get("/stats")
async def get_index_stats():
    """Get Pinecone index statistics including namespace breakdown."""
    embedding_service, _ = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    try:
        stats = await embedding_service.get_index_stats()
        return stats
    except Exception as e:
        logger.error(f"Get index stats error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/namespace")
async def delete_namespace(request: DeleteNamespaceRequest):
    """Delete an entire namespace (all documents for a tenant).

    WARNING: This permanently deletes all vectors in the namespace.
    Useful for tenant offboarding or complete data cleanup.
    """
    embedding_service, _ = get_services()

    if not embedding_service:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    if not request.namespace or request.namespace == "default":
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the default namespace. Specify a tenant namespace.",
        )

    try:
        result = await embedding_service.delete_namespace(request.namespace)
        return {
            "success": result,
            "namespace": request.namespace,
            "message": (
                f"Namespace '{request.namespace}' deleted successfully"
                if result
                else "Deletion failed"
            ),
        }
    except Exception as e:
        logger.error(f"Delete namespace error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
