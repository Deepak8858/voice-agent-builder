#!/usr/bin/env node
/**
 * VoiceForge AI — Backup Validation Script
 *
 * Performs a backup preflight by:
 * 1. Checking that the separately secured recovery environment file exists and
 *    defines every required recovery key with a non-empty value
 * 2. Checking that a recent, non-empty logical-backup artifact exists
 * 3. Checking live database connectivity with a `SELECT 1` probe
 *
 * IMPORTANT: This is not a restore test, and step 3 inspects nothing beyond
 * connectivity — no table counts, no audit recency, no backup contents. A
 * passing result does not prove that the artifact can be restored or that
 * restored row counts/checksums match production.
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

/**
 * Parse a `.env` file with dotenv-compatible semantics.
 *
 * Checking the raw assignment text is not enough: `DATABASE_URL=""` is a
 * non-empty string before parsing but resolves to an empty value, so a recovery
 * file missing a required secret would pass. This mirrors the parts of dotenv
 * that decide whether a value is empty:
 *   - an optional `export ` prefix is stripped
 *   - full-line comments (`#`) and blank lines are skipped
 *   - a value wrapped in matching quotes is unwrapped, so "" is empty
 *   - an unquoted value is trimmed and a trailing ` # comment` removed
 * Later assignments win, as they do in dotenv.
 *
 * Returns a plain object of key -> parsed value.
 */
function parseEnvFile(content) {
  const parsed = Object.create(null);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === '`') &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      // Quoted: the quotes delimit the value, so "" is genuinely empty.
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment is not part of the value.
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment);
      value = value.trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

// 1. Check the separately secured recovery environment file
const backupEnvPath = process.env.RECOVERY_ENV_FILE;
if (!backupEnvPath) {
  fail('RECOVERY_ENV_FILE is required and must point to the separately secured recovery environment file');
} else if (!fs.existsSync(backupEnvPath)) {
  fail(`RECOVERY_ENV_FILE does not exist: ${backupEnvPath}`);
} else {
  const content = fs.readFileSync(backupEnvPath, 'utf-8');
  const parsedEnv = parseEnvFile(content);
  const required = [
    'DATABASE_URL',
    'DIRECT_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_JWT_SECRET',
    'JWT_SECRET',
    'ENCRYPTION_KEY',
  ];
  for (const key of required) {
    // The parsed value is what a recovery would actually load, so an absent key
    // and a key assigned an empty (or quoted-empty) value fail alike.
    if (parsedEnv[key] === undefined || parsedEnv[key] === '') {
      fail(`Recovery environment file missing non-empty required key: ${key}`);
    }
  }
  log('Recovery environment file validated');
}

// 2. Check downloaded logical-backup artifact recency
const backupDir = process.env.BACKUP_DIR;
if (!backupDir) {
  fail('BACKUP_DIR is required and must point to downloaded logical-backup artifacts');
} else if (fs.existsSync(backupDir)) {
  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.dump'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    fail(`No backup files found in ${backupDir}`);
  } else {
    const newest = files[0];
    const newestPath = path.join(backupDir, newest.name);
    const hoursAgo = (Date.now() - newest.mtime.getTime()) / 36e5;
    if (fs.statSync(newestPath).size === 0) {
      fail(`Latest backup (${newest.name}) is empty`);
    }
    if (hoursAgo > 25) {
      fail(`Latest backup (${newest.name}) is ${Math.round(hoursAgo)}h old. Expected < 24h.`);
    } else {
      log(`Latest backup ${newest.name} is ${Math.round(hoursAgo)}h old — OK`);
    }
  }
} else {
  fail(`BACKUP_DIR does not exist: ${backupDir}`);
}

// 3. Live database connectivity check (does not inspect backup contents)
async function validateDatabase() {
  try {
    // Use the repository-pinned Prisma CLI rather than downloading via npx.
    const dbUrl = process.env.DATABASE_URL || process.env.DIRECT_URL;
    if (!dbUrl) {
      fail('DATABASE_URL or DIRECT_URL not set in environment');
      return;
    }

    execSync(
      'corepack pnpm exec prisma db execute --stdin',
      {
        input: 'SELECT 1;',
        encoding: 'utf-8',
        cwd: path.resolve(__dirname, '..', 'apps', 'api'),
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['pipe', VERBOSE ? 'inherit' : 'ignore', 'pipe'],
      }
    );
    log('Live database connectivity check passed');
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
    log('BACKUP PREFLIGHT PASSED (restore drill still required)');
    process.exit(0);
  }
})();
