-- Phase 2: Index Optimizations
-- Critical indexes for scale: 100k+ users

-- Calls table: provider lookup (critical for webhooks)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_provider_call_id
  ON calls(provider_call_id)
  WHERE provider_call_id IS NOT NULL;

-- Active calls: partial index for queue monitoring
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_active
  ON calls(created_at DESC)
  WHERE status IN ('queued', 'ringing', 'in_progress');

-- AgentVersion: provider runtime ID lookup (critical for Phase 1 fix)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_versions_provider_runtime_id
  ON agent_versions(provider_runtime_id)
  WHERE provider_runtime_id IS NOT NULL;

-- Consent records: expiring consents for cleanup jobs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consent_records_expiring
  ON consent_records(workspace_id, consent_type)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

-- Analytics events: time-series queries by agent/day
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_analytics_events_agent_day
  ON analytics_events(agent_id, date_trunc('day', occurred_at));

-- Call events: time-series queries by call
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_events_call_time
  ON call_events(call_id, event_time DESC);

-- Workspace: slug lookups (auth + routing)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspaces_org_slug
  ON workspaces(organization_id, slug)
  WHERE status = 'active';

-- Organization: owner lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_organizations_owner
  ON organizations(owner_user_id)
  WHERE status = 'active';

-- pgvector: HNSW index for knowledge chunk similarity search (after migration to HNSW)
-- Commented until pgvector extension is properly configured
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
--   ON knowledge_chunks USING hnsw(embedding vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64);