-- VoiceForge: enable pgvector and add HNSW cosine index for knowledge_chunks.
-- Run after `prisma db push` so the embedding_vector column exists.
--
--   psql "$DIRECT_URL" -f apps/api/prisma/sql/001_pgvector.sql
--
-- Idempotent — safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS vector;

-- Backfill embedding_vector from the legacy Json `embedding` column on existing rows.
-- Skip rows already populated. Tolerant of malformed JSON: cast errors are isolated per row.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, embedding
    FROM knowledge_chunks
    WHERE embedding IS NOT NULL AND embedding_vector IS NULL
  LOOP
    BEGIN
      UPDATE knowledge_chunks
      SET embedding_vector = (r.embedding::text)::vector
      WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN
      -- skip rows whose JSON cannot be cast to vector(1536) (likely 64-dim mock)
      CONTINUE;
    END;
  END LOOP;
END $$;

-- HNSW index for cosine similarity search.
-- m=16, ef_construction=64 are reasonable defaults; tune per dataset.
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_vector_hnsw
ON knowledge_chunks
USING hnsw (embedding_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
