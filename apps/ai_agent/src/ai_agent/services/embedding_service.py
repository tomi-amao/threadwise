"""
Embedding Service for AI Agent
Handles text extraction from various file types and embedding generation using Pinecone.

This service uses Pinecone as the vector store with the following architecture:
- **Namespaces**: Used for multi-tenant isolation (entity_id maps to namespace)
- **Hierarchical IDs**: Format `{document_id}#{chunk_index}` for efficient deletion
- **Metadata**: Rich metadata for filtering (category, file_type, timestamps)
"""

import asyncio
import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

import httpx

try:
    from PyPDF2 import PdfReader
except ImportError:
    PdfReader = None

try:
    from docx import Document as DocxDocument
except ImportError:
    DocxDocument = None

try:
    from langchain_huggingface import HuggingFaceEmbeddings
except ImportError:
    HuggingFaceEmbeddings = None

from langchain_community.document_loaders import PyPDFLoader
from langchain_core.documents import Document as LangChainDocument
from langchain_text_splitters import RecursiveCharacterTextSplitter

try:
    from pinecone import Pinecone, ServerlessSpec
except ImportError:
    Pinecone = None
    ServerlessSpec = None

try:
    from langchain_pinecone import PineconeVectorStore
except ImportError:
    PineconeVectorStore = None

from dotenv import load_dotenv

# Load environment variables
load_dotenv(
    dotenv_path="/Users/trendstomi/projects/web-applications/threadwise/apps/ai_agent/.env"
)

logger = logging.getLogger(__name__)

# =============================================================================
# CONFIGURATION
# =============================================================================

# Pinecone configuration
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "threadwise-documents")
PINECONE_CLOUD = os.getenv("PINECONE_CLOUD", "aws")
PINECONE_REGION = os.getenv("PINECONE_REGION", "us-east-1")

# Dense embedding model configuration
# all-MiniLM-L6-v2 produces 384-dimensional vectors
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
EMBEDDING_DIMENSION = 384

# Sparse embedding model configuration (Pinecone's hosted model)
# Used for lexical/keyword search in hybrid mode
SPARSE_EMBEDDING_MODEL = "pinecone-sparse-english-v0"

# Hybrid search configuration
# Alpha controls balance: 1.0 = pure semantic, 0.0 = pure lexical
# Default 0.7 = 70% semantic, 30% lexical (good for most use cases)
DEFAULT_HYBRID_ALPHA = float(os.getenv("HYBRID_SEARCH_ALPHA", "0.7"))

# Reranking configuration
# bge-reranker-v2-m3 is a high-performance, multilingual reranking model
RERANK_MODEL = os.getenv("PINECONE_RERANK_MODEL", "bge-reranker-v2-m3")
# Enable reranking by default for improved relevance
DEFAULT_RERANK_ENABLED = os.getenv("RERANK_ENABLED", "true").lower() == "true"
# Multiplier for initial retrieval when reranking (retrieve more candidates)
RERANK_CANDIDATE_MULTIPLIER = int(os.getenv("RERANK_CANDIDATE_MULTIPLIER", "3"))

# Index metric must be dotproduct for hybrid search
# (cosine doesn't support sparse vectors)
INDEX_METRIC = "dotproduct"

# Default namespace for documents without entity_id
DEFAULT_NAMESPACE = "default"

# Text chunking configuration
CHUNK_SIZE = 500
CHUNK_OVERLAP = 50

# Document category mappings based on file patterns
DOCUMENT_CATEGORY_PATTERNS = {
    "invoice": [r"invoice", r"bill", r"receipt"],
    "contract": [r"contract", r"agreement", r"terms"],
    "report": [r"report", r"analysis", r"summary"],
    "financial": [r"financial", r"statement", r"balance", r"p&l", r"profit"],
    "legal": [r"legal", r"compliance", r"regulation"],
    "hr": [r"employee", r"hr", r"payroll", r"personnel"],
    "general": [],  # Default category
}

# Global instances (initialized once for performance)
_embeddings = None
_pinecone_client = None
_pinecone_index = None


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def get_embeddings():
    """Get or initialize the embedding model (singleton pattern)."""
    global _embeddings
    if _embeddings is None:
        if HuggingFaceEmbeddings is None:
            raise ImportError(
                "langchain-huggingface is not installed. "
                "Install with: pip install langchain-huggingface"
            )
        logger.info(f"Initializing embedding model: {EMBEDDING_MODEL}")
        _embeddings = HuggingFaceEmbeddings(
            model_name=EMBEDDING_MODEL,
            model_kwargs={"device": "cpu"},  # Use CPU for compatibility
            encode_kwargs={
                "normalize_embeddings": True
            },  # Normalize for cosine similarity
        )
        logger.info("Embedding model initialized successfully")
    return _embeddings


def get_pinecone_client():
    """Get or initialize the Pinecone client (singleton pattern)."""
    global _pinecone_client
    if _pinecone_client is None:
        if Pinecone is None:
            raise ImportError(
                "pinecone is not installed. Install with: pip install pinecone"
            )
        if not PINECONE_API_KEY:
            raise ValueError("PINECONE_API_KEY environment variable is not set")

        logger.info("Initializing Pinecone client")
        _pinecone_client = Pinecone(api_key=PINECONE_API_KEY)
        logger.info("Pinecone client initialized successfully")
    return _pinecone_client


def get_pinecone_index():
    """Get or initialize the Pinecone index (singleton pattern).

    Note: For hybrid search, the index must use dotproduct metric.
    If migrating from cosine metric, you'll need to recreate the index.
    """
    global _pinecone_index
    if _pinecone_index is None:
        pc = get_pinecone_client()

        # Check if index exists, create if not
        existing_indexes = [idx.name for idx in pc.list_indexes()]

        if PINECONE_INDEX_NAME not in existing_indexes:
            logger.info(f"Creating Pinecone index: {PINECONE_INDEX_NAME}")
            logger.info(f"Using metric: {INDEX_METRIC} (required for hybrid search)")
            pc.create_index(
                name=PINECONE_INDEX_NAME,
                dimension=EMBEDDING_DIMENSION,
                metric=INDEX_METRIC,  # dotproduct required for hybrid search
                spec=ServerlessSpec(cloud=PINECONE_CLOUD, region=PINECONE_REGION),
            )
            logger.info(f"Index {PINECONE_INDEX_NAME} created successfully")
        else:
            # Verify existing index uses dotproduct metric
            index_info = pc.describe_index(PINECONE_INDEX_NAME)
            if index_info.metric != INDEX_METRIC:
                logger.warning(
                    f"Existing index uses '{index_info.metric}' metric, "
                    f"but hybrid search requires '{INDEX_METRIC}'. "
                    f"Consider recreating the index for hybrid search support."
                )

        _pinecone_index = pc.Index(PINECONE_INDEX_NAME)
        logger.info(f"Connected to Pinecone index: {PINECONE_INDEX_NAME}")
    return _pinecone_index


# =============================================================================
# EMBEDDING SERVICE CLASS
# =============================================================================


class EmbeddingService:
    """
    Service for handling file embedding operations with Pinecone Hybrid Search.

    Architecture:
    - **Hybrid Search**: Combines dense (semantic) and sparse (lexical) vectors
    - **Dense Embeddings**: HuggingFace sentence-transformers for semantic understanding
    - **Sparse Embeddings**: Pinecone's pinecone-sparse-english-v0 for keyword matching
    - **Namespaces**: Multi-tenant data isolation (entity_id → namespace)
    - **Hierarchical IDs**: Format `{document_id}#{chunk}` for efficient deletion

    Hybrid Search Benefits:
    - Semantic search captures meaning and relationships
    - Lexical search captures exact keyword matches
    - Combined approach handles both domain-specific terms AND synonyms

    Example usage:
        service = EmbeddingService()

        # Embed a PDF file (stores both dense and sparse vectors)
        result = await service.embed_file(
            file_url="https://example.com/invoice.pdf",
            filename="invoice.pdf",
            file_type="application/pdf",
            entity_id="tenant-123"
        )

        # Hybrid search (default alpha=0.7: 70% semantic, 30% lexical)
        results = await service.hybrid_search(
            query="invoice total amount",
            namespace="tenant-123",
            alpha=0.7  # Adjust balance between semantic/lexical
        )

        # Pure semantic search
        results = await service.search_documents(
            query="invoice total amount",
            namespace="tenant-123",
            filter_metadata={"document_category": {"$eq": "invoice"}}
        )
    """

    def __init__(self):
        """Initialize the embedding service with Pinecone and embeddings."""
        self.embeddings = get_embeddings()
        self.index = get_pinecone_index()
        self.pc = get_pinecone_client()

    # =========================================================================
    # SPARSE EMBEDDING GENERATION
    # =========================================================================

    async def _generate_sparse_embedding(
        self, text: str, input_type: str = "passage"
    ) -> Dict[str, Any]:
        """
        Generate sparse embedding using Pinecone's hosted sparse model.

        Uses pinecone-sparse-english-v0 which outperforms BM25 by estimating
        lexical importance of tokens using context (DeepImpact architecture).

        Args:
            text: The text to embed
            input_type: "passage" for documents, "query" for search queries

        Returns:
            Dict with 'indices' and 'values' for sparse vector
        """
        try:
            response = await asyncio.to_thread(
                self.pc.inference.embed,
                model=SPARSE_EMBEDDING_MODEL,
                inputs=[text],
                parameters={
                    "input_type": input_type,
                    "truncate": "END",  # Truncate at 512 tokens if too long
                },
            )

            # Extract sparse values from response
            sparse_data = response.data[0]
            return {
                "indices": sparse_data.sparse_indices,
                "values": sparse_data.sparse_values,
            }
        except Exception as e:
            logger.warning(f"Failed to generate sparse embedding: {e}")
            # Return empty sparse vector on failure (graceful degradation)
            return {"indices": [], "values": []}

    async def _generate_sparse_embeddings_batch(
        self, texts: List[str], input_type: str = "passage"
    ) -> List[Dict[str, Any]]:
        """
        Generate sparse embeddings for multiple texts in batch.

        Pinecone's sparse model supports batch size of 96 sequences.

        Args:
            texts: List of texts to embed
            input_type: "passage" for documents, "query" for search queries

        Returns:
            List of sparse vectors with 'indices' and 'values'
        """
        sparse_embeddings = []
        batch_size = 96  # Max batch size for pinecone-sparse-english-v0

        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            try:
                response = await asyncio.to_thread(
                    self.pc.inference.embed,
                    model=SPARSE_EMBEDDING_MODEL,
                    inputs=batch,
                    parameters={
                        "input_type": input_type,
                        "truncate": "END",
                    },
                )

                for sparse_data in response.data:
                    sparse_embeddings.append(
                        {
                            "indices": sparse_data.sparse_indices,
                            "values": sparse_data.sparse_values,
                        }
                    )
            except Exception as e:
                logger.warning(f"Failed to generate sparse batch: {e}")
                # Add empty sparse vectors for failed batch
                sparse_embeddings.extend([{"indices": [], "values": []} for _ in batch])

        return sparse_embeddings

    def _apply_hybrid_weighting(
        self,
        dense_vector: List[float],
        sparse_vector: Dict[str, Any],
        alpha: float,
    ) -> tuple:
        """
        Apply alpha weighting to balance dense and sparse vectors.

        Uses convex combination: alpha * dense + (1 - alpha) * sparse

        Args:
            dense_vector: Dense embedding values
            sparse_vector: Dict with 'indices' and 'values'
            alpha: Weight for dense vs sparse (0.0 to 1.0)
                   1.0 = pure semantic, 0.0 = pure lexical

        Returns:
            Tuple of (weighted_dense, weighted_sparse)
        """
        if alpha < 0 or alpha > 1:
            raise ValueError("Alpha must be between 0 and 1")

        # Weight dense vector
        weighted_dense = [v * alpha for v in dense_vector]

        # Weight sparse vector
        weighted_sparse = {
            "indices": sparse_vector["indices"],
            "values": [v * (1 - alpha) for v in sparse_vector["values"]],
        }

        return weighted_dense, weighted_sparse

    # =========================================================================
    # METADATA AND ID GENERATION
    # =========================================================================

    def _infer_document_category(self, filename: str, file_type: str) -> str:
        """
        Infer document category based on filename patterns and file type.

        Args:
            filename: The name of the file
            file_type: MIME type of the file

        Returns:
            Category string for organization and searchability
        """
        filename_lower = filename.lower()

        for category, patterns in DOCUMENT_CATEGORY_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, filename_lower):
                    return category

        # Fallback based on file type
        if file_type == "application/pdf":
            return "pdf_document"
        elif file_type in [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
        ]:
            return "word_document"
        elif file_type.startswith("text/"):
            return "text_document"

        return "general"

    def _extract_filename_from_url(self, file_url: str) -> str:
        """Extract clean filename from a URL, handling signed URLs with tokens."""
        parsed = urlparse(file_url)
        path = unquote(parsed.path)
        filename = path.split("/")[-1]
        # Remove timestamp prefix if present (e.g., "1769383048285-invoice_Barry.pdf")
        if "-" in filename and filename.split("-")[0].isdigit():
            filename = "-".join(filename.split("-")[1:])
        return filename

    def _generate_document_id(self, file_url: str, filename: str) -> str:
        """
        Generate a stable document ID for tracking embeddings.

        The document ID is used as a prefix for vector IDs, enabling
        efficient deletion of all chunks for a document.
        """
        url_hash = hashlib.md5(file_url.encode()).hexdigest()[:12]
        # Clean filename for use in ID (alphanumeric and hyphens only)
        clean_name = re.sub(r"[^a-zA-Z0-9]", "-", filename.lower())[:30]
        return f"{clean_name}-{url_hash}"

    def _generate_vector_id(self, document_id: str, chunk_index: int) -> str:
        """
        Generate a hierarchical vector ID for efficient deletion.

        Format: {document_id}#{chunk_index:04d}
        This enables listing and deleting all vectors for a document using prefix.
        """
        return f"{document_id}#{chunk_index:04d}"

    def _build_enriched_metadata(
        self,
        filename: str,
        file_type: str,
        file_url: str,
        chunk_index: int,
        total_chunks: int,
        text_content: str,
        entity_id: Optional[str] = None,
        extra_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Build enriched metadata for a document chunk.

        This metadata enables filtering, context retrieval, and document management.
        The text content is stored in metadata for retrieval (Pinecone pattern).
        """
        document_id = self._generate_document_id(file_url, filename)
        category = self._infer_document_category(filename, file_type)

        metadata = {
            # Core identification
            "document_id": document_id,
            "file_name": filename,
            "file_type": file_type,
            "source": file_url,
            # Text content for retrieval (required by LangChain PineconeVectorStore)
            "text": text_content,
            # Categorization for filtering
            "document_category": category,
            # Chunk information for context
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            # Timestamps
            "embedded_at": datetime.now(timezone.utc).isoformat(),
            # Entity/tenant scoping (stored in metadata for reference)
            "entity_id": entity_id or DEFAULT_NAMESPACE,
        }

        # Merge any extra metadata from the PDF loader
        if extra_metadata:
            pdf_metadata = {}
            for key in ["title", "creator", "producer", "creationdate", "total_pages"]:
                if key in extra_metadata:
                    pdf_metadata[key] = str(extra_metadata[key])
            if pdf_metadata:
                # Flatten PDF metadata into main metadata (Pinecone prefers flat structure)
                for k, v in pdf_metadata.items():
                    metadata[f"pdf_{k}"] = v

        # Remove None values and ensure all values are Pinecone-compatible types
        return {k: v for k, v in metadata.items() if v is not None}

    # =========================================================================
    # FILE EXTRACTION
    # =========================================================================

    async def download_file_from_url(self, file_url: str) -> bytes:
        """Download file content from a URL."""
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(file_url)
            response.raise_for_status()
            return response.content

    def extract_text_from_pdf(self, file_content: bytes) -> str:
        """Extract text from PDF file."""
        try:
            if PdfReader is None:
                raise ImportError("PyPDF2 is not installed")
            reader = PdfReader(BytesIO(file_content))
            text = ""
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
            return text.strip()
        except Exception as e:
            logger.error(f"Error extracting text from PDF: {e}")
            raise ValueError(f"Failed to extract text from PDF: {e}")

    def extract_text_from_docx(self, file_content: bytes) -> str:
        """Extract text from Word document."""
        try:
            if DocxDocument is None:
                raise ImportError("python-docx is not installed")
            doc = DocxDocument(BytesIO(file_content))
            text = ""
            for paragraph in doc.paragraphs:
                text += paragraph.text + "\n"
            return text.strip()
        except Exception as e:
            logger.error(f"Error extracting text from DOCX: {e}")
            raise ValueError(f"Failed to extract text from DOCX: {e}")

    def extract_text_from_txt(self, file_content: bytes) -> str:
        """Extract text from plain text file."""
        try:
            for encoding in ["utf-8", "latin-1", "cp1252"]:
                try:
                    return file_content.decode(encoding).strip()
                except UnicodeDecodeError:
                    continue
            raise ValueError("Could not decode text file with any common encoding")
        except Exception as e:
            logger.error(f"Error extracting text from TXT: {e}")
            raise ValueError(f"Failed to extract text from TXT: {e}")

    def extract_text_from_file(
        self, file_content: bytes, file_type: str, filename: str
    ) -> str:
        """Extract text from file based on file type."""
        logger.info(f"Extracting text from {filename} (type: {file_type})")

        file_type = file_type.lower()

        if file_type == "application/pdf":
            return self.extract_text_from_pdf(file_content)
        elif file_type in [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
        ]:
            return self.extract_text_from_docx(file_content)
        elif file_type.startswith("text/") or file_type in [
            "application/json",
            "text/plain",
        ]:
            return self.extract_text_from_txt(file_content)
        else:
            raise ValueError(f"Unsupported file type: {file_type}")

    # =========================================================================
    # EMBEDDING OPERATIONS
    # =========================================================================

    async def embed_file(
        self,
        file_url: str,
        filename: str,
        file_type: str,
        entity_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Process a file: download, extract text, create embeddings, and store in Pinecone.

        Args:
            file_url: URL to download the file from
            filename: Original filename
            file_type: MIME type of the file
            entity_id: Optional entity/tenant ID for namespace isolation

        Returns:
            Dict with success status, document ID, chunk count, etc.
        """
        logger.info(f"Starting embedding process for: {filename}")

        # Extract clean filename if URL-based
        clean_filename = self._extract_filename_from_url(file_url) or filename
        document_id = self._generate_document_id(file_url, clean_filename)

        # Determine namespace (entity_id for multi-tenancy, or default)
        namespace = entity_id if entity_id else DEFAULT_NAMESPACE

        try:
            # Load and split PDF using PyPDFLoader
            def load_and_split_pdf():
                pdf_loader = PyPDFLoader(
                    file_path=file_url,
                    mode="single",
                    pages_delimiter="\n",
                )
                documents = pdf_loader.load()

                splitter = RecursiveCharacterTextSplitter(
                    chunk_size=CHUNK_SIZE,
                    chunk_overlap=CHUNK_OVERLAP,
                    separators=["\n\n", "\n", ".", "?", ",", " ", ""],
                )
                return splitter.split_documents(documents)

            documents = await asyncio.to_thread(load_and_split_pdf)
            total_chunks = len(documents)

            if total_chunks == 0:
                return {
                    "success": False,
                    "error": "No text content extracted from document",
                    "filename": clean_filename,
                }

            # Extract text content for batch embedding
            text_contents = [doc.page_content for doc in documents]

            # Generate dense embeddings in batch
            logger.info(f"Generating dense embeddings for {total_chunks} chunks")
            dense_embeddings = await asyncio.to_thread(
                self.embeddings.embed_documents, text_contents
            )

            # Generate sparse embeddings in batch (for hybrid search)
            logger.info(f"Generating sparse embeddings for {total_chunks} chunks")
            sparse_embeddings = await self._generate_sparse_embeddings_batch(
                text_contents, input_type="passage"
            )

            # Prepare vectors for upsert (with both dense and sparse)
            vectors_to_upsert = []

            for idx, doc in enumerate(documents):
                original_metadata = doc.metadata.copy() if doc.metadata else {}

                # Build enriched metadata
                metadata = self._build_enriched_metadata(
                    filename=clean_filename,
                    file_type=file_type,
                    file_url=file_url,
                    chunk_index=idx,
                    total_chunks=total_chunks,
                    text_content=doc.page_content,
                    entity_id=entity_id,
                    extra_metadata=original_metadata,
                )

                # Generate hierarchical vector ID
                vector_id = self._generate_vector_id(document_id, idx)

                # Get dense and sparse embeddings for this chunk
                dense_embedding = dense_embeddings[idx]
                sparse_embedding = sparse_embeddings[idx]

                # Build vector record with both dense and sparse values
                vector_record = {
                    "id": vector_id,
                    "values": dense_embedding,
                    "metadata": metadata,
                }

                # Add sparse values if available (for hybrid search)
                if sparse_embedding["indices"] and sparse_embedding["values"]:
                    vector_record["sparse_values"] = {
                        "indices": sparse_embedding["indices"],
                        "values": sparse_embedding["values"],
                    }

                vectors_to_upsert.append(vector_record)

            # Upsert vectors to Pinecone in batches
            logger.info(
                f"Upserting {len(vectors_to_upsert)} vectors to namespace: {namespace}"
            )

            batch_size = 100  # Pinecone recommends batches of 100
            for i in range(0, len(vectors_to_upsert), batch_size):
                batch = vectors_to_upsert[i : i + batch_size]
                await asyncio.to_thread(
                    self.index.upsert, vectors=batch, namespace=namespace
                )

            category = self._infer_document_category(clean_filename, file_type)

            # Count chunks with sparse embeddings
            sparse_count = sum(
                1
                for v in vectors_to_upsert
                if "sparse_values" in v and v["sparse_values"]["indices"]
            )

            logger.info(
                f"Successfully embedded {total_chunks} chunks for {clean_filename} "
                f"(category: {category}, namespace: {namespace}, "
                f"hybrid: {sparse_count}/{total_chunks} with sparse vectors)"
            )

            return {
                "success": True,
                "documentId": document_id,
                "chunks": total_chunks,
                "filename": clean_filename,
                "text_length": sum(len(doc.page_content) for doc in documents),
                "document_category": category,
                "entity_id": entity_id,
                "namespace": namespace,
                "hybrid_enabled": sparse_count > 0,
                "sparse_vector_count": sparse_count,
            }

        except Exception as e:
            logger.error(f"Error embedding file {filename}: {e}")
            return {
                "success": False,
                "error": str(e),
                "filename": filename,
            }

    async def search_documents(
        self,
        query: str,
        limit: int = 5,
        namespace: Optional[str] = None,
        filter_metadata: Optional[Dict[str, Any]] = None,
        similarity_threshold: float = 0.7,
    ) -> List[Dict[str, Any]]:
        """
        Search for similar documents with optional metadata filtering.

        Args:
            query: The search query text
            limit: Maximum number of results to return
            namespace: Namespace to search in (entity_id for multi-tenancy)
            filter_metadata: Optional dict to filter results by metadata fields
                Examples:
                    {"document_category": {"$eq": "invoice"}}
                    {"file_type": {"$eq": "application/pdf"}}
            similarity_threshold: Minimum similarity score (0-1) for results

        Returns:
            List of matching documents with content and metadata
        """
        try:
            logger.info(f"Searching documents for: {query}")

            # Use default namespace if not specified
            search_namespace = namespace if namespace else DEFAULT_NAMESPACE

            if filter_metadata:
                logger.info(f"With metadata filter: {filter_metadata}")

            # Generate query embedding
            query_embedding = await asyncio.to_thread(
                self.embeddings.embed_query, query
            )

            # Build query parameters
            query_params = {
                "vector": query_embedding,
                "top_k": limit,
                "include_metadata": True,
                "namespace": search_namespace,
            }

            # Add filter if provided (Pinecone filter format)
            if filter_metadata:
                query_params["filter"] = filter_metadata

            # Execute query
            response = await asyncio.to_thread(self.index.query, **query_params)

            # Process results
            results = []
            for match in response.matches:
                score = match.score

                # Apply similarity threshold
                if score < similarity_threshold:
                    continue

                metadata = match.metadata or {}

                results.append(
                    {
                        "id": match.id,
                        "score": score,
                        "content": metadata.get("text", ""),
                        "metadata": {
                            "document_id": metadata.get("document_id"),
                            "file_name": metadata.get("file_name"),
                            "file_type": metadata.get("file_type"),
                            "source": metadata.get("source"),
                            "document_category": metadata.get("document_category"),
                            "chunk_index": metadata.get("chunk_index"),
                            "total_chunks": metadata.get("total_chunks"),
                            "entity_id": metadata.get("entity_id"),
                            "embedded_at": metadata.get("embedded_at"),
                        },
                    }
                )

            logger.info(f"Search returned {len(results)} results")
            return results

        except Exception as e:
            logger.error(f"Error searching documents: {e}")
            return [{"error": str(e)}]

    async def hybrid_search(
        self,
        query: str,
        limit: int = 5,
        namespace: Optional[str] = None,
        filter_metadata: Optional[Dict[str, Any]] = None,
        alpha: float = DEFAULT_HYBRID_ALPHA,
        similarity_threshold: float = 0.0,
    ) -> List[Dict[str, Any]]:
        """
        Perform hybrid search combining semantic and lexical matching.

        Hybrid search uses both dense (semantic) and sparse (lexical) vectors
        to find documents that match by meaning AND/OR keywords.

        Args:
            query: The search query text
            limit: Maximum number of results to return
            namespace: Namespace to search in (entity_id for multi-tenancy)
            filter_metadata: Optional metadata filter
            alpha: Balance between semantic and lexical search (0.0 to 1.0)
                   - 1.0 = pure semantic search (meaning-based)
                   - 0.0 = pure lexical search (keyword-based)
                   - 0.7 = recommended default (70% semantic, 30% lexical)
            similarity_threshold: Minimum score for results (default 0.0 for hybrid)

        Returns:
            List of matching documents with content, scores, and metadata

        Example:
            # Balanced hybrid search
            results = await service.hybrid_search(
                query="Q3 revenue analysis",
                alpha=0.7  # 70% semantic, 30% keyword
            )

            # Keyword-focused search (good for exact terms)
            results = await service.hybrid_search(
                query="invoice #12345",
                alpha=0.3  # 30% semantic, 70% keyword
            )
        """
        try:
            logger.info(f"Hybrid search for: {query} (alpha={alpha})")

            search_namespace = namespace if namespace else DEFAULT_NAMESPACE

            # Generate dense embedding
            dense_embedding = await asyncio.to_thread(
                self.embeddings.embed_query, query
            )

            # Generate sparse embedding
            sparse_embedding = await self._generate_sparse_embedding(
                query, input_type="query"
            )

            # Check if sparse embedding was generated successfully
            has_sparse = bool(
                sparse_embedding["indices"] and sparse_embedding["values"]
            )

            if not has_sparse:
                logger.warning(
                    "Sparse embedding generation failed, falling back to dense-only"
                )
                # Fall back to pure semantic search
                return await self.search_documents(
                    query=query,
                    limit=limit,
                    namespace=namespace,
                    filter_metadata=filter_metadata,
                    similarity_threshold=similarity_threshold,
                )

            # Apply alpha weighting
            weighted_dense, weighted_sparse = self._apply_hybrid_weighting(
                dense_embedding, sparse_embedding, alpha
            )

            # Build hybrid query parameters
            query_params = {
                "vector": weighted_dense,
                "sparse_vector": weighted_sparse,
                "top_k": limit,
                "include_metadata": True,
                "namespace": search_namespace,
            }

            if filter_metadata:
                query_params["filter"] = filter_metadata

            # Execute hybrid query
            response = await asyncio.to_thread(self.index.query, **query_params)

            # Process results
            results = []
            for match in response.matches:
                score = match.score

                if score < similarity_threshold:
                    continue

                metadata = match.metadata or {}

                results.append(
                    {
                        "id": match.id,
                        "score": score,
                        "search_type": "hybrid",
                        "alpha": alpha,
                        "content": metadata.get("text", ""),
                        "metadata": {
                            "document_id": metadata.get("document_id"),
                            "file_name": metadata.get("file_name"),
                            "file_type": metadata.get("file_type"),
                            "source": metadata.get("source"),
                            "document_category": metadata.get("document_category"),
                            "chunk_index": metadata.get("chunk_index"),
                            "total_chunks": metadata.get("total_chunks"),
                            "entity_id": metadata.get("entity_id"),
                            "embedded_at": metadata.get("embedded_at"),
                        },
                    }
                )

            logger.info(f"Hybrid search returned {len(results)} results")
            return results

        except Exception as e:
            logger.error(f"Error in hybrid search: {e}")
            return [{"error": str(e)}]

    async def rerank_results(
        self,
        query: str,
        results: List[Dict[str, Any]],
        top_n: int = 5,
        rank_field: str = "content",
    ) -> List[Dict[str, Any]]:
        """
        Rerank search results using Pinecone's hosted reranking model.

        Reranking is a two-stage retrieval optimization that improves result
        quality by re-scoring initial candidates based on their semantic
        relevance to the query using a specialized cross-encoder model.

        How it works:
        1. Initial retrieval (hybrid search) returns N candidates quickly
        2. Reranker evaluates query-document pairs more thoroughly
        3. Returns top_n results with improved relevance ordering

        Args:
            query: The original search query
            results: List of search results to rerank (from hybrid_search)
            top_n: Number of top results to return after reranking
            rank_field: The field in results to use for reranking (default: "content")

        Returns:
            Reranked list of results with updated scores, ordered by relevance

        Example:
            # Get initial candidates
            candidates = await service.hybrid_search(query="invoice terms", limit=15)

            # Rerank to get top 5 most relevant
            top_results = await service.rerank_results(
                query="invoice terms",
                results=candidates,
                top_n=5
            )
        """
        if not results or len(results) == 0:
            logger.info("No results to rerank")
            return results

        # Filter out error results before reranking
        valid_results = [r for r in results if "error" not in r]
        if not valid_results:
            logger.warning("No valid results to rerank")
            return results

        try:
            logger.info(
                f"Reranking {len(valid_results)} results with {RERANK_MODEL} "
                f"(returning top {top_n})"
            )

            # Prepare documents for reranking
            # Format: list of dicts with id and the text field to rank by
            documents = []
            for i, result in enumerate(valid_results):
                doc = {
                    "id": result.get("id", str(i)),
                    rank_field: result.get(rank_field, result.get("content", "")),
                }
                documents.append(doc)

            # Call Pinecone rerank API
            rerank_response = await asyncio.to_thread(
                self.pc.inference.rerank,
                model=RERANK_MODEL,
                query=query,
                documents=documents,
                top_n=min(top_n, len(documents)),
                rank_fields=[rank_field],
                return_documents=True,
                parameters={"truncate": "END"},  # Truncate long docs at end
            )

            # Map reranked results back to original result objects with new scores
            reranked_results = []
            for item in rerank_response.data:
                original_index = item.index
                rerank_score = item.score  # Normalized 0-1, higher is more relevant

                # Get the original result and update its score
                original_result = valid_results[original_index].copy()
                original_result["original_score"] = original_result.get("score", 0)
                original_result["score"] = rerank_score
                original_result["reranked"] = True
                original_result["rerank_model"] = RERANK_MODEL

                reranked_results.append(original_result)

            top_score = reranked_results[0]["score"] if reranked_results else 0.0
            logger.info(
                f"Reranking complete: returned {len(reranked_results)} results "
                f"(top score: {top_score:.4f})"
            )
            return reranked_results

        except Exception as e:
            logger.error(f"Error reranking results: {e}")
            # On error, return original results unchanged
            return valid_results[:top_n]

    async def hybrid_search_with_rerank(
        self,
        query: str,
        limit: int = 5,
        namespace: Optional[str] = None,
        filter_metadata: Optional[Dict[str, Any]] = None,
        alpha: float = DEFAULT_HYBRID_ALPHA,
        similarity_threshold: float = 0.0,
        rerank: bool = DEFAULT_RERANK_ENABLED,
        rerank_candidates_multiplier: int = RERANK_CANDIDATE_MULTIPLIER,
    ) -> List[Dict[str, Any]]:
        """
        Perform hybrid search with optional reranking for improved relevance.

        This is the recommended search method for RAG pipelines as it combines:
        1. Hybrid search (semantic + lexical) for broad candidate retrieval
        2. Cross-encoder reranking for precise relevance ordering

        The two-stage approach retrieves more candidates initially, then uses
        a more accurate (but slower) reranking model to select the best matches.

        Args:
            query: The search query text
            limit: Final number of results to return (after reranking)
            namespace: Namespace to search in (entity_id for multi-tenancy)
            filter_metadata: Optional metadata filter (e.g., document_category)
            alpha: Balance between semantic and lexical search (0.0 to 1.0)
            similarity_threshold: Minimum score for initial results
            rerank: Whether to apply reranking (default: True)
            rerank_candidates_multiplier: How many more candidates to retrieve
                for reranking (default: 3x the limit)

        Returns:
            List of search results, reranked for optimal relevance

        Example:
            # Search with reranking (recommended for RAG)
            results = await service.hybrid_search_with_rerank(
                query="What are the payment terms?",
                limit=5,  # Get top 5 after reranking
                filter_metadata={"document_category": {"$eq": "invoice"}}
            )

            # Without reranking (faster, less accurate)
            results = await service.hybrid_search_with_rerank(
                query="invoice total",
                limit=5,
                rerank=False
            )
        """
        # If reranking is disabled, just do normal hybrid search
        if not rerank:
            return await self.hybrid_search(
                query=query,
                limit=limit,
                namespace=namespace,
                filter_metadata=filter_metadata,
                alpha=alpha,
                similarity_threshold=similarity_threshold,
            )

        # Retrieve more candidates for reranking
        candidate_limit = limit * rerank_candidates_multiplier
        logger.info(
            f"Hybrid search with rerank: retrieving {candidate_limit} candidates "
            f"for top {limit} results"
        )

        # Stage 1: Retrieve candidates with hybrid search
        candidates = await self.hybrid_search(
            query=query,
            limit=candidate_limit,
            namespace=namespace,
            filter_metadata=filter_metadata,
            alpha=alpha,
            similarity_threshold=similarity_threshold,
        )

        # Check for errors in candidates
        if candidates and "error" in candidates[0]:
            return candidates

        # Stage 2: Rerank candidates to get final results
        reranked_results = await self.rerank_results(
            query=query,
            results=candidates,
            top_n=limit,
        )

        return reranked_results

    async def search_across_namespaces(
        self,
        query: str,
        namespaces: List[str],
        limit: int = 5,
        filter_metadata: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search across multiple namespaces (tenants) and merge results.

        Useful for admin queries or cross-tenant search scenarios.

        Args:
            query: The search query text
            namespaces: List of namespaces to search
            limit: Maximum number of results per namespace
            filter_metadata: Optional metadata filter

        Returns:
            Merged and ranked list of results from all namespaces
        """
        try:
            query_embedding = await asyncio.to_thread(
                self.embeddings.embed_query, query
            )

            # Use Pinecone's query_namespaces for efficient parallel search
            response = await asyncio.to_thread(
                self.index.query_namespaces,
                vector=query_embedding,
                namespaces=namespaces,
                top_k=limit,
                include_metadata=True,
                filter=filter_metadata,
            )

            results = []
            for match in response.matches:
                metadata = match.metadata or {}
                results.append(
                    {
                        "id": match.id,
                        "score": match.score,
                        "namespace": match.namespace,
                        "content": metadata.get("text", ""),
                        "metadata": metadata,
                    }
                )

            return results

        except Exception as e:
            logger.error(f"Error searching across namespaces: {e}")
            return [{"error": str(e)}]

    async def delete_file_embeddings(
        self,
        filename: Optional[str] = None,
        document_id: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> bool:
        """
        Delete all embeddings for a specific file using hierarchical IDs.

        This uses Pinecone's list operation with prefix to find all vectors
        for a document, then deletes them by ID (more efficient than metadata filter).

        Args:
            filename: The file_name (used to generate document_id if document_id not provided)
            document_id: The document_id prefix for vectors
            namespace: The namespace containing the vectors

        Returns:
            True if deletion was successful
        """
        try:
            search_namespace = namespace if namespace else DEFAULT_NAMESPACE

            # Determine the document ID prefix
            if document_id:
                prefix = document_id
            elif filename:
                # Generate a prefix pattern from filename
                clean_name = re.sub(r"[^a-zA-Z0-9]", "-", filename.lower())[:30]
                prefix = clean_name
            else:
                logger.error("Must provide either filename or document_id")
                return False

            logger.info(
                f"Deleting vectors with prefix: {prefix} from namespace: {search_namespace}"
            )

            # List all vectors with the document ID prefix
            vector_ids = []

            # Paginate through all matching vectors
            list_response = await asyncio.to_thread(
                self.index.list,
                prefix=prefix,
                namespace=search_namespace,
            )

            # Handle pagination
            while True:
                for vector in list_response.vectors:
                    vector_ids.append(vector.id)

                if list_response.pagination and list_response.pagination.next:
                    list_response = await asyncio.to_thread(
                        self.index.list,
                        prefix=prefix,
                        namespace=search_namespace,
                        pagination_token=list_response.pagination.next,
                    )
                else:
                    break

            if not vector_ids:
                logger.warning(f"No vectors found with prefix: {prefix}")
                return True  # Nothing to delete is still success

            # Delete vectors in batches
            batch_size = 1000  # Pinecone limit
            for i in range(0, len(vector_ids), batch_size):
                batch = vector_ids[i : i + batch_size]
                await asyncio.to_thread(
                    self.index.delete,
                    ids=batch,
                    namespace=search_namespace,
                )

            logger.info(f"Deleted {len(vector_ids)} vectors for document: {prefix}")
            return True

        except Exception as e:
            logger.error(f"Error deleting embeddings: {e}")
            return False

    async def delete_namespace(self, namespace: str) -> bool:
        """
        Delete an entire namespace (all documents for a tenant).

        Useful for tenant offboarding or data cleanup.

        Args:
            namespace: The namespace to delete

        Returns:
            True if deletion was successful
        """
        try:
            logger.info(f"Deleting entire namespace: {namespace}")

            await asyncio.to_thread(
                self.index.delete,
                delete_all=True,
                namespace=namespace,
            )

            logger.info(f"Namespace {namespace} deleted successfully")
            return True

        except Exception as e:
            logger.error(f"Error deleting namespace: {e}")
            return False

    async def get_index_stats(self) -> Dict[str, Any]:
        """Get statistics about the Pinecone index."""
        try:
            stats = await asyncio.to_thread(self.index.describe_index_stats)
            return {
                "dimension": stats.dimension,
                "total_vector_count": stats.total_vector_count,
                "namespaces": {
                    ns: {"vector_count": data.vector_count}
                    for ns, data in stats.namespaces.items()
                },
            }
        except Exception as e:
            logger.error(f"Error getting index stats: {e}")
            return {"error": str(e)}

    async def health_check(self) -> Dict[str, Any]:
        """Check if the embedding service is healthy."""
        try:
            # Test embedding model
            def generate_test_embedding():
                return self.embeddings.embed_query("test query")

            embedding_result = await asyncio.to_thread(generate_test_embedding)

            # Test Pinecone connection
            stats = await asyncio.to_thread(self.index.describe_index_stats)

            return {
                "status": "healthy",
                "embedding_model": EMBEDDING_MODEL,
                "embedding_dimensions": len(embedding_result),
                "pinecone_index": PINECONE_INDEX_NAME,
                "total_vectors": stats.total_vector_count,
                "namespaces": list(stats.namespaces.keys()),
            }
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
            }


# =============================================================================
# GLOBAL SERVICE INSTANCE
# =============================================================================

# Lazy initialization to avoid startup errors if Pinecone is not configured
_embedding_service = None


def get_embedding_service() -> EmbeddingService:
    """Get or create the global embedding service instance."""
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service
