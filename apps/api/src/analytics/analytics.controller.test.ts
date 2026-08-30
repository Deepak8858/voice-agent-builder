import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { BillingModule } from '../billing/billing.module';
import { ForbiddenPlanError } from '../billing/billing.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsModule } from './analytics.module';

/**
 * `checkFeatureGate` has always answered `analytics` and `ai_insights` with
 * `plan !== 'free' && paidAccess`, but until now nothing asked it, so every Free
 * workspace read the whole reporting surface. These tests pin the six routes
 * that must ask and the one that must not.
 */
function makeController(allowed: boolean) {
  const checkFeatureGate = vi.fn(async () => allowed);
  const analytics = {
    recordEvent: vi.fn(async () => ({ id: 'evt-1' })),
    listEvents: vi.fn(async () => []),
    workspaceMetrics: vi.fn(async () => ({ ok: 'workspace' })),
    agentMetrics: vi.fn(async () => ({ ok: 'agents' })),
    complianceMetrics: vi.fn(async () => ({ ok: 'compliance' })),
    timeseriesMetrics: vi.fn(async () => ({ ok: 'timeseries' })),
    improvementSuggestions: vi.fn(async () => ({ ok: 'suggestions' })),
  };
  const prisma = {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ organizationId: 'org-1' })),
    },
  };
  const controller = new AnalyticsController(
    analytics as never,
    prisma as never,
    { checkFeatureGate } as never,
  );
  return { controller, analytics, prisma, checkFeatureGate };
}

const REPORTING_ROUTES: Array<[string, (c: AnalyticsController) => Promise<unknown>, string]> = [
  ['events', (c) => c.events('ws-1', {}), 'analytics'],
  ['workspace', (c) => c.workspace('ws-1', {}), 'analytics'],
  ['agents', (c) => c.agents('ws-1', {}), 'analytics'],
  ['compliance', (c) => c.compliance('ws-1', {}), 'analytics'],
  ['timeseries', (c) => c.timeseries('ws-1', {}), 'analytics'],
  ['suggestions', (c) => c.suggestions('ws-1', 'agent-1', {}), 'ai_insights'],
];

describe('AnalyticsController plan gate', () => {
  // DI wiring is invisible to the type checker: dropping this import compiles
  // fine and fails at boot instead, which is the worst place to find out.
  it('imports BillingModule so the gate resolves', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AnalyticsModule) ?? []).toContain(
      BillingModule,
    );
  });

  it.each(REPORTING_ROUTES)('refuses %s on a plan without the gate', async (_name, callRoute) => {
    const { controller } = makeController(false);
    await expect(callRoute(controller)).rejects.toBeInstanceOf(ForbiddenPlanError);
  });

  it.each(REPORTING_ROUTES)(
    'names the %s gate as the limitType so the upgrade prompt reads correctly',
    async (_name, callRoute, gate) => {
      const { controller } = makeController(false);
      const err = await callRoute(controller).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenPlanError);
      expect((err as ForbiddenPlanError).details).toMatchObject({
        limitType: gate,
        upgradePath: '/dashboard/billing',
      });
    },
  );

  it.each(REPORTING_ROUTES)('asks the gate before serving %s', async (_name, callRoute, gate) => {
    const { controller, checkFeatureGate } = makeController(true);
    await callRoute(controller);
    expect(checkFeatureGate).toHaveBeenCalledWith('org-1', gate);
  });

  // The gate resolves the organization from the workspace row, never from the
  // caller-supplied path segment, so a Free workspace cannot borrow a paying
  // organization's entitlement by guessing an id.
  it('resolves the organization from the workspace being read', async () => {
    const { controller, prisma } = makeController(true);
    await controller.workspace('ws-1', {});
    expect(prisma.workspace.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { organizationId: true },
    });
  });

  // Instrumentation, not a paid feature: a Free workspace that stopped
  // recording would have nothing to show the day it upgrades.
  it('leaves event ingestion ungated', async () => {
    const { controller, analytics, checkFeatureGate } = makeController(false);
    await controller.record('ws-1', { event_type: 'call_started' } as never);
    expect(analytics.recordEvent).toHaveBeenCalled();
    expect(checkFeatureGate).not.toHaveBeenCalled();
  });
});
