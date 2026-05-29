import './load-env';
import { PrismaClient } from '@prisma/client';
import { EXPECTED_PUBLIC_TABLES } from '../src/db/public-table-exposure-policy';

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

const TABLES = [...EXPECTED_PUBLIC_TABLES];

async function main() {
  const prisma = new PrismaClient();
  console.log('[db-enable-rls] target host:', new URL(process.env.DATABASE_URL!).host);

  const rows = await prisma.$queryRaw<Array<{ tableName: string }>>`
    SELECT c.relname AS "tableName"
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
  const known = new Set(TABLES);
  const unknown = rows.map((r) => r.tableName).filter((table) => !known.has(table));
  if (unknown.length) {
    console.error('[db-enable-rls] FAIL — public tables without exposure policy:', unknown);
    process.exit(1);
  }

  // ENABLE only (no FORCE) — Prisma connects as postgres which is BYPASSRLS,
  // so application queries continue to work. Data API roles are still governed
  // by the explicit GRANT + policy posture verified in db-verify.ts.
  for (const t of rows.map((r) => r.tableName)) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE public.${quoteIdentifier(t)} ENABLE ROW LEVEL SECURITY`,
    );
    console.log(`  ✓ RLS enabled on ${t}`);
  }

  // Re-check.
  const rls = await prisma.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`
    SELECT c.relname AS tablename,
           c.relrowsecurity AS rowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_inherits i
        WHERE i.inhrelid = c.oid
      )
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
