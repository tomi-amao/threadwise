# ThreadWise AI Agent

A FastAPI-based AI agent service for the ThreadWise application, providing intelligent conversation threading and analysis capabilities.

## 🚀 Quick Start

### Prerequisites

- Python 3.13+
- Poetry (for dependency management)
- Git (with pre-commit hooks configured)

### Developer Setup

#### 1. Install Poetry (if not already installed)

```bash
# Using pipx (recommended)
pipx install poetry

# Verify installation
poetry --version
```

#### 2. Clone and Navigate to Project

```bash
cd /home/ignorantview/projects/web-applications/threadwise/apps/ai-agent
```

#### 3. Install Dependencies

```bash
# Install project dependencies
poetry install

# Verify installation
poetry run python --version
```

#### 4. Setup Pre-commit Hooks (Root Level)

The pre-commit hooks are configured at the monorepo root level and integrate with Husky:

```bash
# Navigate to monorepo root
cd /home/ignorantview/projects/web-applications/threadwise

# Install pre-commit globally (if not done already)
pipx install pre-commit

# Verify hooks work for Python files
pre-commit run --all-files
```

#### 5. Environment Configuration

```bash
# Copy environment template (when available)
cp .env.example .env

# Edit environment variables
nano .env
```

Required environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_KEY`: Supabase service key
- `DATABASE_URL`: Database connection string

#### 6. Run the Application

```bash
# Development server with auto-reload
poetry run uvicorn ai_agent.main:app --host 0.0.0.0 --port 8000 --reload

# Or using the direct command (if configured)
poetry run dev
```

The API will be available at: http://localhost:8000

API documentation: http://localhost:8000/docs

## 🛠️ Development Tools

### Code Quality Tools

This project uses several tools to maintain code quality:

- **Black**: Code formatting (88 character line length)
- **isort**: Import statement organization
- **Flake8**: Linting and style checking
- **mypy**: Static type checking
- **Bandit**: Security vulnerability scanning

### Running Tools Manually

```bash
# Format code
poetry run black src/ tests/

# Sort imports
poetry run isort src/ tests/

# Lint code
poetry run flake8 src/ tests/

# Type checking
poetry run mypy src/

# Security scan
poetry run bandit -r src/
```

### Pre-commit Integration

Pre-commit hooks automatically run these tools on changed files before each commit:

```bash
# Run pre-commit on all files
cd /home/ignorantview/projects/web-applications/threadwise
pre-commit run --all-files

# Run pre-commit on specific files
pre-commit run --files apps/ai-agent/src/ai_agent/main.py
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
poetry run pytest

# Run with coverage
poetry run pytest --cov=ai_agent --cov-report=html

# Run specific test file
poetry run pytest tests/test_main.py

# Run with verbose output
poetry run pytest -v
```

### Test Structure

```
tests/
├── __init__.py
├── test_main.py
├── test_models.py
└── test_services.py
```

## 🏗️ Project Structure

```
apps/ai-agent/
├── src/
│   └── ai_agent/
│       ├── __init__.py
│       ├── main.py          # FastAPI application
│       ├── models/          # Pydantic models
│       ├── services/        # Business logic
│       ├── routers/         # API routes
│       └── utils/           # Utility functions
├── tests/
│   └── __init__.py
├── pyproject.toml           # Project configuration
├── poetry.lock              # Locked dependencies
├── .flake8                  # Flake8 configuration
└── README.md                # This file
```

## 📦 Dependencies

### Production Dependencies

- **FastAPI**: Modern web framework for APIs
- **Uvicorn**: ASGI server
- **OpenAI**: AI/LLM integration
- **LangChain**: LLM framework and utilities
- **Supabase**: Database and authentication
- **Pydantic**: Data validation and serialization
- **httpx**: HTTP client library

### Development Dependencies

- **Black**: Code formatter
- **isort**: Import sorter
- **Flake8**: Linter
- **mypy**: Type checker
- **Pytest**: Testing framework
- **Bandit**: Security scanner
- **pre-commit**: Git hook framework

## 🔧 Configuration

### Poetry Configuration

Key settings in `pyproject.toml`:

```toml
[tool.black]
line-length = 88
target-version = ['py313']

[tool.isort]
profile = "black"
line_length = 88

[tool.mypy]
python_version = "3.13"
warn_return_any = true
warn_unused_configs = true
```

### Virtual Environment

Poetry manages the virtual environment automatically:

```bash
# Show virtual environment info
poetry env info

# Show virtual environment path
poetry env info --path

# Activate shell in virtual environment
poetry shell

# Run commands in virtual environment
poetry run <command>
```

## 🐳 Docker Support

### Building Container

```bash
# Build Docker image
docker build -t threadwise-ai-agent .

# Run container
docker run -p 8000:8000 --env-file .env threadwise-ai-agent
```

### Docker Configuration Notes

- Poetry virtual environment creation is disabled in containers
- Dependencies are installed directly to system Python
- See `Dockerfile` for complete build configuration

## 🔍 Troubleshooting

### Common Issues

1. **Poetry not found**: Ensure Poetry is installed and in PATH

   ```bash
   pipx install poetry
   # Add ~/.local/bin to PATH if needed
   ```

2. **Pre-commit conflicts**: If you see Husky conflicts:

   ```bash
   # The project uses Husky + pre-commit integration
   # Pre-commit is called by Husky, not installed directly
   ```

3. **Python version mismatch**: Ensure Python 3.13+ is available

   ```bash
   python --version
   poetry env use python3.13
   ```

4. **Import errors**: Ensure you're in the virtual environment
   ```bash
   poetry shell
   # or prefix commands with: poetry run
   ```

### Getting Help

- Check the [main ThreadWise README](../../README.md) for monorepo setup
- Review the [architecture documentation](../../docs/)
- Open an issue for project-specific problems

## 📝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes following the code style guidelines
4. Run tests: `poetry run pytest`
5. Run pre-commit checks: `pre-commit run --all-files`
6. Commit your changes (pre-commit hooks will run automatically)
7. Push to the branch: `git push origin feature/amazing-feature`
8. Open a Pull Request

All commits must pass the pre-commit hooks which include:

- Code formatting (Black)
- Import sorting (isort)
- Linting (Flake8)
- Type checking (mypy)
- Security scanning (Bandit)

## 📄 License

This project is part of the ThreadWise application suite.
