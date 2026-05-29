import './load-env';
import { PrismaClient } from '@prisma/client';
import {
  REQUIRED_PUBLIC_TABLES,
  validatePublicTableExposure,
  type PublicTableExposureSnapshot,
} from '../src/db/public-table-exposure-policy';

const EXPECTED_TABLES = [...REQUIRED_PUBLIC_TABLES];

async function main() {
  console.log('[db-verify] DATABASE_URL host:', new URL(process.env.DATABASE_URL!).host);
  console.log('[db-verify] DIRECT_URL  host:', new URL(process.env.DIRECT_URL!).host);

  const prisma = new PrismaClient();

  // 1. Connectivity + version.
  const version =
    await prisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
  console.log('[db-verify] pg version:', version[0]?.version?.split(' ').slice(0, 2).join(' '));

  // 2. Table inventory.
  const rows = await prisma.$queryRaw<Array<{ tableName: string; rowSecurity: boolean }>>`
    SELECT c.relname AS "tableName",
           c.relrowsecurity AS "rowSecurity"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_inherits i
        WHERE i.inhrelid = c.oid
      )
    ORDER BY c.relname
  `;
  const have = new Set(rows.map((r) => r.tableName));
  console.log(`[db-verify] tables in public schema: ${rows.length}`);
  for (const t of EXPECTED_TABLES) {
    console.log(`  ${have.has(t) ? '✓' : '✗'} ${t}`);
  }
  const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
  const extras = [...have].filter((t) => !EXPECTED_TABLES.includes(t));
  if (extras.length) console.log('[db-verify] extra tables:', extras);

  // 3. Critical column checks.
  const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_versions'
  `;
  const haveCols = new Set(cols.map((c) => c.column_name));
  const expectCols = ['provider_runtime_id', 'deployment_status', 'spec_json'];
  console.log('[db-verify] agent_versions columns:');
  for (const c of expectCols) console.log(`  ${haveCols.has(c) ? '✓' : '✗'} ${c}`);

  // 4. Foreign keys + indexes sample (call_evaluations).
  const fks = await prisma.$queryRaw<
    Array<{ table_name: string; column_name: string; foreign_table: string }>
  >`
    SELECT tc.table_name, kcu.column_name,
           ccu.table_name AS foreign_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'call_evaluations'
  `;
  console.log(`[db-verify] call_evaluations foreign keys: ${fks.length}`);
  for (const fk of fks) console.log(`  ${fk.column_name} -> ${fk.foreign_table}`);

  // 5. Row counts (sanity).
  const counts = await Promise.all(
    EXPECTED_TABLES.filter((t) => have.has(t)).map(async (t) => {
      const r = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "${t}"`,
      );
      return { table: t, n: Number(r[0]?.n ?? 0) };
    }),
  );
  console.log('[db-verify] row counts:');
  for (const c of counts) console.log(`  ${c.n.toString().padStart(6, ' ')}  ${c.table}`);

  // 6. RLS status check.
  const rlsOn = rows.filter((r) => r.rowSecurity).map((r) => r.tableName);
  const rlsOff = rows.filter((r) => !r.rowSecurity).map((r) => r.tableName);
  console.log(`[db-verify] RLS enabled (${rlsOn.length}):`, rlsOn);
  console.log(`[db-verify] RLS disabled (${rlsOff.length}):`, rlsOff);
  if (rlsOff.length) {
    console.error('[db-verify] FAIL — public tables with RLS disabled:', rlsOff);
    process.exit(1);
  }

  // 7. Supabase Data API exposure policy.
  const grants = await prisma.$queryRaw<PublicTableExposureSnapshot['grants']>`
    SELECT table_name AS "tableName",
           grantee::text AS "grantee",
           privilege_type::text AS "privilege"
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated', 'service_role')
      AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ORDER BY table_name, grantee, privilege_type
  `;
  const policies = await prisma.$queryRaw<PublicTableExposureSnapshot['policies']>`
    SELECT tablename AS "tableName",
           roles::text[] AS "roleNames",
           cmd::text AS "command"
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `;
  const exposureFindings = validatePublicTableExposure({
    tables: rows,
    grants,
    policies,
  });
  console.log(
    `[db-verify] Data API exposure findings: ${exposureFindings.length}`,
  );
  for (const finding of exposureFindings) {
    console.error(`  ${finding.code}: ${finding.message}`);
  }
  if (exposureFindings.length) {
    console.error(
      '[db-verify] FAIL — public table Data API grants/RLS do not match the exposure policy',
    );
    process.exit(1);
  }

  // 8. Connection pool sanity.
  const dbUrl = new URL(process.env.DATABASE_URL!);
  console.log('[db-verify] runtime pool:');
  console.log(`  host = ${dbUrl.host}`);
  console.log(`  pgbouncer flag = ${dbUrl.searchParams.get('pgbouncer') ?? 'not set'}`);
  console.log(`  port = ${dbUrl.port} (expected 6543 for transaction-mode pooler)`);

  await prisma.$disconnect();

  if (missing.length) {
    console.error('[db-verify] FAIL — missing tables:', missing);
    process.exit(1);
  }
  console.log('[db-verify] OK');
}

main().catch((err) => {
  console.error('[db-verify] error:', err);
  process.exit(1);
});
