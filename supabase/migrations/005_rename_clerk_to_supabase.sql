-- Rename clerk fields to supabase
-- Organization: clerk_org_id → supabase_org_id
ALTER TABLE organizations RENAME COLUMN clerk_org_id TO supabase_org_id;

-- AppOrgMembership: clerk_user_id → supabase_user_id, clerk_org_id → supabase_org_id
ALTER TABLE app_org_memberships RENAME COLUMN clerk_user_id TO supabase_user_id;
ALTER TABLE app_org_memberships RENAME COLUMN clerk_org_id TO supabase_org_id;

-- WorkspaceMembership: clerk_user_id → supabase_user_id
ALTER TABLE workspace_memberships RENAME COLUMN clerk_user_id TO supabase_user_id;

-- Rebuild indexes
DROP INDEX IF EXISTS app_org_memberships_clerk_user_id_idx;
CREATE INDEX app_org_memberships_supabase_user_id_idx ON app_org_memberships(supabase_user_id);

DROP INDEX IF EXISTS app_org_memberships_clerk_org_id_idx;
CREATE INDEX app_org_memberships_supabase_org_id_idx ON app_org_memberships(supabase_org_id);

DROP INDEX IF EXISTS workspace_memberships_clerk_user_id_idx;
CREATE INDEX workspace_memberships_supabase_user_id_idx ON workspace_memberships(supabase_user_id);

DROP INDEX IF EXISTS organizations_clerk_org_id_idx;
CREATE INDEX organizations_supabase_org_id_idx ON organizations(supabase_org_id);