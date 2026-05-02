-- RLS helper functions for Clerk + Supabase integration
-- These functions extract Clerk identity from the JWT passed by the client.
-- NOTE: Using single-quote escaping (no $$) for compatibility with prepared-statement drivers.

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
