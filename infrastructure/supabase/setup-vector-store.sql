-- Vector Store Setup for Document Embeddings
-- This script sets up the necessary tables and functions for LangChain vector storage

-- Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the documents table for storing embeddings
CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB,
  embedding VECTOR(384) -- 384 dimensions for BAAI/bge-small-en model
);

-- Create an index on the embedding column for faster similarity search
CREATE INDEX IF NOT EXISTS documents_embedding_idx ON documents USING ivfflat (embedding vector_cosine_ops);

-- Create the similarity search function
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(384),
  similarity_threshold FLOAT DEFAULT 0.78,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > similarity_threshold
  ORDER BY documents.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Enable Row Level Security
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Create policies for the documents table
-- Allow all operations for authenticated users
CREATE POLICY "Allow all operations for authenticated users" ON documents
  FOR ALL USING (true);

-- Allow read access for anonymous users (for demo purposes)
-- In production, you might want to restrict this
CREATE POLICY "Allow read access for anonymous users" ON documents
  FOR SELECT USING (true);

-- Allow insert/update/delete for anonymous users (for demo purposes)
-- In production, you should restrict this to authenticated users only
CREATE POLICY "Allow write access for anonymous users" ON documents
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update access for anonymous users" ON documents
  FOR UPDATE USING (true);

CREATE POLICY "Allow delete access for anonymous users" ON documents
  FOR DELETE USING (true);

-- Grant necessary permissions
GRANT ALL ON documents TO postgres;
GRANT ALL ON documents TO anon;
GRANT ALL ON documents TO authenticated;
GRANT ALL ON documents TO service_role;

-- Grant permissions on the sequence
GRANT ALL ON SEQUENCE documents_id_seq TO postgres;
GRANT ALL ON SEQUENCE documents_id_seq TO anon;
GRANT ALL ON SEQUENCE documents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE documents_id_seq TO service_role;

-- Create a function to get document statistics
CREATE OR REPLACE FUNCTION get_document_stats()
RETURNS TABLE (
  total_documents BIGINT,
  total_chunks BIGINT,
  unique_files BIGINT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    COUNT(*) AS total_documents,
    COUNT(*) AS total_chunks,
    COUNT(DISTINCT metadata->>'fileName') AS unique_files
  FROM documents;
$$;

-- Grant execute permission on the function
GRANT EXECUTE ON FUNCTION match_documents TO postgres;
GRANT EXECUTE ON FUNCTION match_documents TO anon;
GRANT EXECUTE ON FUNCTION match_documents TO authenticated;
GRANT EXECUTE ON FUNCTION match_documents TO service_role;

GRANT EXECUTE ON FUNCTION get_document_stats TO postgres;
GRANT EXECUTE ON FUNCTION get_document_stats TO anon;
GRANT EXECUTE ON FUNCTION get_document_stats TO authenticated;
GRANT EXECUTE ON FUNCTION get_document_stats TO service_role;
