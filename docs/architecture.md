# ThreadWise Architecture Documentation

## Overview

ThreadWise is an AI-powered conversational business intelligence platform that replaces traditional dashboards with a chat-based interface for data analysis and financial reporting. The system is built with a modern microservices architecture using React Router 7 for the frontend and a Python-based AI agent powered by LangGraph.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ThreadWise Platform                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────┐      ┌─────────────────────────────────┐  │
│  │       Chat UI (React)       │      │       AI Agent (Python)          │  │
│  │       Port: 5173            │◄────►│       Port: 8000/2024            │  │
│  │                             │      │                                   │  │
│  │  ┌───────────────────────┐  │      │  ┌─────────────────────────────┐ │  │
│  │  │   React Router 7      │  │      │  │      LangGraph Server       │ │  │
│  │  │   with SSR            │  │      │  │      (Graph Agent)          │ │  │
│  │  └───────────────────────┘  │      │  └─────────────────────────────┘ │  │
│  │                             │      │                                   │  │
│  │  ┌───────────────────────┐  │      │  ┌─────────────────────────────┐ │  │
│  │  │   LangGraph SDK       │  │      │  │      FastAPI Server         │ │  │
│  │  │   (useStream hook)    │  │      │  │      (Embeddings API)       │ │  │
│  │  └───────────────────────┘  │      │  └─────────────────────────────┘ │  │
│  │                             │      │                                   │  │
│  │  ┌───────────────────────┐  │      │  ┌─────────────────────────────┐ │  │
│  │  │   Generative UI       │  │      │  │      SQL Tools              │ │  │
│  │  │   (Charts/Tables)     │  │      │  │      (PostgreSQL/Supabase)  │ │  │
│  │  └───────────────────────┘  │      │  └─────────────────────────────┘ │  │
│  └─────────────────────────────┘      └─────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                           Supabase                                     │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │  PostgreSQL │  │    Auth     │  │   Storage   │  │   Vectors   │  │  │
│  │  │  (Data)     │  │  (Users)    │  │   (Files)   │  │ (Embeddings)│  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Chat UI (`apps/chat-ui/`)

The frontend application built with React Router 7, providing a modern chat-based interface for business intelligence.

**Technology Stack:**

- React 19 with React Router 7 (SSR-enabled)
- TypeScript
- Tailwind CSS 4
- LangGraph SDK for AI streaming
- Nivo for data visualizations
- Supabase JS for authentication

**Key Features:**

- Real-time chat streaming with AI responses
- Generative UI components (charts, tables, metric cards)
- Thread-based conversation management
- File upload and document extraction
- Mobile-responsive design with sidebar navigation
- Dark mode by default

### 2. AI Agent (`apps/ai_agent/`)

The Python-based backend that handles all AI processing, data analysis, and database queries.

**Technology Stack:**

- Python 3.13+
- LangGraph for agent orchestration
- FastAPI for HTTP endpoints
- LangChain for LLM integrations
- PostgreSQL via SQLDatabase toolkit
- Sentence Transformers for embeddings

**Key Features:**

- Multi-node graph-based agent architecture
- Query classification (analytics, generic, document extraction)
- SQL-powered data exploration
- Document extraction from PDFs/images
- Semantic search with vector embeddings
- Generative UI message streaming

## Data Flow

### Chat Message Flow

```
User Input → Chat UI → LangGraph SDK → AI Agent Graph
                                              │
                                              ▼
                               ┌──────────────────────────┐
                               │   classify_query_node    │
                               │   (analytics/generic/    │
                               │    document_extraction)  │
                               └────────────┬─────────────┘
                                            │
                               ┌────────────▼─────────────┐
                               │  retrieve_context_node   │
                               │  (Semantic Search)       │
                               └────────────┬─────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
          ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
          │ generic_response│    │ analytics_agent │    │extract_document │
          │     (chat)      │    │   (SQL tools)   │    │   (multimodal)  │
          └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
                   │                      │                      │
                   │             ┌────────▼────────┐             │
                   │             │push_visualization│             │
                   │             │  (Generative UI) │             │
                   │             └────────┬────────┘             │
                   │                      │                      │
                   └──────────────────────┼──────────────────────┘
                                          │
                                          ▼
                              AI Response + UI Messages
                                          │
                                          ▼
                                Chat UI (Renders Response)
```

## Agent Graph Architecture

The AI agent uses a LangGraph StateGraph with the following nodes:

| Node                 | Purpose                                     | Output                |
| -------------------- | ------------------------------------------- | --------------------- |
| `classify_query`     | Routes user queries to appropriate handlers | `query_type`          |
| `retrieve_context`   | Fetches relevant context from vector store  | `retrieved_context`   |
| `generic_response`   | Handles conversational queries              | AI message            |
| `analytics_agent`    | Executes SQL queries and data analysis      | AI message + data     |
| `extract_document`   | Processes uploaded files (PDF/images)       | Structured extraction |
| `push_visualization` | Generates UI components for data            | UI messages           |

## Integration Points

### Database Connection

The agent connects to Supabase PostgreSQL using the `SQLDatabaseToolkit`:

```python
# Connection via environment variable
database_url = os.getenv("DATABASE_URL", "postgresql://...")
db = SQLDatabase.from_uri(database_url)
toolkit = SQLDatabaseToolkit(db=db, llm=model)
```

### LLM Configuration

The system supports multiple LLM backends:

- **Local LLM**: LM Studio compatible (Qwen, Llama, etc.)
- **Google Gemini**: Cloud-based via LangChain

```python
# Local model via LM Studio
local_model = get_local_llm("qwen/qwen3-vl-4b")

# Gemini via Google AI
gemini = get_chat_model("google_genai:gemini-2.5-flash-lite")
```

### Embedding Service

Vector embeddings for semantic search:

- Model: `BAAI/bge-small-en`
- Storage: Supabase Vector Store
- Table: `documents`

## Port Configuration

| Service              | Development Port | Docker Port |
| -------------------- | ---------------- | ----------- |
| Chat UI              | 5173             | 3000        |
| AI Agent (LangGraph) | 2024             | 8100        |
| AI Agent (FastAPI)   | 8000             | 8100        |
| Supabase             | 8000 (API)       | -           |
| PostgreSQL           | 5432/5435        | -           |
| LM Studio            | 1234             | -           |

## Security Considerations

1. **Authentication**: Supabase Auth with JWT tokens
2. **API Keys**: Environment variables for sensitive data
3. **CORS**: Configured per-environment (dev allows `*`)
4. **Database**: Row Level Security (RLS) via Supabase

## Development Commands

```bash
# Start all services
pnpm dev

# Start individual services
pnpm dev:react-router   # Chat UI
pnpm dev:ai-agent       # LangGraph dev server

# Build for production
pnpm build

# Docker development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```
