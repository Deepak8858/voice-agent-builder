import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundCampaignService } from './outbound-campaign.service';

const mockPrisma = {
  agent: {
    findFirst: vi.fn(),
  },
  outboundCampaign: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  twilioPhoneNumber: {
    count: vi.fn(),
  },
  telephonyPhoneNumber: {
    findFirst: vi.fn(),
  },
};

const mockQueue = {
  enqueue: vi.fn(),
};

const mockAudit = {
  log: vi.fn(),
};

describe('OutboundCampaignService', () => {
  let service: OutboundCampaignService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agent.findFirst.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.outboundCampaign.updateMany.mockResolvedValue({ count: 1 });
    // Default: a usable BYO number exists, so the phone-number gate passes.
    mockPrisma.twilioPhoneNumber.count.mockResolvedValue(0);
    mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue({ id: 'num-1' });
    service = new OutboundCampaignService(mockPrisma as any, mockQueue as any, mockAudit as any);
  });

  describe('list', () => {
    it('returns campaigns for workspace', async () => {
      const campaigns = [{ id: 'c1', name: 'Campaign 1' }, { id: 'c2', name: 'Campaign 2' }];
      mockPrisma.outboundCampaign.findMany.mockResolvedValue(campaigns);

      const result = await service.list('ws-1');
      expect(result).toEqual(campaigns);
      expect(mockPrisma.outboundCampaign.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('create', () => {
    it('creates campaign with draft status', async () => {
      const dto = {
        agent_id: 'agent-1',
      purpose: 'appointment_reminder',
        name: 'Dental Recall',
        contacts: [{ phone: '+15551234567', full_name: 'John Doe' }],
      };
      mockPrisma.outboundCampaign.create.mockResolvedValue({ id: 'camp-1', ...dto, status: 'draft' });

      const result = await service.create('ws-1', 'user-1', dto);
      expect(result.status).toBe('draft');
      expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith({
        where: { id: 'agent-1', workspaceId: 'ws-1' },
        select: { id: true },
      });
      expect(mockPrisma.outboundCampaign.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          name: 'Dental Recall',
          purpose: 'appointment_reminder',
          contacts: dto.contacts,
          schedule: { max_calls_per_hour: 10, max_concurrent: 3 },
          status: 'draft',
        },
      });
      expect(mockAudit.log).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        action: 'campaign.create',
        resourceType: 'outbound_campaign',
        resourceId: 'camp-1',
        metadata: {
          agent_id: 'agent-1',
      purpose: 'appointment_reminder',
          contact_count: 1,
        },
      });
    });

    it('applies custom schedule', async () => {
      const dto = {
        agent_id: 'agent-1',
      purpose: 'appointment_reminder',
        name: 'Fast Campaign',
        contacts: [],
        schedule: { max_calls_per_hour: 50, max_concurrent: 10 },
      };
      mockPrisma.outboundCampaign.create.mockResolvedValue({ id: 'camp-1' });

      await service.create('ws-1', 'user-1', dto);
      expect(mockPrisma.outboundCampaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schedule: { max_calls_per_hour: 50, max_concurrent: 10 },
        }),
      });
    });

    it('rejects campaign creation for an agent outside the workspace', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);
      const dto = {
        agent_id: 'agent-2',
        purpose: 'appointment_reminder',
        name: 'Invalid Campaign',
        contacts: [{ phone: '+15551234567' }],
      };

      await expect(service.create('ws-1', 'user-1', dto)).rejects.toMatchObject({
        errorCode: 'AGENT_NOT_FOUND',
      });
      expect(mockPrisma.outboundCampaign.create).not.toHaveBeenCalled();
    });

    it('refuses creation when the workspace has no usable phone number', async () => {
      mockPrisma.twilioPhoneNumber.count.mockResolvedValue(0);
      mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null);
      const dto = { agent_id: 'agent-1', purpose: 'appointment_reminder', name: 'No Numbers', contacts: [{ phone: '+15551234567' }] };

      const err = await service.create('ws-1', 'user-1', dto).catch((e) => e);
      expect(err.errorCode).toBe('PHONE_NUMBER_REQUIRED');
      expect(err.getStatus()).toBe(409);
      expect(err.details).toEqual({ redirect: '/dashboard/settings/phone-numbers', stage: 'create' });
      expect(mockPrisma.outboundCampaign.create).not.toHaveBeenCalled();
      // The create-stage gate asks for intent, not full configuration.
      expect(mockPrisma.telephonyPhoneNumber.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws-1',
          outboundEnabled: true,
          status: { notIn: ['pending_verification', 'disconnected'] },
        },
        select: { id: true },
      });
    });

    it('allows creation via an outbound-enabled BYO number', async () => {
      mockPrisma.twilioPhoneNumber.count.mockResolvedValue(0);
      mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue({ id: 'num-1' });
      mockPrisma.outboundCampaign.create.mockResolvedValue({ id: 'camp-1', status: 'draft' });

      await expect(
        service.create('ws-1', 'user-1', { agent_id: 'agent-1', purpose: 'appointment_reminder', name: 'BYO', contacts: [] }),
      ).resolves.toMatchObject({ id: 'camp-1' });
    });

    it('allows creation via a legacy managed Twilio number', async () => {
      mockPrisma.twilioPhoneNumber.count.mockResolvedValue(1);
      mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null);
      mockPrisma.outboundCampaign.create.mockResolvedValue({ id: 'camp-1', status: 'draft' });

      await expect(
        service.create('ws-1', 'user-1', { agent_id: 'agent-1', purpose: 'appointment_reminder', name: 'Legacy', contacts: [] }),
      ).resolves.toMatchObject({ id: 'camp-1' });
    });
  });

  describe('start', () => {
    const twoContacts = [
      { phone: '+15551111111', full_name: 'Alice' },
      { phone: '+15552222222', full_name: 'Bob' },
    ];

    it('queues only the first contact and leaves the chain to the worker', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        dispatchedCount: 0,
        contacts: twoContacts,
      });

      await service.start('ws-1', 'camp-1', 'user-1');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'outbound_call',
        'call',
        expect.objectContaining({
          campaignId: 'camp-1',
          agentId: 'agent-1',
          workspaceId: 'ws-1',
          actorUserId: 'user-1',
          to: '+15551111111',
          contactName: 'Alice',
          contactIndex: 0,
        }),
        expect.objectContaining({ delay: 0 }),
      );
      expect(mockPrisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1', status: 'draft' },
        data: expect.objectContaining({ status: 'running', stats: expect.any(Object) }),
      });
    });

    // F-021: restarting a paused campaign re-enqueued every contact, so everyone
    // already called got called again.
    it('resumes a paused campaign at the dispatch cursor instead of replaying the list', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'paused',
        dispatchedCount: 1,
        stats: { total: 2, completed: 0, failed: 1, in_progress: 0 },
        contacts: twoContacts,
      });

      await service.start('ws-1', 'camp-1', 'user-1');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'outbound_call',
        'call',
        expect.objectContaining({ to: '+15552222222', contactIndex: 1 }),
        expect.any(Object),
      );
      // Counters recorded before the pause survive the resume.
      expect(mockPrisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1', status: 'paused' },
        data: { status: 'running', stats: { total: 2, completed: 0, failed: 1, in_progress: 0 } },
      });
    });

    it('completes a campaign whose contacts were all dispatched without dialling again', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'paused',
        dispatchedCount: 2,
        contacts: twoContacts,
      });

      await service.start('ws-1', 'camp-1', 'user-1');

      expect(mockQueue.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1', status: 'paused' },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('rejects a second concurrent start rather than launching a second chain', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        dispatchedCount: 0,
        contacts: twoContacts,
      });
      mockPrisma.outboundCampaign.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.start('ws-1', 'camp-1', 'user-1')).rejects.toMatchObject({
        errorCode: 'INVALID_STATUS',
      });
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    // F-022: the worker throws on a "not now" admission denial to request a
    // retry, which BullMQ drops unless the job was enqueued with `attempts`.
    it('enqueues dispatch jobs with a retry budget and a deduplicating job id', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        dispatchedCount: 0,
        contacts: twoContacts,
      });

      await service.start('ws-1', 'camp-1', 'user-1');

      const options = mockQueue.enqueue.mock.calls[0]![3];
      expect(options).toMatchObject({
        attempts: 5,
        backoff: { type: 'exponential', delay: 15_000 },
      });
      expect(options.jobId).toMatch(/^camp-1:0:\d+$/);
    });

    it('refuses start when the agent has no configured outbound assignment', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        dispatchedCount: 0,
        contacts: twoContacts,
      });
      // Workspace has a create-grade number, but nothing matches the start-shaped
      // (worker dial) predicate for this agent.
      mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null);

      const err = await service.start('ws-1', 'camp-1', 'user-1').catch((e) => e);
      expect(err.errorCode).toBe('PHONE_NUMBER_REQUIRED');
      expect(err.getStatus()).toBe(409);
      expect(err.details).toEqual({ redirect: '/dashboard/settings/phone-numbers', stage: 'start' });
      expect(mockPrisma.outboundCampaign.updateMany).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.telephonyPhoneNumber.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws-1',
          assignedAgentId: 'agent-1',
          outboundEnabled: true,
          status: { not: 'disconnected' },
          livekitConfig: { is: { outboundTrunkId: { not: null } } },
        },
        select: { id: true },
      });
    });

    it('allows start when the worker dial predicate matches', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        dispatchedCount: 0,
        contacts: twoContacts,
      });
      mockPrisma.twilioPhoneNumber.count.mockResolvedValue(0);
      mockPrisma.telephonyPhoneNumber.findFirst.mockResolvedValue({ id: 'num-1' });

      await service.start('ws-1', 'camp-1', 'user-1');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('scopes campaign start by workspace', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue(null);

      await expect(service.start('ws-1', 'camp-1', 'user-1')).rejects.toMatchObject({
        errorCode: 'NOT_FOUND',
      });

      expect(mockPrisma.outboundCampaign.findFirst).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1' },
      });
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('sets status to paused within the workspace', async () => {
      mockPrisma.outboundCampaign.updateMany.mockResolvedValue({ count: 1 });

      await service.pause('ws-1', 'camp-1', 'user-1');
      expect(mockPrisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1' },
        data: { status: 'paused' },
      });
      expect(mockAudit.log).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        action: 'campaign.pause',
        resourceType: 'outbound_campaign',
        resourceId: 'camp-1',
      });
    });
  });

  describe('getStats', () => {
    it('returns stats only for a campaign in the workspace', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        stats: { total: 2, completed: 0, failed: 0, in_progress: 2 },
      });

      const result = await service.getStats('ws-1', 'camp-1');

      expect(result).toEqual({ total: 2, completed: 0, failed: 0, in_progress: 2 });
      expect(mockPrisma.outboundCampaign.findFirst).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1' },
      });
    });
  });

  describe('incrementStat', () => {
    it('increments in_progress instead of cancelling it back to zero', async () => {
      mockPrisma.outboundCampaign.findUnique.mockResolvedValue({
        id: 'camp-1',
        stats: { total: 1, completed: 0, failed: 0, in_progress: 0 },
      });

      await service.incrementStat('camp-1', 'in_progress');

      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: {
          stats: { total: 1, completed: 0, failed: 0, in_progress: 1 },
        },
      });
    });
  });
});
