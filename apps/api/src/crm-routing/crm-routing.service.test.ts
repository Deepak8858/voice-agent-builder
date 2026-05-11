import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrmRoutingService } from './crm-routing.service';

const mockPrisma = {
  crmRoutingRule: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
};

describe('CrmRoutingService', () => {
  let service: CrmRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CrmRoutingService(mockPrisma as any);
  });

  describe('getRulesForAgent', () => {
    it('returns custom rules for workspace', async () => {
      mockPrisma.crmRoutingRule.findMany.mockResolvedValue([
        {
          id: 'rule-1',
          keyword: 'dental',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ]);

      const rules = await service.getRulesForAgent('ws-1', 'agent-1');
      expect(rules).toHaveLength(1);
      expect(rules[0].keyword).toBe('dental');
      expect(rules[0].provider).toBe('pipedrive');
    });

    it('returns empty when no rules exist', async () => {
      mockPrisma.crmRoutingRule.findMany.mockResolvedValue([]);
      const rules = await service.getRulesForAgent('ws-1', 'agent-1');
      expect(rules).toHaveLength(0);
    });
  });

  describe('findMatchingRules', () => {
    it('matches keyword in transcript', async () => {
      mockPrisma.crmRoutingRule.findMany.mockResolvedValue([
        {
          id: 'rule-1',
          keyword: 'appointment',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ]);

      const rules = await service.findMatchingRules('ws-1', 'agent-1', 'I need to book an appointment');
      expect(rules).toHaveLength(1);
      expect(rules[0].keyword).toBe('appointment');
    });

    it('returns empty when no keywords match', async () => {
      mockPrisma.crmRoutingRule.findMany.mockResolvedValue([
        {
          id: 'rule-1',
          keyword: 'dental',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ]);

      const rules = await service.findMatchingRules('ws-1', 'agent-1', 'I need a plumber');
      expect(rules).toHaveLength(0);
    });

    it('matches default rules when custom rule keyword maps to default', async () => {
      mockPrisma.crmRoutingRule.findMany.mockResolvedValue([
        {
          id: 'rule-1',
          keyword: 'dental',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ]);

      const rules = await service.findMatchingRules('ws-1', 'agent-1', 'This is about dental care');
      expect(rules).toHaveLength(1);
      expect(rules[0].keyword).toBe('dental');
    });
  });

  describe('createRule', () => {
    it('creates rule in DB and returns shaped result', async () => {
      mockPrisma.crmRoutingRule.create.mockResolvedValue({
        id: 'new-rule',
        keyword: 'sales',
        provider: 'hubspot',
        action: 'primary',
        priority: 100,
        active: true,
      });

      const rule = await service.createRule('ws-1', {
        keyword: 'sales',
        provider: 'hubspot',
        action: 'primary',
        agent_id: 'agent-1',
      });

      expect(rule.id).toBe('new-rule');
      expect(rule.keyword).toBe('sales');
      expect(rule.action).toBe('primary');
      expect(mockPrisma.crmRoutingRule.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          keyword: 'sales',
          provider: 'hubspot',
          action: 'primary',
          priority: 100,
          active: true,
        },
      });
    });

    it('creates workspace-level rule when agent_id not provided', async () => {
      mockPrisma.crmRoutingRule.create.mockResolvedValue({
        id: 'ws-rule',
        keyword: 'billing',
        provider: 'salesforce',
        action: 'secondary',
        priority: 100,
        active: true,
      });

      await service.createRule('ws-1', {
        keyword: 'billing',
        provider: 'salesforce',
        action: 'secondary',
      });

      expect(mockPrisma.crmRoutingRule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: null,
          keyword: 'billing',
        }),
      });
    });
  });
});