# Getting Started with ThreadWise

## Overview

ThreadWise is an AI-powered conversational business intelligence platform. This guide will help you set up the development environment and start building.

## Prerequisites

Before you begin, ensure you have the following installed:

| Tool    | Version | Purpose                      |
| ------- | ------- | ---------------------------- |
| Node.js | 18+     | JavaScript runtime           |
| pnpm    | 8+      | Package manager              |
| Python  | 3.13+   | AI Agent runtime             |
| Poetry  | 1.8+    | Python dependency management |
| Docker  | 24+     | Containerization (optional)  |
| Git     | Latest  | Version control              |

### Optional Tools

- **LM Studio**: For local LLM inference
- **Supabase CLI**: For local Supabase development

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/threadwise.git
cd threadwise
```

### 2. Install Dependencies

```bash
# Install all dependencies (pnpm + poetry)
pnpm setup

# Or manually:
pnpm install
cd apps/ai_agent && poetry install && cd ../..
```

### 3. Configure Environment

Create environment files for each application:

**Chat UI** (`apps/chat-ui/.env`):

```bash
VITE_LANGGRAPH_API_URL=http://localhost:2024
VITE_LANGGRAPH_ASSISTANT_ID=threadwise-financial-agent
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_ANON_KEY=your-anon-key
```

**AI Agent** (`apps/ai_agent/.env`):

```bash
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres
SUPABASE_URL=http://localhost:8000
SUPABASE_KEY=your-service-role-key
GOOGLE_API_KEY=your-google-api-key  # Optional, for Gemini
```

### 4. Start Development Servers

**Option A: Start All Services**

```bash
pnpm dev
```

**Option B: Start Individual Services**

```bash
# Terminal 1: Chat UI
pnpm dev:react-router

# Terminal 2: AI Agent
pnpm dev:ai-agent
```

**Option C: VS Code Tasks**

- Press `Cmd/Ctrl+Shift+P`
- Select "Tasks: Run Task"
- Choose "🚀 Start All Apps (Dev)"

### 5. Access the Application

- **Chat UI**: http://localhost:5173
- **AI Agent (LangGraph)**: http://localhost:2024
- **AI Agent (FastAPI)**: http://localhost:8000

## Project Structure

```
threadwise/
├── apps/
│   ├── ai_agent/       # Python AI agent (LangGraph + FastAPI)
│   └── chat-ui/        # React frontend (React Router 7)
├── docs/               # Documentation
├── infrastructure/     # Docker & Supabase config
├── scripts/            # Utility scripts
├── package.json        # Root package.json
├── pnpm-workspace.yaml # Workspace configuration
└── Makefile            # Common commands
```

## Development Workflow

### Running Commands

You have three options for running commands:

```bash
# Using pnpm
pnpm dev
pnpm build
pnpm test

# Using Make
make dev
make build
make test

# Using VS Code Tasks (recommended)
# Cmd/Ctrl+Shift+P → "Tasks: Run Task"
```

### Code Quality

Pre-commit hooks automatically run on commits:

- **Python**: Black, isort, flake8, mypy, bandit
- **TypeScript**: ESLint, Prettier
- **All files**: Trailing whitespace cleanup

Run manually:

```bash
# Install hooks
pnpm setup

# Run all checks
pre-commit run --all-files
```

## Setting Up Local LLM (LM Studio)

ThreadWise supports local LLM inference via LM Studio:

1. Download [LM Studio](https://lmstudio.ai/)
2. Download a model (e.g., `qwen/qwen3-vl-4b`)
3. Start the local server on port 1234
4. The AI agent will automatically connect

## Setting Up Supabase

### Option A: Cloud Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Copy your project URL and keys
3. Update environment variables

### Option B: Local Supabase

```bash
cd infrastructure/supabase

# Start Supabase services
docker-compose up -d

# Run setup scripts
./setup-vector-store.sh
```

## Database Schema

The AI agent expects these core tables:

```sql
-- Financial data tables
journal_entries (id, entry_date, reference_type, ...)
journal_entry_lines (id, journal_entry_id, account_id, debit, credit, ...)
accounts (id, name, type, ...)

-- Vector store for embeddings
documents (id, content, metadata, embedding vector(384))
```

## Common Tasks

### Creating a New Thread

The Chat UI automatically creates threads. Programmatically:

```typescript
const thread = await chatProvider.createThread();
```

### Sending a Message

```typescript
await chatProvider.sendMessage('What were our top sales last quarter?');
```

### Uploading a Document

```typescript
await chatProvider.sendMessage('Process this invoice', [
  {
    type: 'file',
    data: base64Data,
    mime_type: 'application/pdf',
    filename: 'invoice.pdf',
  },
]);
```

## Docker Development

### Build and Run

```bash
# Development mode (with hot reload)
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production mode
docker-compose up -d
```

### Port Mapping

| Service  | Container Port | Host Port |
| -------- | -------------- | --------- |
| Chat UI  | 3000           | 3000      |
| AI Agent | 8100           | 8100      |

## Troubleshooting

### AI Agent Won't Start

```bash
# Check Python environment
cd apps/ai_agent
poetry env info
poetry install

# Verify LangGraph
poetry run langgraph dev
```

### Chat UI Connection Issues

```bash
# Check environment variables
cat apps/chat-ui/.env

# Verify AI Agent is running
curl http://localhost:2024/health
```

### Database Connection Errors

```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check Supabase status
docker-compose -f infrastructure/supabase/docker-compose.yml ps
```

### Pre-commit Hook Failures

```bash
# Update hooks
pre-commit autoupdate

# Run specific hook
pre-commit run black --all-files
```

## Next Steps

1. Read the [Architecture Documentation](./architecture.md)
2. Explore the [AI Agent Documentation](./ai-agent.md)
3. Review the [Chat UI Documentation](./chat-ui.md)
4. Check the [API Reference](./api-reference.md)

## Support

- **Issues**: GitHub Issues
- **Documentation**: This docs folder
- **Examples**: Check `examples/` directory (coming soon)
