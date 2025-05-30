# 🐳 Docker Quick Reference

## Development Workflow

### Quick Start (Development)

```bash
# Start everything in development mode with hot reload
make docker-dev
# or
pnpm docker:dev

# View logs
make docker-logs

# Stop everything
make docker-down
```

### Production Build

```bash
# Build and start production containers
make docker-up
# or
pnpm docker:up
```

## Service URLs

- **React Router**: http://localhost:3000
- **AI Agent API**: http://localhost:8000
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379

## Container Details

### React Router Container

- **Base**: Node 20 Alpine with pnpm
- **Port**: 3000
- **Volume Mounts**: Full app directory (dev mode)
- **Hot Reload**: ✅ Enabled in dev mode

### AI Agent Container

- **Base**: Python 3.13 Alpine with Poetry
- **Port**: 8000
- **Volume Mounts**: App directory (dev mode)
- **Hot Reload**: ✅ Enabled in dev mode

### Database Services

- **PostgreSQL 16**: Ready for Supabase compatibility
- **Redis 7**: For caching and sessions

## Troubleshooting

### Common Issues

1. **Port conflicts**: Change ports in docker-compose.yml if needed
2. **Build failures**: Run `make docker-build` to rebuild images
3. **Permission issues**: Ensure Docker daemon is running

### Reset Everything

```bash
make docker-down
docker system prune -f
make docker-build
```

## File Structure

```
├── docker-compose.yml           # Production config
├── docker-compose.dev.yml       # Development overrides
├── .dockerignore                # Root build context exclusions
├── apps/react-router/
│   ├── Dockerfile               # Multi-stage pnpm build
│   └── .dockerignore           # App-specific exclusions
└── apps/ai-agent/
    └── Dockerfile               # Python Poetry build
```
