import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSpecSchema, MVP_TEMPLATES, type AgentSpec } from '@voiceforge/shared';
import {
  AGENT_GEN_JOB,
  AGENT_GEN_JOB_ATTEMPTS,
  AGENT_GEN_QUEUE,
  AgentGenService,
  GenSessionBusyError,
  GenSessionInvalidStateError,
  GenSessionNotFoundError,
} from './agent-gen.service';
import { AgentSpecInvalidError } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { QueueService } from '../queue/queue.service';
import type { AgentsService } from '../agents/agents.service';
import type { LlmAgentGenerator } from '../llm/llm.provider.interface';
import { env } from '../config/env';

const VALID_SPEC: AgentSpec = AgentSpecSchema.parse(MVP_TEMPLATES[0]!.spec);

const WS = 'ws-1';
const USER = 'user-1';
const SESSION_ID = 'session-1';

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    workspaceId: WS,
    organizationId: 'org-1',
    userId: USER,
    status: 'awaiting_user',
    messages: [] as unknown,
    currentSpec: null as unknown,
    specValid: false,
    agentId: null as string | null,
    lastError: null as string | null,
    generatingAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createMocks() {
  const prisma = {
    agentGenSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
    },
    organizationIdFor: vi.fn().mockResolvedValue('org-1'),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const queueHandle = { add: vi.fn().mockResolvedValue({}) };
  const queue = { queue: vi.fn(() => queueHandle) };
  const agents = {
    create: vi.fn().mockResolvedValue({ id: 'agent-1' }),
    publish: vi.fn().mockResolvedValue({}),
  };
  const llm = { name: 'mock', generate: vi.fn(), chatGenerate: vi.fn() };

  const service = new AgentGenService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    queue as unknown as QueueService,
    agents as unknown as AgentsService,
    llm as unknown as LlmAgentGenerator,
  );
  return { prisma, audit, queue, queueHandle, agents, llm, service };
}

describe('AgentGenService.sendMessage', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('throws the 409 busy error while a generation is in flight', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );

    await expect(
      mocks.service.sendMessage(WS, USER, SESSION_ID, { content: 'hi' }),
    ).rejects.toBeInstanceOf(GenSessionBusyError);
    await expect(
      mocks.service.sendMessage(WS, USER, SESSION_ID, { content: 'hi' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.queueHandle.add).not.toHaveBeenCalled();
  });

  it('rejects messages on a completed session', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ status: 'completed' }));

    await expect(
      mocks.service.sendMessage(WS, USER, SESSION_ID, { content: 'hi' }),
    ).rejects.toBeInstanceOf(GenSessionInvalidStateError);
  });

  it('throws not-found for a session owned by someone else', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(null);

    await expect(
      mocks.service.sendMessage(WS, USER, SESSION_ID, { content: 'hi' }),
    ).rejects.toBeInstanceOf(GenSessionNotFoundError);
  });

  it('appends the user message, flips to generating, and enqueues a job', async () => {
    const existing = [{ role: 'user', content: 'earlier', at: '2026-01-01T00:00:00.000Z' }];
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ messages: existing }));
    mocks.prisma.agentGenSession.update.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );

    const result = await mocks.service.sendMessage(WS, USER, SESSION_ID, {
      content: 'add SMS follow-up',
      context: { template_slug: 'ai-receptionist' },
    });

    expect(result.status).toBe('generating');

    const update = mocks.prisma.agentGenSession.update.mock.calls[0]![0];
    expect(update.where).toEqual({ id: SESSION_ID });
    expect(update.data.status).toBe('generating');
    expect(update.data.generatingAt).toBeInstanceOf(Date);
    expect(update.data.lastError).toBeNull();
    const messages = update.data.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'user' });
    expect(messages[1]!.content).toContain('add SMS follow-up');

    expect(mocks.queue.queue).toHaveBeenCalledWith(AGENT_GEN_QUEUE);
    expect(mocks.queueHandle.add).toHaveBeenCalledWith(
      AGENT_GEN_JOB,
      { sessionId: SESSION_ID, workspaceId: WS, template_slug: 'ai-receptionist' },
      expect.objectContaining({ attempts: AGENT_GEN_JOB_ATTEMPTS }),
    );
  });

  it('folds drawer context into the message content', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow());
    mocks.prisma.agentGenSession.update.mockResolvedValue(sessionRow({ status: 'generating' }));

    await mocks.service.sendMessage(WS, USER, SESSION_ID, {
      content: 'build it',
      context: { business_name: 'Smile Dental', call_direction: 'inbound', crm_providers: ['hubspot'] },
    });

    const update = mocks.prisma.agentGenSession.update.mock.calls[0]![0];
    const messages = update.data.messages as Array<{ content: string }>;
    const content = messages.at(-1)!.content;
    expect(content).toContain('[Context]');
    expect(content).toContain('Business name: Smile Dental');
    expect(content).toContain('Call direction: inbound');
    expect(content).toContain('CRM integrations: hubspot');
  });

  it('allows retrying from a failed session', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ status: 'failed' }));
    mocks.prisma.agentGenSession.update.mockResolvedValue(sessionRow({ status: 'generating' }));

    await expect(
      mocks.service.sendMessage(WS, USER, SESSION_ID, { content: 'try again' }),
    ).resolves.toMatchObject({ status: 'generating' });
    expect(mocks.queueHandle.add).toHaveBeenCalledTimes(1);
  });
});

describe('AgentGenService.processGeneration', () => {
  const payload = { sessionId: SESSION_ID, workspaceId: WS };
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('is a no-op for sessions no longer generating (idempotent retry)', async () => {
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(sessionRow({ status: 'awaiting_user' }));

    await mocks.service.processGeneration(payload, true);

    expect(mocks.llm.chatGenerate).not.toHaveBeenCalled();
    expect(mocks.prisma.agentGenSession.update).not.toHaveBeenCalled();
  });

  it('appends the assistant reply, stores the spec, and returns to awaiting_user on success', async () => {
    const history = [{ role: 'user', content: 'build it', at: '2026-01-01T00:00:00.000Z' }];
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date(), messages: history }),
    );
    mocks.llm.chatGenerate.mockResolvedValue({ assistant_message: 'Here is a draft.', spec: VALID_SPEC });
    mocks.prisma.agentGenSession.update.mockResolvedValue(sessionRow());

    await mocks.service.processGeneration({ ...payload, template_slug: 'ai-receptionist' }, true);

    expect(mocks.llm.chatGenerate).toHaveBeenCalledWith({
      messages: history,
      currentSpec: undefined,
      template_slug: 'ai-receptionist',
    });

    const update = mocks.prisma.agentGenSession.update.mock.calls[0]![0];
    expect(update.data).toMatchObject({
      status: 'awaiting_user',
      generatingAt: null,
      specValid: true,
      lastError: null,
    });
    expect(update.data.currentSpec).toEqual(VALID_SPEC);
    const messages = update.data.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Here is a draft.' });
  });

  it('passes the current spec so the model refines rather than regenerates', async () => {
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(
      sessionRow({ status: 'generating', currentSpec: VALID_SPEC, messages: [] }),
    );
    mocks.llm.chatGenerate.mockResolvedValue({ assistant_message: 'Tweaked.', spec: VALID_SPEC });
    mocks.prisma.agentGenSession.update.mockResolvedValue(sessionRow());

    await mocks.service.processGeneration(payload, true);

    expect(mocks.llm.chatGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ currentSpec: VALID_SPEC }),
    );
  });

  it('rethrows on a non-final attempt so BullMQ retries', async () => {
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );
    mocks.llm.chatGenerate.mockRejectedValue(new Error('provider down'));

    await expect(mocks.service.processGeneration(payload, false)).rejects.toThrow('provider down');
    expect(mocks.prisma.agentGenSession.updateMany).not.toHaveBeenCalled();
  });

  it('marks the session failed on the final attempt instead of throwing', async () => {
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );
    mocks.llm.chatGenerate.mockRejectedValue(new Error('provider down'));

    await expect(mocks.service.processGeneration(payload, true)).resolves.toBeUndefined();

    expect(mocks.prisma.agentGenSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: 'generating' },
      data: expect.objectContaining({
        status: 'failed',
        generatingAt: null,
        lastError: expect.stringContaining('provider down'),
      }),
    });
  });
});

describe('AgentGenService stale sweep', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('fails a session stuck generating past the deadline on read', async () => {
    const staleAt = new Date(Date.now() - (env.AGENT_GEN_STALE_AFTER_SECONDS + 5) * 1_000);
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: staleAt }),
    );
    mocks.prisma.agentGenSession.findUnique.mockResolvedValue(
      sessionRow({ status: 'failed', lastError: 'Generation timed out. Please try again.' }),
    );

    const session = await mocks.service.getSession(WS, USER, SESSION_ID);

    expect(mocks.prisma.agentGenSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: 'generating' },
      data: expect.objectContaining({ status: 'failed' }),
    });
    expect(session.status).toBe('failed');
    expect(session.last_error).toContain('timed out');
  });

  it('leaves a fresh generating session untouched', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );

    const session = await mocks.service.getSession(WS, USER, SESSION_ID);

    expect(mocks.prisma.agentGenSession.updateMany).not.toHaveBeenCalled();
    expect(session.status).toBe('generating');
  });
});

describe('AgentGenService.finalize', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('throws when there is no spec to finalize', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ currentSpec: null }));

    await expect(
      mocks.service.finalize(WS, USER, SESSION_ID, { publish: false }),
    ).rejects.toBeInstanceOf(GenSessionInvalidStateError);
    expect(mocks.agents.create).not.toHaveBeenCalled();
  });

  it('throws busy while generating and invalid-state when already completed', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(
      sessionRow({ status: 'generating', generatingAt: new Date() }),
    );
    await expect(
      mocks.service.finalize(WS, USER, SESSION_ID, { publish: false }),
    ).rejects.toBeInstanceOf(GenSessionBusyError);

    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(
      sessionRow({ status: 'completed', agentId: 'agent-1' }),
    );
    await expect(
      mocks.service.finalize(WS, USER, SESSION_ID, { publish: false }),
    ).rejects.toBeInstanceOf(GenSessionInvalidStateError);
  });

  it('creates the agent from the session spec and marks the session completed', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ currentSpec: VALID_SPEC }));
    mocks.prisma.agentGenSession.update.mockResolvedValue(
      sessionRow({ status: 'completed', agentId: 'agent-1' }),
    );

    const result = await mocks.service.finalize(WS, USER, SESSION_ID, { publish: false });

    expect(mocks.agents.create).toHaveBeenCalledWith(WS, USER, {
      name: VALID_SPEC.name,
      industry: VALID_SPEC.industry,
      agent_type: VALID_SPEC.agent_type,
      spec: VALID_SPEC,
    });
    expect(mocks.agents.publish).not.toHaveBeenCalled();
    expect(mocks.prisma.agentGenSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: expect.objectContaining({ status: 'completed', agentId: 'agent-1' }),
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.generate.finalize', resourceId: 'agent-1' }),
    );
    expect(result.session.status).toBe('completed');
    expect(result.agent).toMatchObject({ id: 'agent-1' });
  });

  it('publishes the agent when the publish flag is set', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ currentSpec: VALID_SPEC }));
    mocks.prisma.agentGenSession.update.mockResolvedValue(
      sessionRow({ status: 'completed', agentId: 'agent-1' }),
    );

    await mocks.service.finalize(WS, USER, SESSION_ID, { publish: true });

    expect(mocks.agents.publish).toHaveBeenCalledWith(WS, 'agent-1', USER);
  });

  it('validates spec_override and rejects an invalid one', async () => {
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ currentSpec: VALID_SPEC }));

    await expect(
      mocks.service.finalize(WS, USER, SESSION_ID, {
        publish: false,
        spec_override: { schema_version: '1.0', name: 'broken' },
      }),
    ).rejects.toBeInstanceOf(AgentSpecInvalidError);
    expect(mocks.agents.create).not.toHaveBeenCalled();
  });

  it('uses a valid spec_override over the session spec and persists it', async () => {
    const override: AgentSpec = { ...VALID_SPEC, name: 'Edited Locally' };
    mocks.prisma.agentGenSession.findFirst.mockResolvedValue(sessionRow({ currentSpec: VALID_SPEC }));
    mocks.prisma.agentGenSession.update.mockResolvedValue(
      sessionRow({ status: 'completed', agentId: 'agent-1' }),
    );

    await mocks.service.finalize(WS, USER, SESSION_ID, { publish: false, spec_override: override });

    expect(mocks.agents.create).toHaveBeenCalledWith(
      WS,
      USER,
      expect.objectContaining({ name: 'Edited Locally' }),
    );
    const update = mocks.prisma.agentGenSession.update.mock.calls[0]![0];
    expect(update.data.specValid).toBe(true);
    expect(update.data.currentSpec).toMatchObject({ name: 'Edited Locally' });
  });
});
