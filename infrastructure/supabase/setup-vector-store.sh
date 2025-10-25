#!/bin/bash

# Setup Vector Store for ThreadWise
# This script initializes the vector store tables and functions in Supabase

echo "🚀 Setting up vector store for ThreadWise..."

# Check if Supabase is running
if ! curl -s http://localhost:8000/health > /dev/null; then
    echo "❌ Supabase is not running on localhost:8000"
    echo "Please start Supabase first with: docker compose -f infrastructure/supabase/docker-compose.yml up -d"
    exit 1
fi

echo "✅ Supabase is running"

# Run the SQL setup script
echo "📝 Executing vector store setup..."

# Using psql to connect to the local Supabase database
# Default Supabase credentials for local development
PGPASSWORD=postgres psql \
    -h localhost \
    -p 5432 \
    -U postgres \
    -d postgres \
    -f "$(dirname "$0")/setup-vector-store.sql"

if [ $? -eq 0 ]; then
    echo "✅ Vector store setup completed successfully!"
    echo ""
    echo "📊 Your vector store is now ready for document embeddings."
    echo "The following was created:"
    echo "  - documents table with vector extension"
    echo "  - match_documents() function for similarity search"
    echo "  - Appropriate indexes and RLS policies"
    echo ""
    echo "🧠 You can now upload documents and they will be automatically embedded!"
else
    echo "❌ Vector store setup failed"
    echo "Please check the error messages above and ensure:"
    echo "  1. Supabase is running on localhost:8000"
    echo "  2. PostgreSQL is accessible on localhost:5432"
    echo "  3. The vector extension is available"
    exit 1
fi
