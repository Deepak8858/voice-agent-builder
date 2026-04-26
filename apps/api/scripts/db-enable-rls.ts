import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Enables row-level security on every public-schema table managed by Prisma.
 *
 * Why: Supabase exposes a public REST API (PostgREST) and Realtime backed by
 * the `anon` and `authenticated` roles. With RLS disabled, anyone holding the
 * anon key could read these tables. This project never uses Supabase auth or
 * the anon key — Prisma owns the connection — so we install a deny-by-default
 * posture: RLS on, zero policies, zero access from anon/authenticated.
 *
 * The `postgres` role used by Prisma is BYPASSRLS, so application queries
 * are unaffected.
 *
 * Idempotent — safe to re-run.
 */

const TABLES = [
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
  'integration_tools',
  'tool_invocations',
];

async function main() {
  const prisma = new PrismaClient();
  console.log('[db-enable-rls] target host:', new URL(process.env.DATABASE_URL!).host);

  // ENABLE only (no FORCE) — Prisma connects as postgres which is BYPASSRLS,
  // so application queries continue to work. anon/authenticated roles get
  // blocked entirely because no policies exist.
  for (const t of TABLES) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    console.log(`  ✓ RLS enabled on ${t}`);
  }

  // Re-check.
  const rls = await prisma.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
  `;
  const off = rls.filter((r) => !r.rowsecurity).map((r) => r.tablename);
  if (off.length) {
    console.error('[db-enable-rls] FAIL — still off on:', off);
    process.exit(1);
  }
  console.log(`[db-enable-rls] OK — RLS on for all ${rls.length} public tables.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[db-enable-rls] error:', err);
  process.exit(1);
});
