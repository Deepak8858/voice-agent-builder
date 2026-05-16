# 8.1 Admin Cost Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internal ops dashboard + customer-facing billing page. Tracks usage/costs per org and agent, shows trends, sends overage alerts at 80%/100% thresholds.

**Architecture:** Hybrid data layer — materialized view for historical months (hourly refresh), live query for current month. Shared UsageService for both admin and customer endpoints.

**Tech Stack:** NestJS (API), Next.js (UI), Supabase (DB), pg_cron (refresh)

---

## File Map

```
Created:
- apps/api/src/usage/usage.module.ts
- apps/api/src/usage/usage.service.ts
- apps/api/src/usage/usage.controller.ts        (customer-facing /v1/orgs/:id/usage)
- apps/api/src/admin/admin.module.ts
- apps/api/src/admin/admin.controller.ts        (internal /admin/orgs/:id/usage)
- apps/api/src/admin/admin.service.ts
- apps/api/src/billing/alerts.service.ts
- apps/web/app/admin/dashboard/page.tsx
- apps/web/app/admin/orgs/[orgId]/billing/page.tsx
- apps/web/app/dashboard/billing/billing-usage-widget.tsx  (new usage section)

Modified:
- apps/api/src/app.module.ts                  (add UsageModule, AdminModule, AlertsService)
- apps/api/prisma/schema.prisma               (add PlanPricing model)
- apps/web/components/billing-panel.tsx       (integrate new usage widget)
```

---

## Task 1: Add PlanPricing + Alert models to schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add PlanPricing model to schema.prisma after UsageRecord (line 708)**

```prisma
model PlanPricing {
  id           String   @id @default(uuid()) @db.Uuid
  plan         String   // free | starter | growth | enterprise
  metric       String   // calls | minutes | tools | agents
  pricePerUnit Decimal  @default(0) @map("price_per_unit") @db.Decimal(10, 4)
  monthlyLimit Int      @map("monthly_limit") // -1 = unlimited
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@unique([plan, metric])
  @@map("plan_pricing")
}

model Alert {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  type           String    // warning | at_limit
  percentage     Int
  sentAt         DateTime  @default(now()) @map("sent_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, type, sentAt])
  @@map("alerts")
}
```

- [ ] **Step 2: Generate migration**

Run: `cd apps/api && npx prisma migrate dev --name add_plan_pricing_and_alerts`
Expected: migration created

- [ ] **Step 3: Seed plan_pricing via Supabase MCP execute_sql**

```sql
INSERT INTO plan_pricing (id, plan, metric, price_per_unit, monthly_limit) VALUES
  (gen_random_uuid(), 'free', 'calls', 0, 0),
  (gen_random_uuid(), 'free', 'minutes', 0, 0),
  (gen_random_uuid(), 'starter', 'calls', 0.02, 500),
  (gen_random_uuid(), 'starter', 'minutes', 0.05, 500),
  (gen_random_uuid(), 'growth', 'calls', 0.015, -1),
  (gen_random_uuid(), 'growth', 'minutes', 0.04, 2000),
  (gen_random_uuid(), 'enterprise', 'calls', 0.01, -1),
  (gen_random_uuid(), 'enterprise', 'minutes', 0.03, -1)
ON CONFLICT (plan, metric) DO NOTHING;
```

---

## Task 2: Create Materialized View

**Files:**
- Apply via Supabase MCP `execute_sql`

- [ ] **Step 1: Apply migration**

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_org_cost_summary AS
SELECT 
  o.id as org_id,
  o.name as org_name,
  o.plan,
  date_trunc('month', ur.recorded_at) as period,
  SUM(ur.quantity * COALESCE(pp.price_per_unit, 0)) as estimated_cost,
  COUNT(DISTINCT ur.workspace_id) as active_workspaces,
  SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END) as total_calls,
  SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END) as total_minutes
FROM organizations o
LEFT JOIN usage_records ur ON ur.organization_id = o.id
LEFT JOIN plan_pricing pp ON pp.plan = o.plan AND pp.metric = ur.billable_metric
WHERE date_trunc('month', ur.recorded_at) < date_trunc('month', NOW())
GROUP BY o.id, o.name, o.plan, date_trunc('month', ur.recorded_at);

CREATE UNIQUE INDEX IF NOT EXISTS mv_org_cost_summary_org_period ON mv_org_cost_summary(org_id, period);

CREATE OR REPLACE FUNCTION refresh_mv_org_cost_summary()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_org_cost_summary;
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule('refresh-org-cost-summary', '0 * * * *', $$SELECT refresh_mv_org_cost_summary()$$);
```

---

## Task 3: UsageService + UsageController

**Files:**
- Create: `apps/api/src/usage/usage.module.ts`
- Create: `apps/api/src/usage/usage.service.ts`
- Create: `apps/api/src/usage/usage.controller.ts`
- Create: `apps/api/src/usage/usage.service.test.ts`

- [ ] **Step 1: Write failing test** — `apps/api/src/usage/usage.service.test.ts`

```ts
import { Test } from '@nestjs/testing';
import { UsageService } from './usage.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsageService', () => {
  let service: UsageService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [UsageService, PrismaService],
    }).compile();
    service = module.get(UsageService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getCurrentMonthUsage', () => {
    it('should aggregate calls and minutes for current month', async () => {
      const result = await service.getCurrentMonthUsage('test-org-id');
      expect(result).toHaveProperty('org_id');
      expect(result).toHaveProperty('period');
      expect(result).toHaveProperty('total_calls');
      expect(result).toHaveProperty('total_minutes');
      expect(result).toHaveProperty('estimated_cost');
    });
  });

  describe('getHistoricalUsage', () => {
    it('should return data from materialized view', async () => {
      const result = await service.getHistoricalUsage('test-org-id', '2026-01', '2026-04');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getAgentUsageBreakdown', () => {
    it('should return per-agent usage', async () => {
      const result = await service.getAgentUsageBreakdown('test-org-id', '2026-05');
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/usage/usage.service.test.ts --no-coverage 2>&1 | head -30`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: Write UsageService** — `apps/api/src/usage/usage.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentMonthUsage(orgId: string) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const records = await this.prisma.usageRecord.groupBy({
      by: ['billableMetric'],
      where: { organizationId: orgId, periodStart: { gte: startOfMonth } },
      _sum: { quantity: true },
    });

    const calls = records.find(r => r.billableMetric === 'calls')?._sum.quantity ?? 0;
    const minutes = records.find(r => r.billableMetric === 'minutes')?._sum.quantity ?? 0;

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true },
    });
    const pricing = await this.prisma.planPricing.findMany({
      where: { plan: org?.plan ?? 'free' },
    });
    const callPrice = pricing.find(p => p.metric === 'calls')?.pricePerUnit ?? 0;
    const minutePrice = pricing.find(p => p.metric === 'minutes')?.pricePerUnit ?? 0;
    const estimatedCost = Number(callPrice) * calls + Number(minutePrice) * minutes;

    return {
      org_id: orgId,
      period: startOfMonth.toISOString().slice(0, 7),
      total_calls: calls,
      total_minutes: minutes,
      estimated_cost: Math.round(estimatedCost * 100) / 100,
    };
  }

  async getHistoricalUsage(orgId: string, from: string, to: string) {
    const result = await this.prisma.$queryRaw<Array<{
      period: Date;
      total_calls: bigint;
      total_minutes: bigint;
      estimated_cost: Prisma.Decimal;
      active_workspaces: bigint;
    }>>`
      SELECT period,
        SUM(total_calls)::int as total_calls,
        SUM(total_minutes)::int as total_minutes,
        SUM(estimated_cost) as estimated_cost,
        MAX(active_workspaces) as active_workspaces
      FROM mv_org_cost_summary
      WHERE org_id = ${orgId} AND period >= ${from} AND period <= ${to}
      GROUP BY period ORDER BY period
    `;

    return result.map(r => ({
      period: r.period.toISOString().slice(0, 7),
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
      estimated_cost: Number(r.estimated_cost),
      active_workspaces: Number(r.active_workspaces),
    }));
  }

  async getAgentUsageBreakdown(orgId: string, period: string) {
    const [year, month] = period.split('-').map(Number);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const agents = await this.prisma.agent.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    });

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true },
    });
    const pricing = await this.prisma.planPricing.findMany({
      where: { plan: org?.plan ?? 'free' },
    });
    const callPrice = pricing.find(p => p.metric === 'calls')?.pricePerUnit ?? 0;
    const minutePrice = pricing.find(p => p.metric === 'minutes')?.pricePerUnit ?? 0;

    const result = [];
    for (const agent of agents) {
      const calls = await this.prisma.call.aggregate({
        where: { agentId: agent.id, createdAt: { gte: start, lte: end } },
        _count: { _all: true },
        _sum: { durationSeconds: true },
      });
      const callCount = calls._count._all;
      const totalMinutes = Math.round((Number(calls._sum.durationSeconds ?? 0) / 60) * 100) / 100;
      const cost = Number(callPrice) * callCount + Number(minutePrice) * totalMinutes;
      result.push({
        agent_id: agent.id,
        agent_name: agent.name,
        total_calls: callCount,
        total_minutes: totalMinutes,
        estimated_cost: Math.round(cost * 100) / 100,
      });
    }
    return result;
  }
}
```

- [ ] **Step 4: Create usage.module.ts**

```ts
import { Module } from '@nestjs/common';
import { UsageService } from './usage.service';
import { UsageController } from './usage.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
```

- [ ] **Step 5: Create usage.controller.ts**

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { UsageService } from './usage.service';

@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('v1/orgs/:id/usage')
  async getUsage(@Param('id') orgId: string) {
    return this.usage.getCurrentMonthUsage(orgId);
  }

  @Get('v1/orgs/:id/usage/trends')
  async getTrends(
    @Param('id') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 7);
    const defaultTo = now.toISOString().slice(0, 7);
    const trends = await this.usage.getHistoricalUsage(orgId, from ?? defaultFrom, to ?? defaultTo);
    const sorted = [...trends].sort((a, b) => a.period.localeCompare(b.period));
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    return {
      months: sorted,
      mom_delta: prev ? {
        calls_pct: prev.total_calls > 0 ? (last.total_calls - prev.total_calls) / prev.total_calls : 0,
        minutes_pct: prev.total_minutes > 0 ? (last.total_minutes - prev.total_minutes) / prev.total_minutes : 0,
      } : null,
    };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && npx jest src/usage/usage.service.test.ts --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd apps/api && git add src/usage/ prisma/schema.prisma && git commit -m "feat(billing): add UsageService + PlanPricing model for cost dashboard"
```

---

## Task 4: AdminService + AdminController

**Files:**
- Create: `apps/api/src/admin/admin.module.ts`
- Create: `apps/api/src/admin/admin.service.ts`
- Create: `apps/api/src/admin/admin.controller.ts`
- Create: `apps/api/src/admin/admin.service.test.ts`

- [ ] **Step 1: Write failing test** — `apps/api/src/admin/admin.service.test.ts`

```ts
import { Test } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { UsageService } from '../usage/usage.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminService', () => {
  let service: AdminService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AdminService,
        PrismaService,
        { provide: UsageService, useValue: { getAgentUsageBreakdown: jest.fn() } },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  it('should be defined', () => expect(service).toBeDefined());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/admin/admin.service.test.ts --no-coverage 2>&1 | head -20`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: Write AdminService** — `apps/api/src/admin/admin.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
  ) {}

  async getOrgUsageOverview() {
    const result = await this.prisma.$queryRaw<Array<{
      org_id: string;
      org_name: string;
      plan: string;
      estimated_cost: Prisma.Decimal;
      total_calls: bigint;
      total_minutes: bigint;
    }>>`
      SELECT 
        o.id as org_id, o.name as org_name, o.plan,
        COALESCE(SUM(ur.quantity * COALESCE(pp.price_per_unit, 0)), 0) as estimated_cost,
        COALESCE(SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END), 0) as total_calls,
        COALESCE(SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END), 0) as total_minutes
      FROM organizations o
      LEFT JOIN usage_records ur ON ur.organization_id = o.id
        AND date_trunc('month', ur.recorded_at) = date_trunc('month', NOW())
      LEFT JOIN plan_pricing pp ON pp.plan = o.plan AND pp.metric = ur.billable_metric
      GROUP BY o.id, o.name, o.plan
      ORDER BY estimated_cost DESC
    `;

    return result.map(r => ({
      org_id: r.org_id,
      org_name: r.org_name,
      plan: r.plan,
      total_spend: Number(r.estimated_cost),
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
    }));
  }

  async getOrgUsageDetail(orgId: string, period?: string) {
    const now = new Date();
    const targetPeriod = period ?? now.toISOString().slice(0, 7);
    const isCurrentMonth = targetPeriod === now.toISOString().slice(0, 7);

    if (isCurrentMonth) {
      const row = await this.prisma.$queryRaw<Array<{
        total_calls: bigint; total_minutes: bigint;
        estimated_cost: Prisma.Decimal; active_workspaces: bigint;
      }>>`
        SELECT 
          COALESCE(SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END), 0) as total_calls,
          COALESCE(SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END), 0) as total_minutes,
          COALESCE(SUM(ur.quantity * COALESCE(pp.price_per_unit, 0)), 0) as estimated_cost,
          COUNT(DISTINCT ur.workspace_id) as active_workspaces
        FROM usage_records ur
        LEFT JOIN plan_pricing pp ON pp.plan = (SELECT plan FROM organizations WHERE id = ${orgId})
          AND pp.metric = ur.billable_metric
        WHERE ur.organization_id = ${orgId}
          AND date_trunc('month', ur.recorded_at) = date_trunc('month', NOW())
      `;
      const r = row[0] ?? { total_calls: 0n, total_minutes: 0n, estimated_cost: 0, active_workspaces: 0n };
      return {
        org_id: orgId, period: targetPeriod,
        total_spend: Number(r.estimated_cost),
        total_calls: Number(r.total_calls),
        total_minutes: Number(r.total_minutes),
        active_workspaces: Number(r.active_workspaces),
      };
    }

    const hist = await this.prisma.$queryRaw<Array<{
      total_calls: bigint; total_minutes: bigint;
      estimated_cost: Prisma.Decimal; active_workspaces: bigint;
    }>>`
      SELECT total_calls, total_minutes, estimated_cost, active_workspaces
      FROM mv_org_cost_summary
      WHERE org_id = ${orgId} AND period >= ${targetPeriod}::date AND period < (${targetPeriod}::date + interval '1 month')
    `;
    const r = hist[0];
    if (!r) return { org_id: orgId, period: targetPeriod, total_spend: 0, total_calls: 0, total_minutes: 0, active_workspaces: 0 };
    return {
      org_id: orgId, period: targetPeriod,
      total_spend: Number(r.estimated_cost),
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
      active_workspaces: Number(r.active_workspaces),
    };
  }

  async getOrgAgentUsage(orgId: string, period: string) {
    return this.usage.getAgentUsageBreakdown(orgId, period);
  }
}
```

- [ ] **Step 4: Create admin.module.ts**

```ts
import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { UsageModule } from '../usage/usage.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, UsageModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
```

- [ ] **Step 5: Create admin.controller.ts**

```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';

@Controller('admin')
@UseGuards(InternalAuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('usage/overview')
  async getOverview() { return this.admin.getOrgUsageOverview(); }

  @Get('orgs/:id/usage')
  async getOrgUsage(@Param('id') orgId: string, @Query('period') period?: string) {
    return this.admin.getOrgUsageDetail(orgId, period);
  }

  @Get('orgs/:id/agents/usage')
  async getOrgAgentUsage(@Param('id') orgId: string, @Query('period') period?: string) {
    return this.admin.getOrgAgentUsage(orgId, period ?? new Date().toISOString().slice(0, 7));
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/admin/ --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/admin/ && git commit -m "feat(admin): add AdminService + AdminController for internal ops"
```

---

## Task 5: AlertsService

**Files:**
- Create: `apps/api/src/billing/alerts.service.ts`
- Create: `apps/api/src/billing/alerts.service.test.ts`

- [ ] **Step 1: Write failing test** — `apps/api/src/billing/alerts.service.test.ts`

```ts
import { Test } from '@nestjs/testing';
import { AlertsService } from './alerts.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AlertsService', () => {
  let service: AlertsService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [AlertsService, PrismaService],
    }).compile();
    service = module.get(AlertsService);
  });

  it('should be defined', () => expect(service).toBeDefined());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/billing/alerts.service.test.ts --no-coverage 2>&1 | head -20`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: Write AlertsService** — `apps/api/src/billing/alerts.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { PLAN_LIMITS } from '@voiceforge/shared';

interface OverageCheckResult {
  atLimit: boolean;
  warningThreshold: boolean;
  percentage: number;
  calls: { used: number; limit: number };
  minutes: { used: number; limit: number };
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async checkOverageAlert(orgId: string): Promise<OverageCheckResult> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    const plan = (sub?.plan ?? 'free') as keyof typeof PLAN_LIMITS;
    const limits = PLAN_LIMITS[plan];

    const records = await this.prisma.usageRecord.groupBy({
      by: ['billableMetric'],
      where: { organizationId: orgId, periodStart: { gte: startOfMonth } },
      _sum: { quantity: true },
    });

    const usedCalls = records.find(r => r.billableMetric === 'calls')?._sum.quantity ?? 0;
    const usedMinutes = records.find(r => r.billableMetric === 'minutes')?._sum.quantity ?? 0;
    const limitCalls = limits.outboundCalls === -1 ? Infinity : limits.outboundCalls;
    const limitMinutes = limits.minutes === -1 ? Infinity : limits.minutes;

    const callsPct = limitCalls === Infinity ? 0 : usedCalls / limitCalls;
    const minutesPct = limitMinutes === Infinity ? 0 : usedMinutes / limitMinutes;
    const maxPct = Math.max(callsPct, minutesPct);

    return {
      atLimit: maxPct >= 1,
      warningThreshold: maxPct >= 0.8 && maxPct < 1,
      percentage: Math.round(maxPct * 100),
      calls: { used: usedCalls, limit: limitCalls === Infinity ? -1 : limitCalls },
      minutes: { used: usedMinutes, limit: limitMinutes === Infinity ? -1 : limitMinutes },
    };
  }

  async sendOverageAlerts(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'active' },
      include: { owner: { select: { email: true } } },
    });

    for (const org of orgs) {
      const check = await this.checkOverageAlert(org.id);
      if (!check.atLimit && !check.warningThreshold) continue;

      const type = check.atLimit ? 'at_limit' : 'warning';
      const existing = await this.prisma.alert.findFirst({
        where: {
          organizationId: org.id, type,
          sentAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      });
      if (existing) continue;

      if (org.owner?.email) {
        await this.email.sendOverageAlert({
          to: org.owner.email,
          orgName: org.name,
          type,
          percentage: check.percentage,
          calls: check.calls,
          minutes: check.minutes,
        }).catch(err => this.logger.error('Failed to send alert email', err));
      }

      await this.prisma.alert.create({
        data: { organizationId: org.id, type, percentage: check.percentage },
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/billing/alerts.service.test.ts --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Wire into BillingModule**

Modify `apps/api/src/billing/billing.module.ts` — add AlertsService to providers and exports.

- [ ] **Step 6: Commit**

```bash
git add src/billing/alerts.service.ts src/billing/billing.module.ts && git commit -m "feat(billing): add AlertsService for overage notifications"
```

---

## Task 6: Wire modules into AppModule

**Files:**
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Add imports**

Add to imports array after BillingModule:
```ts
UsageModule,
AdminModule,
```

- [ ] **Step 2: Verify compilation**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/app.module.ts && git commit -m "chore: wire UsageModule + AdminModule into AppModule"
```

---

## Task 7: UI — Billing Usage Widget

**Files:**
- Create: `apps/web/app/dashboard/billing/billing-usage-widget.tsx`
- Modify: `apps/web/app/dashboard/billing/page.tsx`

- [ ] **Step 1: Write BillingUsageWidget** — `apps/web/app/dashboard/billing/billing-usage-widget.tsx`

```tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/use-api';
import { TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UsageData {
  org_id: string;
  period: string;
  total_calls: number;
  total_minutes: number;
  estimated_cost: number;
}

interface TrendsData {
  months: Array<{ period: string; total_calls: number; total_minutes: number }>;
  mom_delta: { calls_pct: number; minutes_pct: number } | null;
}

interface Limits {
  calls: number;
  minutes: number;
}

export function BillingUsageWidget({ orgId }: { orgId: string }) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [limits, setLimits] = useState<Limits>({ calls: 0, minutes: 0 });
  const [trends, setTrends] = useState<TrendsData | null>(null);

  useEffect(() => {
    apiFetch<UsageData>(`/v1/orgs/${orgId}/usage`).then(setUsage).catch(() => {});
    apiFetch<TrendsData>(`/v1/orgs/${orgId}/usage/trends`).then(setTrends).catch(() => {});
    apiFetch<{ limits: Limits }>('/billing/usage').then(r => setLimits(r.limits)).catch(() => {});
  }, [orgId]);

  if (!usage) return <div className="h-24 bg-muted/50 animate-pulse rounded-xl" />;

  const callsPct = limits.calls > 0 ? (usage.total_calls / limits.calls) * 100 : 0;
  const minutesPct = limits.minutes > 0 ? (usage.total_minutes / limits.minutes) * 100 : 0;
  const getColor = (pct: number) => pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-primary';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <UsageBar label="Calls" used={usage.total_calls} limit={limits.calls} pct={callsPct} color={getColor(callsPct)} />
        <UsageBar label="Minutes" used={usage.total_minutes} limit={limits.minutes} pct={minutesPct} color={getColor(minutesPct)} />
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm text-muted-foreground">Est. cost this month</p>
          <p className="mt-1 text-2xl font-semibold">${usage.estimated_cost.toFixed(2)}</p>
          {trends?.mom_delta && (
            <p className="mt-1 text-xs text-muted-foreground">
              {trends.mom_delta.minutes_pct >= 0 ? '+' : ''}{(trends.mom_delta.minutes_pct * 100).toFixed(0)}% MoM
            </p>
          )}
        </div>
      </div>
      {callsPct > 75 && (
        <div className="rounded-lg border border-chart-2/50 bg-chart-2/10 p-4 flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-chart-2 shrink-0" />
          <div>
            <p className="font-medium">You&apos;ve used {Math.round(callsPct)}% of your plan</p>
            <p className="text-sm text-muted-foreground">Upgrade to continue without interruption.</p>
          </div>
          <Button size="sm" className="ml-auto shrink-0">Upgrade</Button>
        </div>
      )}
    </div>
  );
}

function UsageBar({ label, used, limit, pct, color }: {
  label: string; used: number; limit: number; pct: number; color: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{limit === -1 ? '∞' : `${used} / ${limit}`}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{Math.round(pct)}% used</p>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into billing page**

Modify `apps/web/app/dashboard/billing/page.tsx` — add BillingUsageWidget import and render it before BillingPanel.

- [ ] **Step 3: Test UI**

Run: `cd apps/web && npm run dev`
Navigate: `/dashboard/billing`
Verify: Usage widget renders with bars, cost estimate, MoM trend

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/dashboard/billing/ && git commit -m "feat(web): add BillingUsageWidget to billing page"
```

---

## Task 8: UI — Admin Dashboard

**Files:**
- Create: `apps/web/app/admin/dashboard/page.tsx`
- Create: `apps/web/app/admin/orgs/[orgId]/billing/page.tsx`

- [ ] **Step 1: Write admin overview page**

```tsx
'use client';
import { useEffect, useState } from 'react';

interface OrgSummary {
  org_id: string; org_name: string; plan: string;
  total_spend: number; total_calls: number; total_minutes: number;
}

export default function AdminDashboardPage() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/usage/overview')
      .then(r => r.json())
      .then(data => { setOrgs(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 animate-pulse">Loading...</div>;

  return (
    <div className="p-8">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">Ops Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">Organization usage overview</p>
      <div className="mt-6 rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Organization</th>
              <th className="text-left p-3">Plan</th>
              <th className="text-right p-3">Spend</th>
              <th className="text-right p-3">Calls</th>
              <th className="text-right p-3">Minutes</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map(org => (
              <tr key={org.org_id} className="border-t hover:bg-muted/30">
                <td className="p-3">
                  <a href={`/admin/orgs/${org.org_id}/billing`} className="hover:underline">{org.org_name}</a>
                </td>
                <td className="p-3 capitalize">{org.plan}</td>
                <td className="p-3 text-right">${org.total_spend.toFixed(2)}</td>
                <td className="p-3 text-right">{org.total_calls.toLocaleString()}</td>
                <td className="p-3 text-right">{org.total_minutes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write org detail page**

```tsx
'use client';
import { useEffect, useState, use } from 'react';

interface OrgUsage {
  org_id: string; period: string; total_spend: number;
  total_calls: number; total_minutes: number; active_workspaces: number;
}

interface AgentUsage {
  agent_id: string; agent_name: string;
  total_calls: number; total_minutes: number; estimated_cost: number;
}

export default function OrgBillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [agents, setAgents] = useState<AgentUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/admin/orgs/${orgId}/usage`).then(r => r.json()),
      fetch(`/api/admin/orgs/${orgId}/agents/usage`).then(r => r.json()),
    ]).then(([u, a]) => { setUsage(u); setAgents(a); setLoading(false); });
  }, [orgId]);

  if (loading) return <div className="p-8 animate-pulse">Loading...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">Org Billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">{orgId} — {usage?.period}</p>
      {usage && (
        <div className="mt-6 grid grid-cols-4 gap-4">
          <MetricCard label="Spend" value={`$${usage.total_spend.toFixed(2)}`} />
          <MetricCard label="Calls" value={usage.total_calls.toLocaleString()} />
          <MetricCard label="Minutes" value={usage.total_minutes.toLocaleString()} />
          <MetricCard label="Workspaces" value={usage.active_workspaces.toString()} />
        </div>
      )}
      <h2 className="mt-8 text-xl font-semibold">Per-Agent Breakdown</h2>
      <div className="mt-4 rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Agent</th>
              <th className="text-right p-3">Calls</th>
              <th className="text-right p-3">Minutes</th>
              <th className="text-right p-3">Est. Cost</th>
            </tr>
          </thead>
          <tbody>
            {agents.map(agent => (
              <tr key={agent.agent_id} className="border-t">
                <td className="p-3">{agent.agent_name}</td>
                <td className="p-3 text-right">{agent.total_calls.toLocaleString()}</td>
                <td className="p-3 text-right">{agent.total_minutes.toLocaleString()}</td>
                <td className="p-3 text-right">${agent.estimated_cost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
```

- [ ] **Step 3: Test in browser**

Run: `cd apps/web && npm run dev`
Navigate: `/admin/dashboard` and `/admin/orgs/[id]/billing`

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/admin/ && git commit -m "feat(web): add admin ops dashboard pages"
```

---

## Spec Coverage Check

| Spec Section | Tasks |
|---|---|
| Materialized view (historical) | Task 2 |
| Live query (current month) | Task 3 |
| Internal API endpoints | Task 4 |
| Customer-facing API | Task 3 (UsageController) |
| Admin dashboard UI | Task 8 |
| Customer billing UI | Task 7 |
| Alerting (80%/100%) | Task 5 |
| Alert suppression | Task 5 |
| PlanPricing model | Task 1 |

All spec sections covered. No gaps.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-admin-cost-dashboard.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks

**2. Inline Execution** — execute tasks here using executing-plans skill

Which approach?