-- Migration: 0032_enable_rls_on_new_tables
-- Enable RLS + policies for agent-gen tables (workspace-scoped)

-- Enable RLS
ALTER TABLE public.workspace_crm_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_fanout_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twilio_phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_campaigns ENABLE ROW LEVEL SECURITY;

-- workspace_crm_credentials: workspace member can manage
CREATE POLICY "workspace_crm_credentials_workspace_read"
  ON public.workspace_crm_credentials FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "workspace_crm_credentials_workspace_write"
  ON public.workspace_crm_credentials FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

-- crm_routing_rules: workspace member can read
CREATE POLICY "crm_routing_rules_workspace_read"
  ON public.crm_routing_rules FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "crm_routing_rules_workspace_write"
  ON public.crm_routing_rules FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

-- crm_fanout_log: read-only, tied to call/agent workspace
CREATE POLICY "crm_fanout_log_workspace_read"
  ON public.crm_fanout_log FOR SELECT
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.workspaces w ON w.id = a.workspace_id
      JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
      JOIN public.users u ON u.id = wm.user_id
      WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR call_id IN (
      SELECT c.id FROM public.calls c
      JOIN public.workspaces w ON w.id = c.workspace_id
      JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
      JOIN public.users u ON u.id = wm.user_id
      WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

CREATE POLICY "crm_fanout_log_insert"
  ON public.crm_fanout_log FOR INSERT
  WITH CHECK (true); -- service role only (system writes)

-- twilio_phone_numbers: workspace member
CREATE POLICY "twilio_phone_numbers_workspace_read"
  ON public.twilio_phone_numbers FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "twilio_phone_numbers_workspace_write"
  ON public.twilio_phone_numbers FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

-- outbound_campaigns: workspace member
CREATE POLICY "outbound_campaigns_workspace_read"
  ON public.outbound_campaigns FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "outbound_campaigns_workspace_write"
  ON public.outbound_campaigns FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND wm.role IN ('owner', 'admin', 'editor')
  ));
