import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

interface OrgUsageOverviewRow {
  org_id: string;
  org_name: string;
  plan: string;
  total_calls: bigint;
  total_minutes: bigint;
  estimated_cost: Prisma.Decimal;
}

interface OrgUsageDetailRow {
  org_id: string;
  period: string;
  total_calls: bigint;
  total_minutes: bigint;
  estimated_cost: Prisma.Decimal;
  active_workspaces: bigint;
}

export interface OrgUsageOverview {
  org_id: string;
  org_name: string;
  plan: string;
  total_spend: number;
  total_calls: number;
  total_minutes: number;
}

export interface OrgUsageDetail {
  org_id: string;
  period: string;
  total_spend: number;
  total_calls: number;
  total_minutes: number;
  active_workspaces: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usageService: UsageService,
  ) {}

  async getOrgUsageOverview(): Promise<OrgUsageOverview[]> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const rows = await this.prisma.$queryRaw<OrgUsageOverviewRow[]>`
      SELECT
        o.id                           AS org_id,
        o.name                         AS org_name,
        o.plan,
        COALESCE(SUM(u.total_calls), 0)::bigint    AS total_calls,
        COALESCE(SUM(u.total_minutes), 0)::bigint  AS total_minutes,
        COALESCE(SUM(u.estimated_cost), 0)::decimal AS estimated_cost
      FROM organizations o
      LEFT JOIN (
        SELECT
          ur.organization_id,
          SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END)::bigint    AS total_calls,
          SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END)::bigint  AS total_minutes,
          COALESCE(SUM(
            CASE WHEN ur.billable_metric = 'calls'
              THEN ur.quantity * COALESCE(pp_c.price_per_unit, 0)
              ELSE 0
            END +
            CASE WHEN ur.billable_metric = 'minutes'
              THEN ur.quantity * COALESCE(pp_m.price_per_unit, 0)
              ELSE 0
            END
          ), 0)::decimal AS estimated_cost
        FROM usage_records ur
        LEFT JOIN organizations org_p ON org_p.id = ur.organization_id
        LEFT JOIN plan_pricing pp_c ON pp_c.plan = org_p.plan AND pp_c.metric = 'calls'
        LEFT JOIN plan_pricing pp_m ON pp_m.plan = org_p.plan AND pp_m.metric = 'minutes'
        WHERE ur.period_start >= ${startOfMonth}
        GROUP BY ur.organization_id
      ) u ON u.organization_id = o.id
      GROUP BY o.id, o.name, o.plan
      ORDER BY estimated_cost DESC
    `;

    return rows.map((r) => ({
      org_id: r.org_id,
      org_name: r.org_name,
      plan: r.plan,
      total_spend: Number(r.estimated_cost),
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
    }));
  }

  async getOrgUsageDetail(
    orgId: string,
    period?: string,
  ): Promise<OrgUsageDetail | null> {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // If no period specified or current month, query live usage_records
    if (!period || period === currentPeriod) {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const records = await this.prisma.usageRecord.findMany({
        where: {
          organizationId: orgId,
          periodStart: { gte: startOfMonth },
        },
        select: { billableMetric: true, quantity: true },
      });

      let totalCalls = 0;
      let totalMinutes = 0;
      for (const r of records) {
        if (r.billableMetric === 'calls') totalCalls += r.quantity;
        if (r.billableMetric === 'minutes') totalMinutes += r.quantity;
      }

      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { plan: true },
      });
      const plan = org?.plan ?? 'free';

      const prices = await this.prisma.planPricing.findMany({
        where: { plan },
      });
      const callPrice =
        prices.find((p: { metric: string; pricePerUnit: Prisma.Decimal }) => p.metric === 'calls')?.pricePerUnit ?? new Prisma.Decimal(0);
      const minutePrice =
        prices.find((p: { metric: string; pricePerUnit: Prisma.Decimal }) => p.metric === 'minutes')?.pricePerUnit ?? new Prisma.Decimal(0);

      const total_spend =
        Math.round(
          (Number(callPrice) * totalCalls + Number(minutePrice) * totalMinutes) * 100,
        ) / 100;

      const activeWorkspaces = await this.prisma.workspace.count({
        where: { organizationId: orgId, status: 'active' },
      });

      return {
        org_id: orgId,
        period: currentPeriod,
        total_spend,
        total_calls: totalCalls,
        total_minutes: totalMinutes,
        active_workspaces: activeWorkspaces,
      };
    }

    // For past periods, use the materialized view
    const rows = await this.prisma.$queryRaw<OrgUsageDetailRow[]>`
      SELECT
        org_id,
        period,
        SUM(total_calls)::bigint    AS total_calls,
        SUM(total_minutes)::bigint  AS total_minutes,
        SUM(estimated_cost)::decimal AS estimated_cost,
        SUM(active_workspaces)::bigint AS active_workspaces
      FROM mv_org_cost_summary
      WHERE org_id = ${orgId}
        AND period = ${period}
      GROUP BY org_id, period
    `;

    if (rows.length === 0) return null;

    const r = rows[0];
    return {
      org_id: r.org_id,
      period: r.period,
      total_spend: Number(r.estimated_cost),
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
      active_workspaces: Number(r.active_workspaces),
    };
  }

  async getOrgAgentUsage(
    orgId: string,
    period: string,
  ) {
    return this.usageService.getAgentUsageBreakdown(orgId, period);
  }
}