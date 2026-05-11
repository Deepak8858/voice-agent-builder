import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundCampaignService } from './outbound-campaign.service';

const mockPrisma = {
  outboundCampaign: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

const mockQueue = {
  enqueue: vi.fn(),
};

describe('OutboundCampaignService', () => {
  let service: OutboundCampaignService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OutboundCampaignService(mockPrisma as any, mockQueue as any);
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

      const result = await service.create('ws-1', dto);
      expect(result.status).toBe('draft');
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
    });

    it('applies custom schedule', async () => {
      const dto = {
        agent_id: 'agent-1',
        name: 'Fast Campaign',
        contacts: [],
        schedule: { max_calls_per_hour: 50, max_concurrent: 10 },
      };
      mockPrisma.outboundCampaign.create.mockResolvedValue({ id: 'camp-1' });

      await service.create('ws-1', dto);
      expect(mockPrisma.outboundCampaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schedule: { max_calls_per_hour: 50, max_concurrent: 10 },
        }),
      });
    });
  });

  describe('start', () => {
    it('queues outbound calls for each contact', async () => {
      mockPrisma.outboundCampaign.findUnique.mockResolvedValue({
        id: 'camp-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'draft',
        contacts: [
          { phone: '+15551111111', full_name: 'Alice' },
          { phone: '+15552222222', full_name: 'Bob' },
        ],
      });

      await service.start('camp-1');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(mockQueue.enqueue).toHaveBeenNthCalledWith(1, 'outbound.call', 'call', {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        to: '+15551111111',
        contactName: 'Alice',
      });
      expect(mockQueue.enqueue).toHaveBeenNthCalledWith(2, 'outbound.call', 'call', {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        to: '+15552222222',
        contactName: 'Bob',
      });
      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: expect.objectContaining({ status: 'running', stats: expect.any(Object) }),
      });
    });
  });

  describe('pause', () => {
    it('sets status to paused', async () => {
      await service.pause('camp-1');
      expect(mockPrisma.outboundCampaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: { status: 'paused' },
      });
    });
  });
});