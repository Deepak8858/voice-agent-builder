import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { MVP_TEMPLATES, type AgentSpec } from '@voiceforge/shared';

const prisma = new PrismaClient();

const DEMO_USER_EMAIL = 'demo@voiceforge.local';
const DEMO_ORG_SLUG = 'demo-org';
const DEMO_WORKSPACE_SLUG = 'demo';

async function seedTemplates() {
  console.log(`[seed] Templates (${MVP_TEMPLATES.length})…`);
  for (const t of MVP_TEMPLATES) {
    await prisma.agentTemplate.upsert({
      where: { slug: t.slug },
      create: {
        slug: t.slug,
        name: t.name,
        description: t.description,
        industry: t.industry,
        agentType: t.agent_type,
        templateSpec: t.spec as unknown as Prisma.InputJsonValue,
        isPublic: true,
      },
      update: {
        name: t.name,
        description: t.description,
        industry: t.industry,
        agentType: t.agent_type,
        templateSpec: t.spec as unknown as Prisma.InputJsonValue,
      },
    });
    console.log(`  ✔ ${t.slug}`);
  }
}

async function seedDemoTenant() {
  console.log('[seed] Demo tenant (user + org + workspace)…');
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    create: { email: DEMO_USER_EMAIL, name: 'Demo Owner' },
    update: { name: 'Demo Owner' },
  });

  const organization = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    create: {
      slug: DEMO_ORG_SLUG,
      name: 'Demo Organization',
      ownerUserId: user.id,
      plan: 'starter',
    },
    update: { name: 'Demo Organization', ownerUserId: user.id },
  });

  const workspace = await prisma.workspace.upsert({
    where: { organizationId_slug: { organizationId: organization.id, slug: DEMO_WORKSPACE_SLUG } },
    create: {
      organizationId: organization.id,
      slug: DEMO_WORKSPACE_SLUG,
      name: 'Demo Workspace',
      type: 'direct',
    },
    update: { name: 'Demo Workspace' },
  });

  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    create: { userId: user.id, workspaceId: workspace.id, role: 'owner' },
    update: { role: 'owner' },
  });

  console.log(`  ✔ user=${user.id.slice(0, 8)} org=${organization.id.slice(0, 8)} ws=${workspace.id.slice(0, 8)}`);
  return { user, organization, workspace };
}

async function seedDemoAgents(workspaceId: string, creatorId: string) {
  console.log('[seed] Demo agents (2)…');
  const seedSlugs = ['dental-receptionist', 'appointment-reminder'];
  const out: Array<{ id: string; name: string }> = [];
  for (const slug of seedSlugs) {
    const t = MVP_TEMPLATES.find((x) => x.slug === slug);
    if (!t) continue;
    const spec = structuredClone(t.spec) as AgentSpec;
    spec.identity.business_name = 'Smile Dental Demo';
    if (slug === 'dental-receptionist') spec.name = 'Smile Dental Receptionist (demo)';
    if (slug === 'appointment-reminder') spec.name = 'Smile Dental Reminder (demo)';

    // Reuse an existing agent if seed has run before — match by name+workspace.
    const existing = await prisma.agent.findFirst({
      where: { workspaceId, name: spec.name },
      include: { versions: true },
    });
    let agentId = existing?.id;
    if (!agentId) {
      const agent = await prisma.agent.create({
        data: {
          workspaceId,
          name: spec.name,
          description: t.description,
          industry: spec.industry,
          agentType: spec.agent_type,
          createdBy: creatorId,
        },
      });
      const v = await prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          versionNumber: 1,
          specJson: spec as unknown as Prisma.InputJsonValue,
          createdBy: creatorId,
          deploymentStatus: 'deployed',
          provider: 'mock',
        },
      });
      await prisma.agent.update({
        where: { id: agent.id },
        data: { activeVersionId: v.id, status: 'published' },
      });
      agentId = agent.id;
      console.log(`  ✔ created ${slug} → ${agent.id.slice(0, 8)}`);
    } else {
      console.log(`  · existing ${slug} → ${agentId.slice(0, 8)}`);
    }
    out.push({ id: agentId!, name: spec.name });
  }
  return out;
}

async function seedDemoKnowledge(workspaceId: string, agentId: string, creatorId: string) {
  console.log('[seed] Demo knowledge source (text)…');
  const existing = await prisma.knowledgeSource.findFirst({
    where: { workspaceId, agentId, title: 'Demo clinic FAQ' },
  });
  if (existing) {
    console.log(`  · existing → ${existing.id.slice(0, 8)}`);
    return existing;
  }
  const content = [
    'Smile Dental Demo Clinic',
    'Hours: Mon–Fri 9:00 AM – 6:00 PM, Sat 10:00 AM – 2:00 PM. Closed Sundays.',
    'Address: 123 Demo Avenue, Suite 4. Free parking on-site.',
    'New-patient cleaning: $79. Standard cleaning: $129. Emergency exam: $59.',
    'We accept Delta, Aetna, MetLife, and Cigna PPO.',
    'For severe pain, bleeding, or swelling we transfer immediately to the on-call dentist.',
    'Cancellations require 24 hours notice. No-shows are charged $25.',
  ].join('\n');

  const source = await prisma.knowledgeSource.create({
    data: {
      workspaceId,
      agentId,
      sourceType: 'text',
      title: 'Demo clinic FAQ',
      content,
      status: 'ready',
      createdBy: creatorId,
    },
  });
  // Naive single-chunk for demo.
  await prisma.knowledgeChunk.create({
    data: {
      sourceId: source.id,
      workspaceId,
      agentId,
      chunkIndex: 0,
      content,
    },
  });
  console.log(`  ✔ created → ${source.id.slice(0, 8)}`);
  return source;
}

async function seedDemoCall(workspaceId: string, agentId: string) {
  console.log('[seed] Demo browser-test call…');
  const existing = await prisma.call.findFirst({
    where: { workspaceId, agentId, direction: 'browser_test' },
  });
  if (existing) {
    console.log(`  · existing → ${existing.id.slice(0, 8)}`);
    return existing;
  }
  const transcript = [
    'agent: Hi, this is Ava. How can I help?',
    'caller: I would like to book an appointment.',
    'agent: Happy to help. May I have your full name and phone number?',
    'caller: John Smith, 555 123 4567.',
    'agent: Thanks John. What day works best for you?',
  ].join('\n');

  const startedAt = new Date(Date.now() - 7 * 1000);
  const endedAt = new Date();
  const call = await prisma.call.create({
    data: {
      workspaceId,
      agentId,
      direction: 'browser_test',
      status: 'completed',
      provider: 'mock',
      providerCallId: 'mock_seed_demo',
      contactName: 'Browser tester',
      startedAt,
      endedAt,
      durationSeconds: 7,
      transcriptText: transcript,
      outcome: 'test_completed',
    },
  });
  console.log(`  ✔ created → ${call.id.slice(0, 8)}`);
  return call;
}

async function main() {
  await seedTemplates();
  const { user, workspace } = await seedDemoTenant();
  const agents = await seedDemoAgents(workspace.id, user.id);
  if (agents[0]) {
    await seedDemoKnowledge(workspace.id, agents[0].id, user.id);
    await seedDemoCall(workspace.id, agents[0].id);
  }
  console.log('[seed] Done.');
}

main()
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
