const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
});

async function main() {
  try {
    // Drop the JSON embedding column so Prisma can recreate it as vector(1536)
    await prisma.$executeRawUnsafe('ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding;');
    console.log('Dropped old embedding column');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
