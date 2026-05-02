const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfill() {
  // Tables with direct workspace_id
  const direct = ['agents', 'calls', 'knowledge_sources', 'knowledge_chunks'];
  for (const table of direct) {
    const result = await prisma.$executeRawUnsafe(`
      UPDATE "${table}" t
      SET organization_id = w.organization_id
      FROM workspaces w
      WHERE t.workspace_id = w.id AND t.organization_id IS NULL
    `);
    console.log(`Backfilled ${table}: ${result} rows`);
  }

  // agent_versions joins through agents
  const result = await prisma.$executeRawUnsafe(`
    UPDATE "agent_versions" t
    SET organization_id = a.organization_id
    FROM agents a
    WHERE t.agent_id = a.id AND t.organization_id IS NULL
  `);
  console.log(`Backfilled agent_versions: ${result} rows`);
}

backfill()
  .then(() => console.log('Done'))
  .catch(e => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
