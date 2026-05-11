#!/usr/bin/env node
/**
 * VoiceForge AI — Backup Validation Script
 *
 * Verifies that critical data can be restored from backup by:
 * 1. Pinging the live database via Prisma
 * 2. Counting key tables (users, workspaces, agents, calls)
 * 3. Checking that the most recent audit log is within the last 24h
 * 4. Validating that a .env.backup file exists and contains required keys
 *
 * Run:
 *   node scripts/backup-validation.js
 *   node scripts/backup-validation.js --verbose
 *
 * Exit codes:
 *   0 = healthy, backups look recent
 *   1 = validation failed
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  if (level === 'error') console.error(`[${ts}] ERROR: ${msg}`);
  else if (VERBOSE || level === 'warn') console.log(`[${ts}] ${level.toUpperCase()}: ${msg}`);
}

let failed = false;

function fail(msg) {
  failed = true;
  log(msg, 'error');
}

// 1. Check .env.backup exists
const backupEnvPath = path.resolve(__dirname, '..', '.env.backup');
if (!fs.existsSync(backupEnvPath)) {
  fail('.env.backup file not found. Create a copy of your production .env for disaster recovery.');
} else {
  const content = fs.readFileSync(backupEnvPath, 'utf-8');
  const required = ['DATABASE_URL', 'DIRECT_URL', 'CLERK_SECRET_KEY', 'JWT_SECRET'];
  for (const key of required) {
    if (!content.includes(key)) fail(`.env.backup missing required key: ${key}`);
  }
  log('.env.backup validated');
}

// 2. Check pg_dump / logical backup recency (if backup dir configured)
const backupDir = process.env.BACKUP_DIR || path.resolve(__dirname, '..', 'backups');
if (fs.existsSync(backupDir)) {
  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.dump'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    fail(`No backup files found in ${backupDir}`);
  } else {
    const newest = files[0];
    const hoursAgo = (Date.now() - newest.mtime.getTime()) / 36e5;
    if (hoursAgo > 25) {
      fail(`Latest backup (${newest.name}) is ${Math.round(hoursAgo)}h old. Expected < 24h.`);
    } else {
      log(`Latest backup ${newest.name} is ${Math.round(hoursAgo)}h old — OK`);
    }
  }
} else {
  log(`BACKUP_DIR not configured or does not exist: ${backupDir}`, 'warn');
}

// 3. Prisma health check (counts + audit recency)
async function validateDatabase() {
  try {
    // Use npx prisma directly to avoid importing the full app
    const dbUrl = process.env.DATABASE_URL || process.env.DIRECT_URL;
    if (!dbUrl) {
      fail('DATABASE_URL or DIRECT_URL not set in environment');
      return;
    }

    const result = execSync(
      `npx prisma db execute --stdin --url="${dbUrl}"`,
      {
        input: `
SELECT
  (SELECT count(*)::int FROM "User") as user_count,
  (SELECT count(*)::int FROM "Workspace") as workspace_count,
  (SELECT count(*)::int FROM "Agent") as agent_count,
  (SELECT count(*)::int FROM "Call") as call_count,
  (SELECT count(*)::int FROM "AuditLog" WHERE "createdAt" > now() - interval '24 hours') as recent_audits;
        `,
        encoding: 'utf-8',
        cwd: path.resolve(__dirname, '..', 'apps', 'api'),
        env: { ...process.env, PATH: process.env.PATH },
      }
    );

    const lines = result.split('\n').filter(l => l.includes('|'));
    const dataLine = lines.find(l => l.trim().startsWith('|') && !l.includes('---') && !l.includes('count'));
    if (dataLine) {
      const cols = dataLine.split('|').map(s => s.trim()).filter(Boolean);
      const [users, workspaces, agents, calls, recentAudits] = cols.map(Number);
      log(`DB counts — users:${users} workspaces:${workspaces} agents:${agents} calls:${calls} recent_audits:${recentAudits}`);
      if (recentAudits === 0) fail('No audit logs in the last 24h — suspicious silence');
    } else {
      fail('Could not parse Prisma db execute output for counts');
    }
  } catch (err) {
    fail(`Database validation failed: ${err.message}`);
  }
}

(async () => {
  await validateDatabase();

  if (failed) {
    log('BACKUP VALIDATION FAILED', 'error');
    process.exit(1);
  } else {
    log('BACKUP VALIDATION PASSED');
    process.exit(0);
  }
})();
