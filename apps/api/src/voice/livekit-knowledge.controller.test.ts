import { describe, expect, it, vi } from 'vitest';
import { LiveKitKnowledgeController } from './livekit-knowledge.controller';

describe('LiveKitKnowledgeController', () => {
  it('derives workspace and agent scope from the persisted agent', async () => {
    const prisma = {
      agent: {
        findUnique: vi.fn(async () => ({ workspaceId: 'trusted-workspace' })),
      },
    };
    const knowledge = { search: vi.fn(async () => []) };
    const controller = new LiveKitKnowledgeController(prisma as never, knowledge as never);

    await controller.search('trusted-agent', {
      query: 'refund policy',
      max_chunks: 7,
      retrieval_mode: 'agent_scoped',
    });

    expect(prisma.agent.findUnique).toHaveBeenCalledWith({
      where: { id: 'trusted-agent' },
      select: { workspaceId: true },
    });
    expect(knowledge.search).toHaveBeenCalledWith('trusted-workspace', 'refund policy', {
      agentId: 'trusted-agent',
      k: 7,
    });
  });

  it('uses all ready sources in the derived workspace for workspace scope', async () => {
    const prisma = {
      agent: {
        findUnique: vi.fn(async () => ({ workspaceId: 'trusted-workspace' })),
      },
    };
    const knowledge = { search: vi.fn(async () => []) };
    const controller = new LiveKitKnowledgeController(prisma as never, knowledge as never);

    await controller.search('trusted-agent', {
      query: 'business hours',
      max_chunks: 5,
      retrieval_mode: 'workspace_scoped',
    });

    expect(knowledge.search).toHaveBeenCalledWith('trusted-workspace', 'business hours', {
      agentId: undefined,
      k: 5,
    });
  });
});
