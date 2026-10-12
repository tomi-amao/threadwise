# ThreadWise Documentation

Welcome to the ThreadWise documentation! ThreadWise is an AI-powered conversational business intelligence platform that replaces traditional dashboards with a chat-based interface for data analysis and financial reporting.

## Documentation Index

| Document                                | Description                                |
| --------------------------------------- | ------------------------------------------ |
| [Getting Started](./getting-started.md) | Quick start guide for development setup    |
| [Architecture](./architecture.md)       | System architecture and component overview |
| [AI Agent](./ai-agent.md)               | Python AI agent with LangGraph             |
| [Chat UI](./chat-ui.md)                 | React frontend documentation               |
| [API Reference](./api-reference.md)     | REST and WebSocket API documentation       |
| [Development Notes](./README.md)        | Original development timeline and notes    |

## Quick Links

### For Developers

- **First time setup?** Start with [Getting Started](./getting-started.md)
- **Understanding the system?** Read [Architecture](./architecture.md)
- **Working on the AI?** See [AI Agent](./ai-agent.md)
- **Working on the UI?** See [Chat UI](./chat-ui.md)
- **Integrating with the API?** Check [API Reference](./api-reference.md)

### Key Technologies

| Component  | Technology                                           |
| ---------- | ---------------------------------------------------- |
| Frontend   | React 19, React Router 7, TypeScript, Tailwind CSS 4 |
| Backend    | Python 3.13+, LangGraph, FastAPI, LangChain          |
| Database   | PostgreSQL (Supabase)                                |
| Embeddings | Sentence Transformers (BGE)                          |
| LLM        | Local (LM Studio) or Gemini                          |

## Project Structure

```
threadwise/
├── apps/
│   ├── ai_agent/     # Python AI agent
│   └── chat-ui/      # React frontend
├── docs/             # This documentation
├── infrastructure/   # Docker & Supabase
└── scripts/          # Utility scripts
```

## Architecture Overview

```
┌─────────────────────┐      ┌─────────────────────┐
│     Chat UI         │◄────►│     AI Agent        │
│   (React Router 7)  │      │   (LangGraph)       │
│     Port: 5173      │      │     Port: 2024      │
└─────────────────────┘      └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │     Supabase        │
                             │  PostgreSQL + Auth  │
                             └─────────────────────┘
```

## Quick Start

```bash
# Clone and setup
git clone https://github.com/your-org/threadwise.git
cd threadwise
pnpm setup

# Start development
pnpm dev
```

See [Getting Started](./getting-started.md) for detailed instructions.

## Getting Help

- Check the relevant documentation above
- Review inline code comments
- Open a GitHub issue for bugs or feature requests
