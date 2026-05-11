const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
});

async function main() {
  try {
    // Check all schemas
    const result = await prisma.$queryRawUnsafe(
      "SELECT n.nspname as schema, p.proname as name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname LIKE '%clerk%';"
    );
    console.log('Functions found:', result);

    // Check migrations table
    const migs = await prisma.$queryRawUnsafe(
      "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;"
    );
    console.log('Migrations applied:', migs);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
