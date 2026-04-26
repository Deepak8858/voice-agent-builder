import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const EXPECTED_TABLES = [
  'users',
  'organizations',
  'workspaces',
  'memberships',
  'agents',
  'agent_versions',
  'agent_templates',
  'knowledge_sources',
  'knowledge_chunks',
  'calls',
  'call_events',
  'call_evaluations',
  'audit_logs',
];

async function main() {
  console.log('[db-verify] DATABASE_URL host:', new URL(process.env.DATABASE_URL!).host);
  console.log('[db-verify] DIRECT_URL  host:', new URL(process.env.DIRECT_URL!).host);

  const prisma = new PrismaClient();

  // 1. Connectivity + version.
  const version =
    await prisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
  console.log('[db-verify] pg version:', version[0]?.version?.split(' ').slice(0, 2).join(' '));

  // 2. Table inventory.
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  const have = new Set(rows.map((r) => r.table_name));
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
  const rls = await prisma.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `;
  const rlsOn = rls.filter((r) => r.rowsecurity).map((r) => r.tablename);
  const rlsOff = rls.filter((r) => !r.rowsecurity).map((r) => r.tablename);
  console.log(`[db-verify] RLS enabled (${rlsOn.length}):`, rlsOn);
  console.log(`[db-verify] RLS disabled (${rlsOff.length}):`, rlsOff);

  // 7. Connection pool sanity.
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
