-- Migration 005: Drop Clerk integration
-- Removes Clerk-specific RLS helpers, policies, columns, and the
-- app_org_memberships cache table. Migrations 003 + 004 created policies
-- against `external_auth_id`/`clerk_org_id` — those policies are dropped
-- here. Migration 008 recreates them against Supabase Auth.
--
-- Run on a wiped DB. Existing rows referencing Clerk IDs will lose those
-- links (we are starting from scratch with Supabase Auth).

-- ============================================================================
-- Drop all RLS policies created in 003 + 004 (every table that referenced
-- Clerk JWT shape).  We re-enable RLS in 008 with new policies.
-- ============================================================================

drop policy if exists "Users can read their own orgs" on public.organizations;
drop policy if exists "Users can update their own orgs" on public.organizations;
drop policy if exists "Owners can delete their org" on public.organizations;
drop policy if exists "Users can insert orgs they own" on public.organizations;

drop policy if exists "Users can read workspaces in active org" on public.workspaces;
drop policy if exists "Users can read their workspaces" on public.workspaces;
drop policy if exists "Users can manage workspaces in active org" on public.workspaces;

drop policy if exists "Users can read agents in active org" on public.agents;
drop policy if exists "Users can read their agents" on public.agents;
drop policy if exists "Users can manage agents in active org" on public.agents;

drop policy if exists "Users can read calls in active org" on public.calls;
drop policy if exists "Users can read their calls" on public.calls;

drop policy if exists "Users can read knowledge sources" on public.knowledge_sources;
drop policy if exists "Users can read their knowledge sources" on public.knowledge_sources;

drop policy if exists "Users can read audit logs" on public.audit_logs;
drop policy if exists "Users can read their audit logs" on public.audit_logs;

drop policy if exists "Users can read own record" on public.users;
drop policy if exists "Users can update own record" on public.users;
drop policy if exists "Users can read own org memberships" on public.app_org_memberships;
drop policy if exists "Users can insert own org memberships" on public.app_org_memberships;
drop policy if exists "Users can update own org memberships" on public.app_org_memberships;
drop policy if exists "Users can read own workspace memberships" on public.workspace_memberships;
drop policy if exists "Users can insert own workspace memberships" on public.workspace_memberships;
drop policy if exists "Users can read own memberships" on public.memberships;

drop policy if exists "Users can read org agent templates" on public.agent_templates;
drop policy if exists "Users can read agent versions" on public.agent_versions;
drop policy if exists "Users can read call evaluations" on public.call_evaluations;
drop policy if exists "Users can read call events" on public.call_events;
drop policy if exists "Users can read integration tools" on public.integration_tools;
drop policy if exists "Users can read knowledge chunks" on public.knowledge_chunks;
drop policy if exists "Users can read tool invocations" on public.tool_invocations;
drop policy if exists "Workspace owner can manage white label" on public.white_label_settings;
drop policy if exists "Org admin can manage client invites" on public.client_invites;
drop policy if exists "Users can read analytics events" on public.analytics_events;

-- ============================================================================
-- Drop Clerk-specific helper functions
-- ============================================================================

drop function if exists public.current_clerk_user_id() cascade;
drop function if exists public.current_clerk_org_id() cascade;
drop function if exists public.provision_user_with_lock(text, text, text) cascade;

-- ============================================================================
-- Drop Clerk identity columns and the app_org_memberships cache
-- ============================================================================

-- AppOrgMembership table is replaced by `memberships` joined to `workspaces.organization_id`
drop table if exists public.app_org_memberships cascade;

-- Drop Clerk columns from organizations
alter table public.organizations
  drop column if exists clerk_org_id;

-- Drop Clerk identity column from users (auth_user_id added in 006)
alter table public.users
  drop column if exists external_auth_id;

-- Drop clerk_user_id from workspace_memberships; the unique key becomes (workspace_id, user_id)
alter table public.workspace_memberships
  drop constraint if exists workspace_memberships_workspace_id_clerk_user_id_key;
drop index if exists public.workspace_memberships_clerk_user_id_idx;
alter table public.workspace_memberships
  drop column if exists clerk_user_id;
-- New unique constraint added by Prisma migrate / migration 006.
