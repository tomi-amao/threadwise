#!/bin/bash

# Quick setup script for new developers
set -e

echo "🚀 Setting up Threadwise development environment..."

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required but not installed. Aborting." >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ pnpm is required but not installed. Aborting." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3 is required but not installed. Aborting." >&2; exit 1; }
command -v poetry >/dev/null 2>&1 || { echo "❌ Poetry is required but not installed. Aborting." >&2; exit 1; }

echo "✅ Prerequisites check passed"

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
pnpm install

# Install Python dependencies
echo "🐍 Installing Python dependencies..."
cd apps/ai-agent && poetry install && cd ../..

# Copy environment file
if [ ! -f .env.local ]; then
    echo "📝 Creating .env.local from template..."
    cp .env.example .env.local
    echo "⚠️  Please update .env.local with your actual API keys and configuration"
fi

echo "✅ Setup complete! You can now run:"
echo "   • make dev      (start all apps)"
echo "   • make dev-web  (start React Router only)"
echo "   • make dev-api  (start AI Agent only)"
echo "   • make help     (see all commands)"