-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create HNSW cosine index on knowledge_chunks.embedding_vector (idempotent)
-- Requires: ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector;
-- Then run:
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
ON knowledge_chunks
USING hnsw (embedding_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64);