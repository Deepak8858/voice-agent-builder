const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
});

async function runStatements(path) {
  const sql = fs.readFileSync(path, 'utf8');
  // Split by semicolons, filter out empty/comments
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    const clean = stmt.replace(/^\s*--.*$/gm, '').trim();
    if (!clean) continue;
    try {
      await prisma.$executeRawUnsafe(clean + ';');
      console.log(`  OK: ${clean.slice(0, 60).replace(/\n/g, ' ')}...`);
    } catch (e) {
      // Ignore "already exists" errors
      if (e.message.includes('already exists')) {
        console.log(`  SKIP (exists): ${clean.slice(0, 60).replace(/\n/g, ' ')}...`);
      } else {
        console.error(`  FAIL: ${e.message}`);
        throw e;
      }
    }
  }
}

async function main() {
  try {
    console.log('Applying 001_enable_pgvector.sql...');
    await runStatements('supabase/migrations/001_enable_pgvector.sql');

    console.log('Applying 002_rls_helpers.sql...');
    await runStatements('supabase/migrations/002_rls_helpers.sql');

    console.log('Applying 003_rls_policies.sql...');
    await runStatements('supabase/migrations/003_rls_policies.sql');

    console.log('All migrations applied successfully');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
