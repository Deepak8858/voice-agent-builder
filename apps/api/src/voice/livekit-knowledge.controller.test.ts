import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { LiveKitKnowledgeController } from './livekit-knowledge.controller';

const CALL_ID = '11111111-1111-4111-8111-111111111111';

function makeController(call: { agentId: string; workspaceId: string } | null) {
  const prisma = {
    call: {
      findUnique: vi.fn(async () => call),
    },
  };
  const knowledge = { search: vi.fn(async () => []) };
  const controller = new LiveKitKnowledgeController(prisma as never, knowledge as never);
  return { controller, prisma, knowledge };
}

describe('LiveKitKnowledgeController', () => {
  it('derives workspace scope from the admitted call bound to the agent', async () => {
    const { controller, prisma, knowledge } = makeController({
      agentId: 'trusted-agent',
      workspaceId: 'trusted-workspace',
    });

    await controller.search('trusted-agent', {
      query: 'refund policy',
      max_chunks: 7,
      retrieval_mode: 'agent_scoped',
      call_id: CALL_ID,
    });

    expect(prisma.call.findUnique).toHaveBeenCalledWith({
      where: { id: CALL_ID },
      select: { agentId: true, workspaceId: true },
    });
    expect(knowledge.search).toHaveBeenCalledWith('trusted-workspace', 'refund policy', {
      agentId: 'trusted-agent',
      k: 7,
    });
  });

  it('uses all ready sources in the derived workspace for workspace scope', async () => {
    const { controller, knowledge } = makeController({
      agentId: 'trusted-agent',
      workspaceId: 'trusted-workspace',
    });

    await controller.search('trusted-agent', {
      query: 'business hours',
      max_chunks: 5,
      retrieval_mode: 'workspace_scoped',
      call_id: CALL_ID,
    });

    expect(knowledge.search).toHaveBeenCalledWith('trusted-workspace', 'business hours', {
      agentId: undefined,
      k: 5,
    });
  });

  it("refuses a call bound to another workspace's agent", async () => {
    // The internal key is one credential for every tenant; the call binding is
    // what stops a key holder reading another workspace's knowledge by agent id.
    const { controller, knowledge } = makeController({
      agentId: 'other-workspace-agent',
      workspaceId: 'other-workspace',
    });

    await expect(
      controller.search('trusted-agent', {
        query: 'refund policy',
        max_chunks: 7,
        retrieval_mode: 'agent_scoped',
        call_id: CALL_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('refuses an unknown call id', async () => {
    const { controller, knowledge } = makeController(null);

    await expect(
      controller.search('trusted-agent', {
        query: 'refund policy',
        max_chunks: 7,
        retrieval_mode: 'agent_scoped',
        call_id: CALL_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(knowledge.search).not.toHaveBeenCalled();
  });
});
