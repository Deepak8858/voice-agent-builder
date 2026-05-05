-- RLS helper functions for Clerk + Supabase integration
-- These functions extract Clerk identity from the JWT passed by the client.
-- NOTE: Using single-quote escaping (no $$) for compatibility with prepared-statement drivers.
-- NOTE: The Clerk JWT must include the 'o' claim (org_id) for RLS to work.
-- Users without an active organization will get NULL from current_clerk_org_id().
-- For personal accounts without orgs, the RLS policies include fallback logic (see 003_rls_policies.sql).

-- Current Clerk User ID (from auth.jwt()->>'sub')
create or replace function current_clerk_user_id()
returns text
language sql
stable
as 'select auth.jwt()->>''sub''';

-- Current Clerk Organization ID (from compact 'o' claim or custom claim)
create or replace function current_clerk_org_id()
returns text
language sql
stable
as 'select auth.jwt()->''o''->>''id''';
