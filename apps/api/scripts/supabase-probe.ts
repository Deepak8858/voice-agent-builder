import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Full Supabase connectivity probe:
 *  1. REST API  (anon/publishable key)  \u2014 any project reachability
 *  2. Auth settings                      \u2014 sanity-check the URL
 *  3. Postgres (DIRECT_URL)              \u2014 via Prisma (bypasses PgBouncer)
 *  4. Postgres (DATABASE_URL)            \u2014 via Prisma (pooled, port 6543)
 *
 * Writes a readable report to stdout and exits 0 only when REST + Auth pass.
 * Postgres failures are reported but do not fail the probe by themselves so
 * you can see all signals in one run.
 */

type ProbeResult = { name: string; ok: boolean; detail: string; ms?: number };

function loadEnv(): Record<string, string> {
  const envs: Record<string, string> = { ...(process.env as Record<string, string>) };
  const candidates = [
    // cwd-relative
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '.env'),
    // repo-root (one or two levels up)
    resolve(process.cwd(), '..', '.env'),
    resolve(process.cwd(), '..', '..', '.env'),
    // apps/web/.env.local for NEXT_PUBLIC_SUPABASE_*
    resolve(process.cwd(), '..', 'web', '.env.local'),
    resolve(process.cwd(), '..', '..', 'apps', 'web', '.env.local'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/i);
        if (m && !(m[1] in envs)) envs[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* missing file is fine */
    }
  }
  return envs;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const direct = env.DIRECT_URL;
const pooled = env.DATABASE_URL;

function mask(s: string | undefined) {
  if (!s) return '';
  return s.length <= 12 ? '***' : s.slice(0, 8) + '\u2026' + s.slice(-4);
}

async function testRestReachable(): Promise<ProbeResult> {
  if (!url || !key) {
    return { name: 'REST reachable', ok: false, detail: 'NEXT_PUBLIC_SUPABASE_URL or key missing' };
  }
  const t = Date.now();
  try {
    // /rest/v1/ requires a secret key. Just the TLS handshake + any HTTP
    // response proves the project host exists and the key format is valid.
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const ms = Date.now() - t;
    // 200, 401, 404 all prove the project is up. 5xx / network = failure.
    if (res.status < 500) {
      return {
        name: 'REST reachable',
        ok: true,
        ms,
        detail: `${res.status} ${res.statusText} (project responding)`,
      };
    }
    return {
      name: 'REST reachable',
      ok: false,
      ms,
      detail: `${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return { name: 'REST reachable', ok: false, detail: (err as Error).message };
  }
}

async function testAuthSettings(): Promise<ProbeResult> {
  if (!url || !key) return { name: 'Auth settings', ok: false, detail: 'missing env' };
  const t = Date.now();
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    const ms = Date.now() - t;
    if (!res.ok) {
      return { name: 'Auth settings', ok: false, ms, detail: `${res.status} ${res.statusText}` };
    }
    const data = (await res.json()) as { external?: Record<string, unknown> };
    const providers = Object.keys(data.external || {}).length;
    return { name: 'Auth settings', ok: true, ms, detail: `${providers} providers configured` };
  } catch (err) {
    return { name: 'Auth settings', ok: false, detail: (err as Error).message };
  }
}

async function testPostgres(label: string, connUrl?: string): Promise<ProbeResult> {
  if (!connUrl || connUrl.includes('<project-ref>') || connUrl.trim().length === 0) {
    return { name: label, ok: false, detail: 'not configured' };
  }
  const t = Date.now();
  const client = new PrismaClient({ datasources: { db: { url: connUrl } } });
  try {
    const rows = (await client.$queryRawUnsafe(
      'SELECT current_database() AS db, current_user AS user, version() AS v',
    )) as Array<{ db: string; user: string; v: string }>;
    const ms = Date.now() - t;
    const row = rows[0];
    return {
      name: label,
      ok: true,
      ms,
      detail: `db=${row.db} user=${row.user} server=${(row.v || '').split(',')[0]}`,
    };
  } catch (err) {
    const e = err as Error & { code?: string };
    const full = (e.stack || e.message || String(err)).replace(/\s+/g, ' ').slice(0, 600);
    return { name: label, ok: false, detail: `${e.code ? `[${e.code}] ` : ''}${full}` };
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

(async () => {
  console.log('\n[supabase-probe] Running...');
  console.log(`  URL  : ${url}`);
  console.log(`  key  : ${mask(key)}`);
  console.log(`  DIRECT_URL   : ${direct ? '(set)' : '(unset)'}`);
  console.log(`  DATABASE_URL : ${pooled ? '(set)' : '(unset)'}`);
  console.log('');

  const results: ProbeResult[] = [];
  results.push(await testRestReachable());
  results.push(await testAuthSettings());
  results.push(await testPostgres('Postgres DIRECT_URL (5432)', direct));
  results.push(await testPostgres('Postgres DATABASE_URL (6543 pooled)', pooled));

  for (const r of results) {
    const mark = r.ok ? '\u2713' : '\u2717';
    const ms = r.ms !== undefined ? ` (${r.ms}ms)` : '';
    console.log(`  ${mark} ${r.name}${ms} \u2014 ${r.detail}`);
  }

  const restOk = results[0].ok && results[1].ok;
  console.log('');
  console.log(restOk ? '[supabase-probe] REST OK' : '[supabase-probe] REST FAILED');
  process.exit(restOk ? 0 : 1);
})();
