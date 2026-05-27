import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PublicAgentsController } from './agents.controller';

const AGENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const VERSION_DATE = new Date('2026-05-20T10:00:00.000Z');

function makeController() {
  const publishedAgent = {
    id: AGENT_ID,
    name: 'Dental Receptionist',
    status: 'published',
    createdAt: new Date('2026-05-19T10:00:00.000Z'),
    workspace: {
      name: 'Smile Dental Workspace',
      slug: 'smile-dental',
      whiteLabel: { brandName: 'Smile Dental' },
    },
    organization: { name: 'Acme Clinics' },
  };
  const latestVersion = {
    id: 'version-1',
    agentId: AGENT_ID,
    versionNumber: 1,
    createdAt: VERSION_DATE,
    specJson: {
      schema_version: '1.0',
      name: 'Dental Receptionist',
      industry: 'dental',
      agent_type: 'inbound_receptionist',
      identity: { business_name: 'Smile Dental', agent_name: 'Ava' },
      voice: { tone: 'warm', allow_interruptions: true },
      goals: ['Book appointments', 'Transfer emergencies'],
    },
  };

  const prisma = {
    agent: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; status?: string } }) => {
        if (where.id === AGENT_ID && where.status === 'published') {
          return publishedAgent;
        }
        return null;
      }),
    },
    agentVersion: {
      findFirst: vi.fn(async ({ where }: { where: { agentId: string } }) => {
        return where.agentId === AGENT_ID ? latestVersion : null;
      }),
    },
  };

  return {
    controller: new PublicAgentsController(prisma as never),
    prisma,
  };
}

describe('PublicAgentsController', () => {
  it('marks the public share endpoint as public', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, PublicAgentsController.prototype.getById);
    expect(isPublic).toBe(true);
  });

  it('resolves a published agent from a human-readable share slug', async () => {
    const { controller, prisma } = makeController();

    const result = await controller.getById(`dental-receptionist-${AGENT_ID}`);

    expect(result.found).toBe(true);
    if (!result.found) {
      throw new Error('expected published agent share payload');
    }

    expect(prisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: AGENT_ID, status: 'published' },
      }),
    );
    expect(result).toMatchObject({
      found: true,
      id: AGENT_ID,
      name: 'Dental Receptionist',
      shareSlug: `dental-receptionist-${AGENT_ID}`,
      demoAudioUrl: '/demo/dental-receptionist-30s.wav',
      workspaceName: 'Smile Dental',
      organizationName: 'Acme Clinics',
      spec: {
        identity: { business_name: 'Smile Dental', agent_name: 'Ava' },
        goals: ['Book appointments', 'Transfer emergencies'],
      },
    });
    expect(result.publishedAt).toEqual(VERSION_DATE);
    expect(result.sampleTranscript?.[0]?.text).toContain('Smile Dental');
  });

  it('does not expose draft or unknown agents', async () => {
    const { controller } = makeController();

    await expect(controller.getById('not-a-published-agent')).resolves.toEqual({ found: false });
  });
});
