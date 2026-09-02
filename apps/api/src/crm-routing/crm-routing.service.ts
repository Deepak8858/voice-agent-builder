import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCrmRoutingRuleDtoSchema, type CreateCrmRoutingRuleDto } from './crm-routing.schemas';

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

  constructor(
    private readonly prisma: PrismaService,
    // Required, not @Optional(): an optional dependency plus `this.audit?.log`
    // is a silent-skip path, and a routing rule committing with no audit row is
    // the exact defect this dependency exists to close. AuditModule is @Global,
    // so DI always supplies it; the two security tests that construct this
    // service by hand pass a stub.
    private readonly audit: AuditService,
  ) {}

  async getRulesForAgent(workspaceId: string, agentId?: string): Promise<RoutingRule[]> {
    const custom = await this.prisma.crmRoutingRule.findMany({
      where: {
        workspaceId,
        // With an agent, its own rules plus the workspace-wide ones (agentId
        // null). Without one, no agent filter at all — every rule in the
        // workspace. An empty or missing id must never reach the `uuid` column.
        ...(agentId ? { OR: [{ agentId }, { agentId: null }] } : {}),
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

  // The DTO type comes from the request schema rather than being restated here.
  // Restating it broke `tsc -p tsconfig.build.json`, which sets `strict: false`:
  // with strictNullChecks off `undefined extends string` holds, so zod's
  // `z.infer` reports every property as optional and an all-optional argument
  // will not satisfy a hand-written required one. Sharing the type makes both
  // sides degrade identically instead of disagreeing.
  //
  // The controller's ZodValidationPipe is not the only entry: orchestrator.worker
  // calls this directly, so the same schema is applied here, at the service
  // boundary, where both paths meet. With `strict: false` the compiler cannot
  // catch a half-built object either.
  async createRule(
    workspaceId: string,
    input: CreateCrmRoutingRuleDto,
    actorUserId?: string | null,
  ): Promise<RoutingRule> {
    const dto = CreateCrmRoutingRuleDtoSchema.parse(input);
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
    // Routing rules decide which CRM a caller's contact data is shipped to, so
    // the change belongs in the tenant's audit trail like every sibling write.
    await this.audit.log({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: 'crm_routing_rule.create',
      resourceType: 'crm_routing_rule',
      resourceId: created.id,
      metadata: {
        keyword: dto.keyword,
        provider: dto.provider,
        rule_action: dto.action,
        agent_id: dto.agent_id ?? null,
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
