-- Row Level Security policies for VoiceForge AI
-- Enable RLS on all tenant-scoped tables and create basic policies.
-- NOTE: These are baseline policies. Backend permission checks are still required
-- for sensitive actions (publish, outbound call, billing, etc.).

-- Organizations: users can read orgs they belong to
-- Falls back to personal orgs when orgId is null (no active organization)
alter table organizations enable row level security;

create policy "Users can read their own orgs"
  on organizations
  for select
  to authenticated
  using (
    clerk_org_id = current_clerk_org_id()
    or (current_clerk_org_id() is null and owner_user_id = (
      select id from users where external_auth_id = current_clerk_user_id()
    ))
  );

-- Workspaces: users can read workspaces in their active org OR personal workspaces
drop policy if exists "Users can read workspaces in active org" on workspaces;
alter table workspaces enable row level security;

create policy "Users can read workspaces in active org"
  on workspaces
  for select
  to authenticated
  using (
    organization_id in (
      select id from organizations where clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and organization_id in (
      select o.id from organizations o
      join users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Agents: users can read agents in their active org's workspaces OR personal workspaces
alter table agents enable row level security;

create policy "Users can read agents in active org"
  on agents
  for select
  to authenticated
  using (
    workspace_id in (
      select w.id
      from workspaces w
      join organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from workspaces w
      join organizations o on o.id = w.organization_id
      join users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Calls: users can read calls in their active org OR personal workspaces
alter table calls enable row level security;

create policy "Users can read calls in active org"
  on calls
  for select
  to authenticated
  using (
    workspace_id in (
      select w.id
      from workspaces w
      join organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from workspaces w
      join organizations o on o.id = w.organization_id
      join users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Knowledge Sources: users can read knowledge in their active org OR personal workspaces
alter table knowledge_sources enable row level security;

create policy "Users can read knowledge in active org"
  on knowledge_sources
  for select
  to authenticated
  using (
    workspace_id in (
      select w.id
      from workspaces w
      join organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from workspaces w
      join organizations o on o.id = w.organization_id
      join users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Audit Logs: users can read audit logs in their active org OR personal workspaces
alter table audit_logs enable row level security;

create policy "Users can read audit logs in active org"
  on audit_logs
  for select
  to authenticated
  using (
    workspace_id in (
      select w.id
      from workspaces w
      join organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from workspaces w
      join organizations o on o.id = w.organization_id
      join users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );
