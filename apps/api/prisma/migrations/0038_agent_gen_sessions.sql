-- Migration: 0038_agent_gen_sessions
-- Server-persisted chat-to-agent generation sessions.
-- Refresh-safe generation state: the browser can reload mid-generation and
-- resume by re-reading this row. Scoped to (workspace, user).

CREATE TABLE agent_gen_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'awaiting_user'
    CHECK (status IN ('awaiting_user', 'generating', 'completed', 'failed')),
  messages JSONB NOT NULL DEFAULT '[]',
  current_spec JSONB,
  spec_valid BOOLEAN NOT NULL DEFAULT false,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  last_error TEXT,
  generating_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_gen_sessions_ws_user_status
  ON agent_gen_sessions(workspace_id, user_id, status);
-- For the stale-generation sweep (fail sessions stuck in 'generating').
CREATE INDEX idx_agent_gen_sessions_status_generating_at
  ON agent_gen_sessions(status, generating_at);

-- RLS: sessions are readable/writable only by the owning user within the
-- workspace. The API uses the service role and enforces the same scoping in
-- application code; these policies protect direct PostgREST/supabase access.
ALTER TABLE public.agent_gen_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_gen_sessions_owner_select"
  ON public.agent_gen_sessions FOR SELECT
  USING (user_id IN (
    SELECT u.id FROM public.users u
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ));

-- Writes additionally require the owner to be a member of the row's workspace
-- and the organization to match that workspace, so a compromised JWT cannot
-- write rows pointing at another tenant.
CREATE POLICY "agent_gen_sessions_owner_write"
  ON public.agent_gen_sessions FOR ALL
  USING (user_id IN (
    SELECT u.id FROM public.users u
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ))
  WITH CHECK (
    user_id IN (
      SELECT u.id FROM public.users u
      WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    )
    AND workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_memberships wm
      JOIN public.users u ON u.id = wm.user_id
      WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    )
    AND organization_id = (
      SELECT w.organization_id FROM public.workspaces w WHERE w.id = workspace_id
    )
  );
