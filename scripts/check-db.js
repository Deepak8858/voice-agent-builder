const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
});

async function main() {
  try {
    const vectorExt = await prisma.$queryRawUnsafe(
      "SELECT extname FROM pg_extension WHERE extname = 'vector';"
    );
    console.log('pgvector:', vectorExt.length > 0 ? 'ENABLED' : 'NOT ENABLED');

    const tables = await prisma.$queryRawUnsafe(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
    );
    console.log('Tables:', tables.length);
    console.log(tables.map(t => t.tablename).join('\n'));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
