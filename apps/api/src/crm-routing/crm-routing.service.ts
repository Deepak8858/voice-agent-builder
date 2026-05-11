import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RoutingRule {
  id: string;
  keyword: string;
  provider: 'pipedrive' | 'hubspot' | 'salesforce' | 'generic_webhook';
  action: 'primary' | 'secondary';
  priority: number;
  active: boolean;
}

export interface FanOutResult {
  primary: { provider: string; contact_id: string; status: string } | null;
  secondary: Array<{ provider: string; contact_id: string; status: string; error?: string }>;
  errors: string[];
}

const DEFAULT_RULES: Record<string, RoutingRule> = {
  dental: { id: 'default', keyword: 'dental', provider: 'pipedrive', action: 'primary', priority: 1, active: true },
  healthcare: { id: 'default', keyword: 'healthcare', provider: 'salesforce', action: 'primary', priority: 1, active: true },
  medical: { id: 'default', keyword: 'medical', provider: 'salesforce', action: 'primary', priority: 1, active: true },
  enterprise: { id: 'default', keyword: 'enterprise', provider: 'salesforce', action: 'primary', priority: 1, active: true },
  b2b: { id: 'default', keyword: 'b2b', provider: 'salesforce', action: 'primary', priority: 1, active: true },
  saas: { id: 'default', keyword: 'saas', provider: 'salesforce', action: 'primary', priority: 1, active: true },
  hvac: { id: 'default', keyword: 'hvac', provider: 'pipedrive', action: 'primary', priority: 1, active: true },
  plumbing: { id: 'default', keyword: 'plumbing', provider: 'pipedrive', action: 'primary', priority: 1, active: true },
  salon: { id: 'default', keyword: 'salon', provider: 'pipedrive', action: 'primary', priority: 1, active: true },
  'real estate': { id: 'default', keyword: 'real estate', provider: 'hubspot', action: 'primary', priority: 1, active: true },
};

@Injectable()
export class CrmRoutingService {
  private readonly logger = new Logger(CrmRoutingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getRulesForAgent(workspaceId: string, agentId: string): Promise<RoutingRule[]> {
    const custom = await this.prisma.crmRoutingRule.findMany({
      where: {
        workspaceId,
        OR: [{ agentId }, { agentId: null }],
        active: true,
      },
      orderBy: { priority: 'asc' },
    });
    return custom.map(r => ({
      id: r.id,
      keyword: r.keyword,
      provider: r.provider as RoutingRule['provider'],
      action: r.action as RoutingRule['action'],
      priority: r.priority,
      active: r.active,
    }));
  }

  async findMatchingRules(
    workspaceId: string,
    agentId: string,
    transcript: string,
  ): Promise<RoutingRule[]> {
    const allRules = await this.getRulesForAgent(workspaceId, agentId);
    const lower = transcript.toLowerCase();

    return allRules.filter(r => {
      if (lower.includes(r.keyword.toLowerCase())) return true;
      const def = DEFAULT_RULES[r.keyword.toLowerCase()];
      return def && lower.includes(def.keyword);
    }).sort((a, b) => a.priority - b.priority);
  }

  async createRule(
    workspaceId: string,
    dto: {
      keyword: string;
      provider: string;
      action: 'primary' | 'secondary';
      agent_id?: string;
    },
  ): Promise<RoutingRule> {
    const created = await this.prisma.crmRoutingRule.create({
      data: {
        workspaceId,
        agentId: dto.agent_id ?? null,
        keyword: dto.keyword,
        provider: dto.provider,
        action: dto.action,
        priority: 100,
        active: true,
      },
    });
    return {
      id: created.id,
      keyword: created.keyword,
      provider: created.provider as RoutingRule['provider'],
      action: created.action as RoutingRule['action'],
      priority: created.priority,
      active: created.active,
    };
  }
}
