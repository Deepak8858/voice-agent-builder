export const CRUD_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

export type TablePrivilege = (typeof CRUD_PRIVILEGES)[number];
export type DataApiRole = 'anon' | 'authenticated' | 'service_role';
export type RlsPolicyCommand = TablePrivilege | 'ALL';

export interface PublicTableExposurePolicy {
  tableName: string;
  anon: readonly TablePrivilege[];
  authenticated: readonly TablePrivilege[];
  serviceRole: readonly TablePrivilege[];
}

export interface PublicTableSnapshotRow {
  tableName: string;
  rowSecurity: boolean;
}

export interface PublicTableGrantRow {
  tableName: string;
  grantee: DataApiRole;
  privilege: TablePrivilege;
}

export interface PublicTablePolicyRow {
  tableName: string;
  roleNames: readonly string[];
  command: RlsPolicyCommand;
}

export interface PublicTableExposureSnapshot {
  tables: readonly PublicTableSnapshotRow[];
  grants: readonly PublicTableGrantRow[];
  policies: readonly PublicTablePolicyRow[];
}

export interface PublicTableExposureFinding {
  code:
    | 'UNKNOWN_PUBLIC_TABLE'
    | 'RLS_DISABLED'
    | 'MISSING_GRANT'
    | 'UNEXPECTED_GRANT'
    | 'MISSING_RLS_POLICY';
  tableName: string;
  message: string;
}

export const AUTHENTICATED_READ_TABLES = [
  'users',
  'organizations',
  'workspaces',
  'memberships',
  'workspace_memberships',
  'org_invites',
  'agents',
  'agent_versions',
  'agent_templates',
  'knowledge_sources',
  'knowledge_chunks',
  'calls',
  'call_events',
  'call_evaluations',
  'audit_logs',
  'integration_tools',
  'tool_invocations',
  'analytics_events',
  'client_invites',
  'white_label_settings',
  'workspace_crm_credentials',
  'crm_routing_rules',
  'crm_fanout_log',
  'twilio_phone_numbers',
  'outbound_campaigns',
  'telephony_provider_connections',
  'telephony_phone_numbers',
  'livekit_telephony_configs',
  'telephony_webhook_events',
] as const;

/**
 * Revenue-bearing and billing-runtime tables introduced by the production
 * billing migration. They are never read through the Supabase Data API: the
 * NestJS API owns every read and write, so anon and authenticated get no
 * grants and no policies.
 */
export const BILLING_SERVICE_ROLE_ONLY_TABLES = [
  'billing_credit_buckets',
  'billing_ledger_entries',
  'organization_credit_balances',
  'call_usages',
  'runtime_usage_events',
  'trial_redemptions',
  'agent_provider_deployments',
  'provider_cost_events',
  'call_concurrency_leases',
] as const;

export const SERVICE_ROLE_ONLY_TABLES = [
  'contacts',
  'consent_records',
  'dnc_entries',
  'compliance_checks',
  'audit_reports',
  // Chat-to-agent generation sessions. User-owned data, but the NestJS API is
  // the only reader/writer, so the Data API roles get nothing.
  'agent_gen_sessions',
  'subscriptions',
  'usage_records',
  'stripe_events',
  'webhook_events',
  'google_calendar_configs',
  'referrals',
  ...BILLING_SERVICE_ROLE_ONLY_TABLES,
] as const;

export const LEGACY_SERVICE_ROLE_ONLY_TABLES = [
  '_prisma_migrations',
  'app_org_memberships',
  'alerts',
  'plan_pricing',
  'call_messages',
  'compliance_logs',
  'tool_definitions',
  'billing_events',
] as const;

export const EXPECTED_PUBLIC_TABLES = [
  ...AUTHENTICATED_READ_TABLES,
  ...SERVICE_ROLE_ONLY_TABLES,
  ...LEGACY_SERVICE_ROLE_ONLY_TABLES,
] as const;

export const REQUIRED_PUBLIC_TABLES = [
  ...AUTHENTICATED_READ_TABLES,
  ...SERVICE_ROLE_ONLY_TABLES,
] as const;

const authenticatedReadPolicies = AUTHENTICATED_READ_TABLES.map((tableName) => ({
  tableName,
  anon: [],
  authenticated: ['SELECT'],
  serviceRole: CRUD_PRIVILEGES,
})) satisfies PublicTableExposurePolicy[];

const serviceRoleOnlyPolicies = [
  ...SERVICE_ROLE_ONLY_TABLES,
  ...LEGACY_SERVICE_ROLE_ONLY_TABLES,
].map((tableName) => ({
  tableName,
  anon: [],
  authenticated: [],
  serviceRole: CRUD_PRIVILEGES,
})) satisfies PublicTableExposurePolicy[];

export const PUBLIC_TABLE_EXPOSURE_POLICIES = [
  ...authenticatedReadPolicies,
  ...serviceRoleOnlyPolicies,
] as const satisfies readonly PublicTableExposurePolicy[];

const DATA_API_ROLES = ['anon', 'authenticated', 'service_role'] as const;

export function validatePublicTableExposure(
  snapshot: PublicTableExposureSnapshot,
  expectedPolicies: readonly PublicTableExposurePolicy[] = PUBLIC_TABLE_EXPOSURE_POLICIES,
): PublicTableExposureFinding[] {
  const findings: PublicTableExposureFinding[] = [];
  const policyByTable = new Map(expectedPolicies.map((policy) => [policy.tableName, policy]));
  const tableByName = new Map(snapshot.tables.map((table) => [table.tableName, table]));
  const grantsByTableAndRole = groupGrants(snapshot.grants);

  for (const tableName of [...tableByName.keys()].sort()) {
    const table = tableByName.get(tableName);
    const expected = policyByTable.get(tableName);

    if (table && !table.rowSecurity) {
      findings.push({
        code: 'RLS_DISABLED',
        tableName,
        message: `public.${tableName} must have row level security enabled.`,
      });
    }

    if (!expected) {
      findings.push({
        code: 'UNKNOWN_PUBLIC_TABLE',
        tableName,
        message: `public.${tableName} is not listed in the Data API exposure policy.`,
      });
      continue;
    }

    for (const role of DATA_API_ROLES) {
      const expectedPrivileges = new Set(expectedPrivilegesForRole(expected, role));
      const actualPrivileges = grantsByTableAndRole.get(grantKey(tableName, role)) ?? new Set();

      for (const privilege of expectedPrivileges) {
        if (!actualPrivileges.has(privilege)) {
          findings.push({
            code: 'MISSING_GRANT',
            tableName,
            message: `public.${tableName} is missing GRANT ${privilege} TO ${role}.`,
          });
        }
      }

      for (const privilege of actualPrivileges) {
        if (!expectedPrivileges.has(privilege)) {
          findings.push({
            code: 'UNEXPECTED_GRANT',
            tableName,
            message: `public.${tableName} has unexpected GRANT ${privilege} TO ${role}.`,
          });
        }
      }
    }

    for (const privilege of expected.authenticated) {
      if (!hasExplicitPolicyFor(snapshot.policies, tableName, 'authenticated', privilege)) {
        findings.push({
          code: 'MISSING_RLS_POLICY',
          tableName,
          message:
            `public.${tableName} grants ${privilege} to authenticated but has no ` +
            `authenticated ${privilege} RLS policy.`,
        });
      }
    }
  }

  return findings;
}

function expectedPrivilegesForRole(
  policy: PublicTableExposurePolicy,
  role: DataApiRole,
): readonly TablePrivilege[] {
  if (role === 'anon') return policy.anon;
  if (role === 'authenticated') return policy.authenticated;
  return policy.serviceRole;
}

function groupGrants(
  grants: readonly PublicTableGrantRow[],
): Map<string, Set<TablePrivilege>> {
  const grouped = new Map<string, Set<TablePrivilege>>();
  for (const grant of grants) {
    const key = grantKey(grant.tableName, grant.grantee);
    const privileges = grouped.get(key) ?? new Set<TablePrivilege>();
    privileges.add(grant.privilege);
    grouped.set(key, privileges);
  }
  return grouped;
}

function grantKey(tableName: string, grantee: DataApiRole): string {
  return `${tableName}:${grantee}`;
}

function hasExplicitPolicyFor(
  policies: readonly PublicTablePolicyRow[],
  tableName: string,
  roleName: DataApiRole,
  privilege: TablePrivilege,
): boolean {
  return policies.some((policy) => {
    if (policy.tableName !== tableName) return false;
    if (!policy.roleNames.includes(roleName)) return false;
    return policy.command === 'ALL' || policy.command === privilege;
  });
}
