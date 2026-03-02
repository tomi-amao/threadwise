# AI Agent Documentation

## Overview

The ThreadWise AI Agent is a Python-based intelligent assistant built with LangGraph that provides conversational business intelligence capabilities. It processes natural language queries, executes SQL against your database, extracts data from documents, and generates visualizations.

## Directory Structure

```
apps/ai_agent/
├── agent.py                 # Legacy agent setup (deprecated)
├── graph_agent.py           # Main LangGraph agent (982 lines)
├── langgraph.json           # LangGraph server configuration
├── pyproject.toml           # Python dependencies (Poetry)
├── src/
│   └── ai_agent/
│       ├── main.py          # FastAPI application
│       └── services/
│           ├── embedding_service.py  # Vector embeddings
│           └── langgraph_service.py  # LangGraph integration
├── utils/
│   ├── database.py          # Database utilities
│   ├── embeddings.py        # Embedding helpers
│   ├── nodes.py             # Legacy node functions
│   ├── prompts.py           # System prompts (894 lines)
│   ├── settings.py          # LLM configuration
│   ├── state.py             # State schemas
│   ├── sub_agents.py        # Sub-agent definitions
│   └── tools.py             # SQL toolkit setup
└── tests/
    └── __init__.py
```

## Core Components

### 1. Graph Agent (`graph_agent.py`)

The main agent implementation using LangGraph's StateGraph API.

#### State Schema

```python
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]
    query_type: Literal["analytics", "generic", "document_extraction"] | None
    sql_result: str | None
    has_file_attachment: bool | None
    extracted_document: dict | None
    model: str | None
    retrieved_context: list[dict] | None
```

#### Query Classification

The agent classifies incoming queries into three categories:

| Type                  | Description                    | Example Queries                    |
| --------------------- | ------------------------------ | ---------------------------------- |
| `analytics`           | Data exploration requiring SQL | "Show top 10 customers by revenue" |
| `generic`             | Conversational, no DB access   | "What is a balance sheet?"         |
| `document_extraction` | File uploads for parsing       | PDF/image attachments              |

#### Node Functions

**`classify_query_node`**

- Analyzes user messages for query intent
- Detects file attachments for document extraction
- Uses structured output for reliable classification

**`retrieve_context_node`**

- Performs semantic search on vector store
- Retrieves up to 5 relevant context documents
- Enriches queries with knowledge base information

**`generic_response_node`**

- Handles conversational queries
- Provides financial concept explanations
- Uses retrieved context when available

**`analytics_agent_node`**

- Creates sub-agent with SQL tools
- Executes database queries
- Generates insights and summaries

**`extract_document_node`**

- Processes PDF and image uploads
- Uses multimodal LLM for extraction
- Returns structured invoice/document data

**`push_visualization_node`**

- Analyzes responses for visualization opportunities
- Pushes Generative UI components
- Supports bar, pie, line charts, tables, and metric cards

### 2. Document Extraction

The agent can extract structured data from financial documents:

```python
class ExtractedDocumentData(BaseModel):
    document_category: Literal[
        "invoice", "receipt", "credit_memo", "purchase_order",
        "bank_statement", "expense_report", "contract", "other"
    ]
    vendor_name: str | None
    vendor_address: str | None
    vendor_tax_id: str | None
    invoice_number: str | None
    invoice_date: str | None
    due_date: str | None
    currency: str
    subtotal: float | None
    tax_amount: float | None
    total_amount: float | None
    line_items: list[ExtractedLineItem]
    confidence_score: float
```

### 3. SQL Tools

The agent uses LangChain's SQLDatabaseToolkit:

| Tool                   | Purpose                        |
| ---------------------- | ------------------------------ |
| `sql_db_list_tables`   | List available database tables |
| `sql_db_schema`        | Get table schema definitions   |
| `sql_db_query_checker` | Validate SQL before execution  |
| `sql_db_query`         | Execute SQL queries            |

### 4. Embedding Service

Vector embeddings for semantic search:

```python
class EmbeddingService:
    def __init__(self):
        self.embeddings = HuggingFaceEmbeddings(model_name="BAAI/bge-small-en")
        self.supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    async def search_documents(self, query: str, limit: int = 5):
        # Semantic search in vector store
        ...
```

## System Prompts

### Analytics Prompt

The analytics system prompt instructs the agent to:

- Handle ad-hoc data exploration queries
- Execute efficient SQL (one query per question)
- Present results in Markdown tables
- Provide actionable insights
- Stop after providing complete answers

### SQL System Prompt (Financial Reports)

For generating financial reports:

- Income Statement (P&L)
- Balance Sheet
- Cash Flow Statement

Key constraints:

- PostgreSQL syntax (use `::DATE` not `DATE()`)
- Proper JOINs for journal entries and accounts
- Case sensitivity handling

### Generic Prompt

For conversational queries:

- Financial concept explanations
- Business advice
- System usage guidance

## Configuration

### LangGraph Server (`langgraph.json`)

```json
{
  "dependencies": [".", "utils"],
  "graphs": {
    "threadwise-financial-agent": "./graph_agent.py:agent"
  },
  "env": ".env",
  "http": {
    "app": "./src/ai_agent/main.py:app",
    "cors": {
      "allow_origins": ["*"]
    }
  }
}
```

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://...

# Supabase
SUPABASE_URL=http://localhost:8000
SUPABASE_KEY=your-service-role-key

# LLM (optional - for cloud models)
GOOGLE_API_KEY=your-google-api-key
```

### LLM Settings (`utils/settings.py`)

```python
def get_local_llm(model_name: str = "local-model"):
    return ChatOpenAI(
        model=model_name,
        base_url="http://localhost:1234/v1",  # LM Studio
        api_key="not-needed",
        temperature=0.7,
        streaming=True,
    )

def get_chat_model(model: str = "google_genai:gemini-2.5-flash-lite"):
    return init_chat_model(model)
```

## Running the Agent

### Development Mode

```bash
cd apps/ai_agent

# Using Poetry
poetry run langgraph dev

# Or via pnpm (from root)
pnpm dev:ai-agent
```

### Production Mode

```bash
# Build and run
poetry run langgraph up
```

## API Endpoints

### FastAPI Application (`src/ai_agent/main.py`)

| Endpoint      | Method | Description         |
| ------------- | ------ | ------------------- |
| `/`           | GET    | Health check        |
| `/embed/file` | POST   | Embed file from URL |
| `/search`     | POST   | Search documents    |
| `/chat`       | POST   | Send chat message   |
| `/threads`    | POST   | Create new thread   |

### LangGraph Server

The LangGraph dev server exposes standard endpoints:

- `POST /threads` - Create threads
- `POST /threads/{id}/runs` - Run agent
- `GET /threads/{id}/state` - Get state
- `GET /threads/{id}/history` - Get history

## Dependencies

Key Python packages:

```toml
[project.dependencies]
fastapi = ">=0.115.12"
langgraph = ">=0.6.6"
langchain-openai = ">=0.3.32"
langchain-community = ">=0.3.28"
langchain-google-genai = ">=4.2.0"
sentence-transformers = ">=3.3.1"
supabase = ">=2.10.0"
PyPDF2 = ">=3.0.0"
```

## Graph Visualization

The compiled agent graph:

```
START
   │
   ▼
┌─────────────────┐
│ classify_query  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│retrieve_context │
└────────┬────────┘
         │
    ┌────┴────┬──────────────┐
    ▼         ▼              ▼
┌────────┐ ┌──────────┐ ┌──────────────┐
│generic │ │analytics │ │extract_doc   │
│response│ │_agent    │ │              │
└────┬───┘ └────┬─────┘ └──────┬───────┘
     │          │              │
     │     ┌────▼─────┐        │
     │     │push_viz  │        │
     │     └────┬─────┘        │
     │          │              │
     └────┬─────┴──────────────┘
          │
          ▼
         END
```

## Troubleshooting

### Common Issues

1. **Database Connection Errors**
   - Verify `DATABASE_URL` in `.env`
   - Check PostgreSQL is running
   - Confirm network connectivity

2. **LLM Connection Issues**
   - Ensure LM Studio is running on port 1234
   - Or configure cloud LLM API keys

3. **Import Errors**
   - Run `poetry install` to install dependencies
   - Check `PYTHONPATH` includes project root

4. **Vector Store Issues**
   - Verify Supabase is running
   - Check `SUPABASE_URL` and `SUPABASE_KEY`
   - Run migration for `documents` table
