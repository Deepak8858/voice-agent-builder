import { describe, expect, it } from 'vitest';
import {
  BILLING_SERVICE_ROLE_ONLY_TABLES,
  CRUD_PRIVILEGES,
  PUBLIC_TABLE_EXPOSURE_POLICIES,
  REQUIRED_PUBLIC_TABLES,
  validatePublicTableExposure,
  type PublicTableExposurePolicy,
  type PublicTableExposureSnapshot,
} from './public-table-exposure-policy';

const basePolicies: PublicTableExposurePolicy[] = [
  {
    tableName: 'users',
    authenticated: ['SELECT'],
    serviceRole: CRUD_PRIVILEGES,
    anon: [],
  },
  {
    tableName: 'contacts',
    authenticated: [],
    serviceRole: CRUD_PRIVILEGES,
    anon: [],
  },
];

function snapshot(
  overrides: Partial<PublicTableExposureSnapshot> = {},
): PublicTableExposureSnapshot {
  return {
    tables: [
      { tableName: 'users', rowSecurity: true },
      { tableName: 'contacts', rowSecurity: true },
    ],
    grants: [
      { tableName: 'users', grantee: 'authenticated', privilege: 'SELECT' },
      ...CRUD_PRIVILEGES.map((privilege) => ({
        tableName: 'users',
        grantee: 'service_role' as const,
        privilege,
      })),
      ...CRUD_PRIVILEGES.map((privilege) => ({
        tableName: 'contacts',
        grantee: 'service_role' as const,
        privilege,
      })),
    ],
    policies: [
      {
        tableName: 'users',
        roleNames: ['authenticated'],
        command: 'SELECT',
      },
      {
        tableName: 'contacts',
        roleNames: ['service_role'],
        command: 'ALL',
      },
    ],
    ...overrides,
  };
}

describe('validatePublicTableExposure', () => {
  it('fails when a public table is not classified by the exposure policy', () => {
    const findings = validatePublicTableExposure(
      snapshot({
        tables: [
          { tableName: 'users', rowSecurity: true },
          { tableName: 'contacts', rowSecurity: true },
          { tableName: 'surprise_table', rowSecurity: true },
        ],
      }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'UNKNOWN_PUBLIC_TABLE',
      tableName: 'surprise_table',
      message:
        'public.surprise_table is not listed in the Data API exposure policy.',
    });
  });

  it('still reports RLS disabled when an unknown public table is discovered', () => {
    const findings = validatePublicTableExposure(
      snapshot({
        tables: [
          { tableName: 'users', rowSecurity: true },
          { tableName: 'contacts', rowSecurity: true },
          { tableName: 'surprise_table', rowSecurity: false },
        ],
      }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'UNKNOWN_PUBLIC_TABLE',
      tableName: 'surprise_table',
      message:
        'public.surprise_table is not listed in the Data API exposure policy.',
    });
    expect(findings).toContainEqual({
      code: 'RLS_DISABLED',
      tableName: 'surprise_table',
      message: 'public.surprise_table must have row level security enabled.',
    });
  });

  it('fails when a table has RLS disabled', () => {
    const findings = validatePublicTableExposure(
      snapshot({
        tables: [
          { tableName: 'users', rowSecurity: true },
          { tableName: 'contacts', rowSecurity: false },
        ],
      }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'RLS_DISABLED',
      tableName: 'contacts',
      message: 'public.contacts must have row level security enabled.',
    });
  });

  it('fails when an authenticated exposure is missing its explicit grant', () => {
    const findings = validatePublicTableExposure(
      snapshot({
        grants: CRUD_PRIVILEGES.map((privilege) => ({
          tableName: 'users',
          grantee: 'service_role' as const,
          privilege,
        })),
      }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'MISSING_GRANT',
      tableName: 'users',
      message: 'public.users is missing GRANT SELECT TO authenticated.',
    });
  });

  it('fails when a role has an unexpected grant', () => {
    const findings = validatePublicTableExposure(
      snapshot({
        grants: [
          ...snapshot().grants,
          { tableName: 'contacts', grantee: 'anon', privilege: 'SELECT' },
        ],
      }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'UNEXPECTED_GRANT',
      tableName: 'contacts',
      message: 'public.contacts has unexpected GRANT SELECT TO anon.',
    });
  });

  it('fails when an authenticated grant has no matching authenticated RLS policy', () => {
    const findings = validatePublicTableExposure(
      snapshot({ policies: [] }),
      basePolicies,
    );

    expect(findings).toContainEqual({
      code: 'MISSING_RLS_POLICY',
      tableName: 'users',
      message:
        'public.users grants SELECT to authenticated but has no authenticated SELECT RLS policy.',
    });
  });

  it('passes when every public table matches the intended exposure policy', () => {
    expect(validatePublicTableExposure(snapshot(), basePolicies)).toEqual([]);
  });
});

describe('production billing table exposure', () => {
  it('requires every billing table so db-verify cannot silently skip one', () => {
    for (const tableName of BILLING_SERVICE_ROLE_ONLY_TABLES) {
      expect(REQUIRED_PUBLIC_TABLES).toContain(tableName);
    }
  });

  it('never exposes revenue-bearing billing tables to anon or authenticated', () => {
    for (const tableName of BILLING_SERVICE_ROLE_ONLY_TABLES) {
      const policy = PUBLIC_TABLE_EXPOSURE_POLICIES.find(
        (candidate) => candidate.tableName === tableName,
      );

      expect(policy).toBeDefined();
      expect(policy?.anon).toEqual([]);
      expect(policy?.authenticated).toEqual([]);
      expect(policy?.serviceRole).toEqual(CRUD_PRIVILEGES);
    }
  });

  it('reports no findings for billing tables that follow the deny-by-default posture', () => {
    const billingTables = [...BILLING_SERVICE_ROLE_ONLY_TABLES];
    const findings = validatePublicTableExposure(
      {
        tables: billingTables.map((tableName) => ({ tableName, rowSecurity: true })),
        grants: billingTables.flatMap((tableName) =>
          CRUD_PRIVILEGES.map((privilege) => ({
            tableName,
            grantee: 'service_role' as const,
            privilege,
          })),
        ),
        policies: [],
      },
      PUBLIC_TABLE_EXPOSURE_POLICIES,
    );

    expect(findings).toEqual([]);
  });

  it('rejects a billing table that leaks a read grant to authenticated', () => {
    const findings = validatePublicTableExposure(
      {
        tables: [{ tableName: 'billing_ledger_entries', rowSecurity: true }],
        grants: [
          ...CRUD_PRIVILEGES.map((privilege) => ({
            tableName: 'billing_ledger_entries',
            grantee: 'service_role' as const,
            privilege,
          })),
          {
            tableName: 'billing_ledger_entries',
            grantee: 'authenticated' as const,
            privilege: 'SELECT' as const,
          },
        ],
        policies: [],
      },
      PUBLIC_TABLE_EXPOSURE_POLICIES,
    );

    expect(findings).toContainEqual({
      code: 'UNEXPECTED_GRANT',
      tableName: 'billing_ledger_entries',
      message:
        'public.billing_ledger_entries has unexpected GRANT SELECT TO authenticated.',
    });
  });

  it('rejects a billing table created without row level security', () => {
    const findings = validatePublicTableExposure(
      {
        tables: [{ tableName: 'organization_credit_balances', rowSecurity: false }],
        grants: CRUD_PRIVILEGES.map((privilege) => ({
          tableName: 'organization_credit_balances',
          grantee: 'service_role' as const,
          privilege,
        })),
        policies: [],
      },
      PUBLIC_TABLE_EXPOSURE_POLICIES,
    );

    expect(findings).toContainEqual({
      code: 'RLS_DISABLED',
      tableName: 'organization_credit_balances',
      message:
        'public.organization_credit_balances must have row level security enabled.',
    });
  });
});
