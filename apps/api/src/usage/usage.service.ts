import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CurrentMonthUsage {
  org_id: string;
  period: string;
  total_calls: number;
  total_minutes: number;
  estimated_cost: number;
}

export interface HistoricalUsageRow {
  period: string;
  total_calls: number;
  total_minutes: number;
  estimated_cost: number;
  active_workspaces: number;
}

export interface AgentUsageBreakdown {
  agent_id: string;
  agent_name: string;
  total_calls: number;
  total_minutes: number;
  estimated_cost: number;
}

interface MvOrgCostSummaryRow {
  org_id: string;
  period: string;
  total_calls: bigint;
  total_minutes: bigint;
  estimated_cost: Prisma.Decimal;
  active_workspaces: bigint;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentMonthUsage(orgId: string): Promise<CurrentMonthUsage> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

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
      prices.find((p) => p.metric === 'calls')?.pricePerUnit ?? new Prisma.Decimal(0);
    const minutePrice =
      prices.find((p) => p.metric === 'minutes')?.pricePerUnit ?? new Prisma.Decimal(0);

    const estimated_cost =
      Number(callPrice) * totalCalls + Number(minutePrice) * totalMinutes;

    return {
      org_id: orgId,
      period,
      total_calls: totalCalls,
      total_minutes: totalMinutes,
      estimated_cost: Math.round(estimated_cost * 100) / 100,
    };
  }

  async getHistoricalUsage(
    orgId: string,
    from: string,
    to: string,
  ): Promise<HistoricalUsageRow[]> {
    const rows = await this.prisma.$queryRaw<MvOrgCostSummaryRow[]>`
      SELECT
        org_id,
        period,
        SUM(total_calls)::bigint    AS total_calls,
        SUM(total_minutes)::bigint  AS total_minutes,
        SUM(estimated_cost)::decimal AS estimated_cost,
        SUM(active_workspaces)::bigint AS active_workspaces
      FROM mv_org_cost_summary
      WHERE org_id = ${orgId}
        AND period >= ${from}
        AND period <= ${to}
      GROUP BY org_id, period
      ORDER BY period ASC
    `;

    return rows.map((r) => ({
      period: r.period,
      total_calls: Number(r.total_calls),
      total_minutes: Number(r.total_minutes),
      estimated_cost: Number(r.estimated_cost),
      active_workspaces: Number(r.active_workspaces),
    }));
  }

  async getAgentUsageBreakdown(
    orgId: string,
    period: string,
  ): Promise<AgentUsageBreakdown[]> {
    const [yearStr, monthStr] = period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1; // JS month is 0-indexed
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const agents = await this.prisma.agent.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    });

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true },
    });
    const plan = org?.plan ?? 'free';

    const prices = await this.prisma.planPricing.findMany({
      where: { plan },
    });
    const callPrice =
      prices.find((p) => p.metric === 'calls')?.pricePerUnit ?? new Prisma.Decimal(0);
    const minutePrice =
      prices.find((p) => p.metric === 'minutes')?.pricePerUnit ?? new Prisma.Decimal(0);

    if (agents.length === 0) return [];

    // Single query to get all agent call stats (avoids N+1)
    const agentStats = await this.prisma.call.groupBy({
      by: ['agentId'],
      where: {
        agentId: { in: agents.map((a) => a.id) },
        createdAt: { gte: start, lte: end },
      },
      _count: { _all: true },
      _sum: { durationSeconds: true },
    });

    const statsMap = new Map(agentStats.map((s) => [s.agentId, s]));

    return agents.map((agent) => {
      const stats = statsMap.get(agent.id);
      const total_calls = stats?._count._all ?? 0;
      const total_seconds = Number(stats?._sum.durationSeconds ?? 0);
      const total_minutes = Math.round((total_seconds / 60) * 100) / 100;
      const estimated_cost =
        Math.round(
          (Number(callPrice) * total_calls + Number(minutePrice) * total_minutes) * 100,
        ) / 100;

      return {
        agent_id: agent.id,
        agent_name: agent.name,
        total_calls,
        total_minutes,
        estimated_cost,
      };
    });
  }
}