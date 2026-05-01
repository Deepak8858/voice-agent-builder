const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
});

async function main() {
  try {
    await prisma.$queryRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector;");
    console.log('pgvector extension enabled successfully');
  } catch (e) {
    console.error('Failed to enable pgvector:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
