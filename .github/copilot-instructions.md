# ThreadWise Copilot Instructions

## Project Overview

ThreadWise is a conversational AI platform that replaces traditional dashboards with a chat-based interface for business intelligence. The architecture centers around two main applications communicating to provide an agent-centric experience.

## Architecture & Service Boundaries

### Core Applications

- **React Router App** (`apps/react-router/`) - Frontend chat interface on port 5173
- **AI Agent API** (`apps/ai-agent/`) - Python FastAPI backend on port 8000
- **Shared Packages** (`packages/`) - Currently empty but planned for Prisma, Supabase, and ETL modules

### Data Flow

The frontend sends chat messages to the AI agent, which processes them and returns structured responses. The agent will integrate with external services (Revolut, Squarespace) through ETL pipelines and maintain conversation context using Model Context Protocol (MCP).

## Development Workflow

### Essential Commands

```bash
# Primary development (runs both apps concurrently)
pnpm dev                    # or: make dev

# Individual services
pnpm dev:react-router      # or: make dev-web (port 5173)
pnpm dev:ai-agent         # or: make dev-api (port 8000)

# VS Code Tasks (preferred)
Cmd/Ctrl+Shift+P → "Tasks: Run Task" → "🚀 Start All Apps (Dev)"
```

### Poetry + pnpm Hybrid Setup

- **Frontend**: pnpm workspace in `apps/react-router/`
- **Backend**: Poetry environment in `apps/ai-agent/`
- **Root**: pnpm manages orchestration scripts and frontend deps

Initial setup: `pnpm setup` (installs pnpm deps + runs `poetry install` in ai-agent)

### VS Code Integration

- Use VS Code tasks instead of terminal commands - they're pre-configured with proper backgrounds and problem matchers
- Debug configurations available in `launch.json` for Python debugging
- Tasks auto-handle concurrent process management

## Project-Specific Patterns

### Frontend (React Router 7)

- **Route Structure**: Single index route in `routes/home.tsx` → `LandingPage` component
- **Styling**: Tailwind CSS with dark mode support via `@apply` utilities
- **Chat Interface**: Message state managed locally with TypeScript interfaces
- **Build Target**: Server-side rendering with static asset optimization

### Backend (FastAPI + Poetry)

- **Entry Point**: `src/ai_agent/main.py` with uvicorn server
- **Code Quality**: Black (88 chars), isort, flake8, mypy, bandit via pre-commit hooks
- **Development**: Hot reload via `--reload` flag in development scripts
- **Python Version**: 3.13+ required (specified in pyproject.toml)

### Code Quality Pipeline

Pre-commit hooks run automatically on commits:

- **Python files**: Black formatting, isort imports, flake8 linting, mypy typing, bandit security
- **All files**: Prettier formatting, ESLint rules, trailing whitespace cleanup
- **Husky integration**: Pre-commit config managed at root level

## Docker Architecture

### Development vs Production

- **Development**: `docker-compose -f docker-compose.yml -f docker-compose.dev.yml up`
- **Production**: `docker-compose up -d`
- **Key difference**: Dev mode mounts source volumes for hot reload

### Port Mapping

- React Router: 3000 (container) → 3000 (host)
- AI Agent: 8100 (container) → 8100 (host)
- Note: Development ports differ (5173, 8000) from Docker ports

## Integration Points

### Planned Integrations

- **Supabase**: Postgres DB + auth (packages/supabase - currently empty)
- **Prisma**: Type-safe ORM layer (packages/prisma - currently empty)
- **External APIs**: Revolut, Squarespace via ETL (packages/etl - currently empty)
- **MCP**: Model Context Protocol for persistent agent memory

### Message Flow Pattern

Frontend chat → POST /messages → AI processing → Structured response → Frontend update
Current implementation uses in-memory storage; production will use Supabase.

## Key Conventions

### File Organization

- Apps use their native conventions (React Router file-based routing, FastAPI standard structure)
- Shared code goes in `packages/` (when implemented)
- Documentation in `docs/` with architecture diagrams

### Development Scripts

- All major commands work via pnpm, make, OR VS Code tasks
- Prefer VS Code tasks for development (better UX, integrated terminals)
- Use `make help` to see all available commands with descriptions

### Environment Management

- Python dependencies: Poetry only (no pip, no conda)
- Node dependencies: pnpm workspaces (no npm, no yarn)
- Always run `poetry install` from within `apps/ai-agent/` directory

## Debugging Notes

### Common Issues

- **Port conflicts**: React Router dev (5173) vs Docker (3000)
- **Python path**: AI Agent uses `PYTHONPATH=/app/src` in containers
- **Hot reload**: Requires volume mounts in Docker dev mode
- **Poetry**: Must be run from `apps/ai-agent/` directory, not root

### Error Patterns

- Missing dependencies: Run `pnpm setup` to reinstall everything
- Python import errors: Check PYTHONPATH and virtual environment activation
- Docker build failures: Often due to Poetry cache, try `make docker-build`

### Performance

- Concurrent development via `concurrently` package with color-coded output
- Background tasks properly configured in VS Code tasks.json
- Pre-commit hooks only run on changed files for speed
