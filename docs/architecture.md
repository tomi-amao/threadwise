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

- A tool-calling chat agent over the signed-in user's own data (read-only)
- Typed tools for the common questions, with checked SQL as a fallback
- Provider sync and normalisation (Shopify, Revolut, PayPal, Squarespace, Zoho Calendar)
- A double-entry ledger generated from that data
- Document search with vector embeddings

Details: [apps/ai_agent/docs](../apps/ai_agent/docs/README.md).

## Data Flow

### Chat Message Flow

```
User Input → Chat UI → LangGraph SDK (Supabase token) → LangGraph server
                                                              │
                                                  auth.py: verify the token,
                                                  find the user's business
                                                              │
                                                              ▼
                                            Chat agent (one tool-calling loop)
                                                              │
                              ┌───────────────────────────────┼─────────────────────┐
                              ▼                               ▼                     ▼
                     typed data tools                    run_sql (fallback)   search_documents
                     (fixed SQL)                         (parsed, checked)    (own namespace)
                              └───────────────┬───────────────┘
                                              ▼
                       Postgres as the signed-in user, row-level security on
                                              │
                                              ▼
                                     AI response (streamed)
                                              │
                                              ▼
                                    Chat UI (renders the response)
```

## Agent Architecture

The agent is a single `create_agent` loop: the model decides which tools to call, with middleware
for the cross-cutting parts (refusing anonymous runs, business context in the prompt, summarising
long threads, call limits, retries, a fallback model). It cannot write anything. Every figure it
states comes from a tool result, and the tools use the same definitions as the app's pages.

See [chat-agent.md](../apps/ai_agent/docs/chat-agent.md) for the tools and middleware, and
[security.md](../apps/ai_agent/docs/security.md) for how the database access is scoped.

## Integration Points

### Database Connection

The agent's SQL runs as the signed-in user inside a read-only transaction with row-level security
on (`core/scoped_sql.py`), so it can only see that user's business. The rest of the backend uses
the Supabase service-role client, which bypasses RLS and is only used after the caller has been
checked. See [architecture.md](../apps/ai_agent/docs/architecture.md#two-database-paths-do-not-mix-them-up).

### LLM Configuration

Models are settings (`AGENT_MODEL`, `AGENT_FALLBACK_MODEL`, `AGENT_SMALL_MODEL`), written as
provider-prefixed ids for LangChain's `init_chat_model`; the default is Gemini
(`google_genai:gemini-3.5-flash`, with `gemini-2.5-flash` as the fallback). A local OpenAI-compatible
server (LM Studio) remains available for development.

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
