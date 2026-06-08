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
          contact_count: 1,
        },
      });
    });

    it('applies custom schedule', async () => {
      const dto = {
        agent_id: 'agent-1',
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
        name: 'Invalid Campaign',
        contacts: [{ phone: '+15551234567' }],
      };

      await expect(service.create('ws-1', 'user-1', dto)).rejects.toMatchObject({
        errorCode: 'AGENT_NOT_FOUND',
      });
      expect(mockPrisma.outboundCampaign.create).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('queues outbound calls for each contact', async () => {
      mockPrisma.outboundCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        contacts: [
          { phone: '+15551111111', full_name: 'Alice' },
          { phone: '+15552222222', full_name: 'Bob' },
        ],
      });

      await service.start('ws-1', 'camp-1', 'user-1');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(mockQueue.enqueue).toHaveBeenNthCalledWith(1, 'outbound_call', 'call', {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        to: '+15551111111',
        contactName: 'Alice',
        customData: undefined,
      });
      expect(mockQueue.enqueue).toHaveBeenNthCalledWith(2, 'outbound_call', 'call', {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        to: '+15552222222',
        contactName: 'Bob',
        customData: undefined,
      });
      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: expect.objectContaining({ status: 'running', stats: expect.any(Object) }),
      });
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
