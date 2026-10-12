# GitHub Actions Workflows Documentation

This directory contains GitHub Actions workflows for continuous integration, deployment, and automation for the ThreadWise project.

## Table of Contents

- [Overview](#overview)
- [Workflows](#workflows)
  - [CI Pipeline](#ci-pipeline)
  - [Docker Build & Push](#docker-build--push)
  - [Code Quality & Security](#code-quality--security)
  - [Release](#release)
  - [Deploy](#deploy)
  - [PR Automation](#pr-automation)
- [Configuration Files](#configuration-files)
- [Secrets Required](#secrets-required)
- [Badge Status](#badge-status)

## Overview

ThreadWise uses a comprehensive CI/CD pipeline powered by GitHub Actions to ensure code quality, security, and reliable deployments. The workflows are designed for a monorepo structure with:

- **Frontend**: React Router app (`apps/chat-ui`)
- **Backend**: FastAPI + LangGraph AI agent (`apps/ai_agent`)
- **Package Manager**: pnpm (frontend) + Poetry (backend)

## Workflows

### CI Pipeline

**File**: `ci.yml`

**Triggers**:

- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

**Jobs**:

#### Frontend Jobs

- **frontend-lint**: Runs Prettier and ESLint checks
- **frontend-typecheck**: Validates TypeScript types
- **frontend-build**: Builds the React Router app

#### Backend Jobs

- **backend-lint**: Checks Black, isort, and flake8 formatting
- **backend-typecheck**: Runs mypy type checking
- **backend-security**: Runs bandit security analysis
- **backend-test**: Executes pytest with coverage reporting
- **backend-build**: Builds Python package with Poetry

**Estimated Duration**: 5-8 minutes

**Caching**:

- pnpm store cache
- Poetry dependencies cache

---

### Docker Build & Push

**File**: `docker.yml`

**Triggers**:

- Push to `main` or `develop` branches (when Docker files change)
- Pull requests affecting Docker files
- Manual dispatch

**Jobs**:

- **build-chat-ui**: Builds and pushes Chat UI Docker image
- **build-ai-agent**: Builds and pushes AI Agent Docker image
- **docker-compose-test**: Validates docker-compose configuration
- **security-scan**: Runs Trivy vulnerability scanner

**Docker Images**:

- `ghcr.io/{owner}/threadwise/chat-ui:latest`
- `ghcr.io/{owner}/threadwise/ai-agent:latest`

**Features**:

- Multi-stage builds with layer caching
- Automatic tagging (branch, PR, SHA, semver)
- Security scanning with Trivy
- SARIF upload to GitHub Security

---

### Code Quality & Security

**File**: `code-quality.yml`

**Triggers**:

- Push to `main` or `develop` branches
- Pull requests
- Weekly schedule (Mondays at 9am UTC)
- Manual dispatch

**Jobs**:

- **codeql-analysis**: GitHub CodeQL security analysis (JavaScript & Python)
- **dependency-review**: Reviews dependency changes in PRs
- **npm-audit**: NPM security audit
- **python-security-audit**: Safety + Bandit security checks
- **secret-scanning**: TruffleHog secret detection
- **code-coverage**: Generates and uploads coverage reports
- **license-check**: Validates dependency licenses

**Security Features**:

- Extended security queries
- License compliance (denies GPL-3.0, LGPL-3.0)
- Secret scanning with verified-only mode
- Codecov integration

---

### Release

**File**: `release.yml`

**Triggers**:

- Push tags matching `v*.*.*` (e.g., v1.2.3)
- Manual dispatch with version input

**Jobs**:

1. **validate-version**: Validates semver format
2. **build-and-test**: Runs full CI pipeline
3. **build-release-artifacts**: Creates release archives
4. **build-and-push-docker**: Builds and tags Docker images with version
5. **generate-changelog**: Auto-generates changelog from commits
6. **create-github-release**: Creates GitHub release with artifacts
7. **notify-release**: Sends deployment summary

**Release Artifacts**:

- Compressed archive: `threadwise-{version}.tar.gz`
- Docker images with version tags
- Changelog with commit history

**Example Usage**:

```bash
# Create and push a tag
git tag v1.0.0
git push origin v1.0.0

# Or use GitHub UI to trigger manually
```

---

### Deploy

**File**: `deploy.yml`

**Triggers**:

- Manual dispatch with environment selection

**Environments**:

- `development`: Single replica, dev URL
- `staging`: 2 replicas, staging URL
- `production`: 3 replicas, production URL (requires approval)

**Jobs**:

1. **validate-deployment**: Validates inputs
2. **pre-deployment-checks**: Verifies Docker images exist
3. **deploy**: Executes deployment (customizable)
4. **run-migrations**: Runs database migrations
5. **health-check**: Validates deployment health
6. **rollback**: Automatic rollback on failure

**Deployment Targets** (Template - Customize):

- SSH + Docker Compose
- Kubernetes
- AWS ECS
- Google Cloud Run

**Production Safeguards**:

- Manual approval required
- Health checks before completing
- Automatic rollback on failure

---

### PR Automation

**File**: `pr-automation.yml`

**Triggers**:

- Pull request events (open, edit, sync, label)

**Jobs**:

- **auto-label**: Labels PRs based on changed files
- **semantic-pr-title**: Validates Conventional Commits format
- **greeting**: Welcomes first-time contributors
- **auto-assign-reviewers**: Assigns reviewers based on files
- **pr-checklist**: Posts PR checklist comment
- **link-issues**: Links related issues from description
- **require-tests**: Warns if tests are missing
- **pr-summary**: Generates statistics comment

**PR Title Format** (Conventional Commits):

```
type(scope): description

Examples:
feat(frontend): add dark mode toggle
fix(backend): resolve authentication bug
docs: update API documentation
chore(deps): update dependencies
```

**Valid Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Valid Scopes**: `frontend`, `backend`, `chat-ui`, `ai-agent`, `deps`, `ci`, `docker`, `db`

---

## Configuration Files

### `.github/dependabot.yml`

Automated dependency updates:

- **GitHub Actions**: Weekly on Monday
- **Frontend (pnpm)**: Weekly on Tuesday
- **Backend (Poetry)**: Weekly on Wednesday
- **Docker**: Weekly on Thursday

**Dependency Grouping**:

- React ecosystem
- AI SDK (LangChain, AI SDK)
- UI libraries (Radix, Tailwind)
- Backend groups (LangChain, FastAPI, testing tools)

**Ignored Updates**:

- Major versions for critical dependencies (React, FastAPI, LangChain)

### `.github/labeler.yml`

Automatic PR labeling based on file paths:

- `frontend`: Changes in `apps/chat-ui/`
- `backend`: Changes in `apps/ai_agent/`
- `dependencies`: Package file changes
- `docker`: Dockerfile or compose changes
- `ci/cd`: Workflow changes
- `documentation`: Markdown files
- `database`: Migration files
- `tests`: Test files
- `security`: Auth/security related files

### `.github/auto-assign.yml`

Reviewer assignment configuration:

- Automatically assigns reviewers based on changed files
- Groups: frontend, backend, infrastructure, ci
- Skips WIP/draft PRs

---

## Secrets Required

Configure these secrets in GitHub repository settings:

### Required for CI/CD

```
CODECOV_TOKEN           # Codecov integration (optional)
```

### Required for Build

```
VITE_API_URL            # Frontend API URL
VITE_SUPABASE_URL       # Supabase project URL
VITE_SUPABASE_ANON_KEY  # Supabase anonymous key
```

### Required for Deployment

```
DATABASE_URL            # PostgreSQL connection string
OPENAI_API_KEY          # OpenAI API key
```

### Optional

```
GITHUB_TOKEN            # Automatically provided by GitHub Actions
```

---

## Badge Status

Add these badges to your README.md:

```markdown
[![CI Pipeline](https://github.com/{owner}/{repo}/actions/workflows/ci.yml/badge.svg)](https://github.com/{owner}/{repo}/actions/workflows/ci.yml)
[![Docker Build](https://github.com/{owner}/{repo}/actions/workflows/docker.yml/badge.svg)](https://github.com/{owner}/{repo}/actions/workflows/docker.yml)
[![Code Quality](https://github.com/{owner}/{repo}/actions/workflows/code-quality.yml/badge.svg)](https://github.com/{owner}/{repo}/actions/workflows/code-quality.yml)
[![codecov](https://codecov.io/gh/{owner}/{repo}/branch/main/graph/badge.svg)](https://codecov.io/gh/{owner}/{repo})
```

---

## Best Practices

### For Contributors

1. **PR Title**: Use Conventional Commits format
2. **Tests**: Add tests for new features
3. **Documentation**: Update docs for public APIs
4. **Security**: Never commit secrets or API keys
5. **Code Style**: Pre-commit hooks will enforce style

### For Maintainers

1. **Version Tags**: Use semantic versioning (v1.2.3)
2. **Release Notes**: Leverage auto-generated changelogs
3. **Security**: Review Dependabot PRs promptly
4. **Deployments**: Always test in staging before production

---

## Troubleshooting

### CI Failures

**Frontend Lint Failures**:

```bash
pnpm lint --fix
pnpm format
```

**Backend Lint Failures**:

```bash
cd apps/ai_agent
poetry run black src/ tests/
poetry run isort src/ tests/
```

**Type Check Failures**:

```bash
# Frontend
pnpm typecheck:react-router

# Backend
cd apps/ai_agent
poetry run mypy src/
```

### Docker Build Failures

**Clear cache and rebuild**:

```bash
docker builder prune
docker buildx prune
```

### Deployment Failures

1. Check Docker image exists in registry
2. Verify environment secrets are configured
3. Review deployment logs in GitHub Actions
4. Check health check endpoints

---

## Workflow Diagram

```
┌─────────────────┐
│   Push/PR       │
└────────┬────────┘
         │
         ├─────────────────┐
         │                 │
    ┌────▼─────┐    ┌─────▼──────┐
    │  CI      │    │  Code      │
    │  Pipeline│    │  Quality   │
    └────┬─────┘    └─────┬──────┘
         │                │
         └────────┬───────┘
                  │
            ┌─────▼──────┐
            │   Docker   │
            │   Build    │
            └─────┬──────┘
                  │
            ┌─────▼──────┐
            │  Release   │ (on tag)
            └─────┬──────┘
                  │
            ┌─────▼──────┐
            │   Deploy   │ (manual)
            └────────────┘
```

---

## Support

For issues or questions about the CI/CD pipeline:

1. Check workflow logs in Actions tab
2. Review this documentation
3. Open an issue with the `ci/cd` label

---

**Last Updated**: 2026-02-15
**Maintained By**: ThreadWise Team
