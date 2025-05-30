.PHONY: help setup dev build start test clean docker-up docker-down docker-logs

# Colors for output
GREEN := \033[32m
YELLOW := \033[33m
BLUE := \033[34m
RESET := \033[0m

help: ## Show this help message
	@echo "$(GREEN)Threadwise Monorepo Commands$(RESET)"
	@echo "================================"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "$(BLUE)%-15s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

setup: ## Install all dependencies
	@echo "$(YELLOW)Setting up all dependencies...$(RESET)"
	pnpm install
	cd apps/ai-agent && poetry install

dev: ## Start all applications in development mode
	@echo "$(GREEN)Starting all applications in development mode...$(RESET)"
	pnpm dev

dev-web: ## Start only the React Router app
	@echo "$(GREEN)Starting React Router app...$(RESET)"
	pnpm dev:react-router

dev-api: ## Start only the AI Agent API
	@echo "$(GREEN)Starting AI Agent API...$(RESET)"
	pnpm dev:ai-agent

build: ## Build all applications
	@echo "$(YELLOW)Building all applications...$(RESET)"
	pnpm build

start: ## Start all applications in production mode
	@echo "$(GREEN)Starting all applications in production mode...$(RESET)"
	pnpm start

test: ## Run all tests
	@echo "$(YELLOW)Running all tests...$(RESET)"
	pnpm test

typecheck: ## Run type checking on all apps
	@echo "$(YELLOW)Running type checks...$(RESET)"
	pnpm typecheck

lint: ## Run linting on all files
	@echo "$(YELLOW)Running linter...$(RESET)"
	pnpm lint

format: ## Format all files
	@echo "$(YELLOW)Formatting all files...$(RESET)"
	pnpm format

clean: ## Clean all build artifacts and caches
	@echo "$(YELLOW)Cleaning build artifacts...$(RESET)"
	pnpm clean

reset: ## Reset environment (clean + reinstall)
	@echo "$(YELLOW)Resetting environment...$(RESET)"
	pnpm reset

docker-up: ## Start all services with Docker Compose
	@echo "$(GREEN)Starting services with Docker Compose...$(RESET)"
	docker-compose up -d

docker-dev: ## Start all services in development mode with Docker
	@echo "$(GREEN)Starting development services with Docker Compose...$(RESET)"
	docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

docker-down: ## Stop all Docker services
	@echo "$(YELLOW)Stopping Docker services...$(RESET)"
	docker-compose down

docker-logs: ## View Docker logs
	@echo "$(BLUE)Viewing Docker logs...$(RESET)"
	docker-compose logs -f

docker-build: ## Build Docker images
	@echo "$(YELLOW)Building Docker images...$(RESET)"
	docker-compose build
