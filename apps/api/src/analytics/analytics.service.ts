import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AgentMetricsResponse,
  AgentMetricsRow,
  AnalyticsEvent,
  ComplianceMetrics,
  ImprovementSuggestion,
  ImprovementSuggestionsResponse,
  MetricsRangeQuery,
  RecordAnalyticsEventDto,
  WorkspaceMetrics,
} from '@voiceforge/shared';
import { SUCCESS_OUTCOMES } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';

interface ResolvedRange {
  from: Date;
  to: Date;
}

const DEFAULT_WINDOW_DAYS = 30;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- ingestion --------------------------------------------------------

  async recordEvent(
    workspaceId: string,
    dto: RecordAnalyticsEventDto,
  ): Promise<AnalyticsEvent> {
    const row = await this.prisma.analyticsEvent.create({
      data: {
        workspaceId,
        agentId: dto.agent_id ?? null,
        callId: dto.call_id ?? null,
        eventType: dto.event_type,
        payload: (dto.payload as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        occurredAt: dto.occurred_at ? new Date(dto.occurred_at) : new Date(),
      },
    });
    return this.toEventDto(row);
  }

  async recordEventInternal(input: {
    workspaceId: string;
    agentId?: string | null;
    callId?: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.analyticsEvent.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: input.agentId ?? null,
          callId: input.callId ?? null,
          eventType: input.eventType,
          payload:
            (input.payload as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        },
      });
    } catch {
      // best-effort; analytics never breaks call flow
    }
  }

  async listEvents(
    workspaceId: string,
    query: MetricsRangeQuery,
  ): Promise<AnalyticsEvent[]> {
    const range = this.resolveRange(query);
    const rows = await this.prisma.analyticsEvent.findMany({
      where: {
        workspaceId,
        occurredAt: { gte: range.from, lte: range.to },
        ...(query.agent_id ? { agentId: query.agent_id } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toEventDto(r));
  }

  // --- workspace metrics ------------------------------------------------

  async workspaceMetrics(
    workspaceId: string,
    query: MetricsRangeQuery,
  ): Promise<WorkspaceMetrics> {
    const range = this.resolveRange(query);

    const calls = await this.prisma.call.findMany({
      where: {
        workspaceId,
        createdAt: { gte: range.from, lte: range.to },
        ...(query.agent_id ? { agentId: query.agent_id } : {}),
      },
      select: {
        id: true,
        status: true,
        durationSeconds: true,
        outcome: true,
        agentId: true,
        direction: true,
      },
    });

    const blocked = await this.prisma.complianceCheck.count({
      where: {
        workspaceId,
        status: 'blocked',
        checkedAt: { gte: range.from, lte: range.to },
        ...(query.agent_id ? { agentId: query.agent_id } : {}),
      },
    });

    const totalCalls = calls.length;
    const totalSeconds = calls.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0);
    const completed = calls.filter((c) => c.status === 'completed').length;
    const failed = calls.filter((c) => c.status === 'failed').length;
    const successCount = calls.filter(
      (c) => c.outcome && SUCCESS_OUTCOMES.includes(c.outcome as never),
    ).length;

    const outcomeMap = new Map<string, number>();
    for (const c of calls) {
      const key = c.outcome ?? 'unknown';
      outcomeMap.set(key, (outcomeMap.get(key) ?? 0) + 1);
    }

    const activeAgents = new Set(calls.map((c) => c.agentId)).size;

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      total_calls: totalCalls,
      total_minutes: Math.round((totalSeconds / 60) * 100) / 100,
      answer_rate: totalCalls === 0 ? 0 : completed / totalCalls,
      failed_call_rate: totalCalls === 0 ? 0 : failed / totalCalls,
      success_rate: totalCalls === 0 ? 0 : successCount / totalCalls,
      blocked_calls: blocked,
      outcomes: [...outcomeMap.entries()]
        .map(([outcome, count]) => ({ outcome, count }))
        .sort((a, b) => b.count - a.count),
      agents_active: activeAgents,
    };
  }

  // --- agent metrics ----------------------------------------------------

  async agentMetrics(
    workspaceId: string,
    query: MetricsRangeQuery,
  ): Promise<AgentMetricsResponse> {
    const range = this.resolveRange(query);

    const agents = await this.prisma.agent.findMany({
      where: {
        workspaceId,
        ...(query.agent_id ? { id: query.agent_id } : {}),
      },
      select: { id: true, name: true },
    });

    const rows: AgentMetricsRow[] = [];
    for (const agent of agents) {
      const calls = await this.prisma.call.findMany({
        where: {
          workspaceId,
          agentId: agent.id,
          createdAt: { gte: range.from, lte: range.to },
        },
        select: { id: true, durationSeconds: true, outcome: true },
      });

      const totalCalls = calls.length;
      const successCount = calls.filter(
        (c) => c.outcome && SUCCESS_OUTCOMES.includes(c.outcome as never),
      ).length;
      const bookingCount = calls.filter((c) => c.outcome === 'appointment_booked').length;
      const qualCount = calls.filter((c) => c.outcome === 'lead_qualified').length;
      const transferCount = calls.filter(
        (c) => c.outcome === 'human_transfer_completed',
      ).length;
      const fallbackCount = calls.filter((c) => c.outcome === 'agent_failed').length;
      const totalDuration = calls.reduce((s, c) => s + (c.durationSeconds ?? 0), 0);

      const toolStats = await this.prisma.toolInvocation.groupBy({
        by: ['status'],
        where: {
          workspaceId,
          agentId: agent.id,
          startedAt: { gte: range.from, lte: range.to },
        },
        _count: { _all: true },
      });
      const toolTotal = toolStats.reduce((s, r) => s + r._count._all, 0);
      const toolSuccess =
        toolStats.find((r) => r.status === 'success')?._count._all ?? 0;

      const evals = await this.prisma.callEvaluation.aggregate({
        where: {
          workspaceId,
          agentId: agent.id,
          createdAt: { gte: range.from, lte: range.to },
        },
        _avg: { overallScore: true },
      });

      rows.push({
        agent_id: agent.id,
        agent_name: agent.name,
        total_calls: totalCalls,
        success_rate: totalCalls === 0 ? 0 : successCount / totalCalls,
        booking_rate: totalCalls === 0 ? 0 : bookingCount / totalCalls,
        qualification_rate: totalCalls === 0 ? 0 : qualCount / totalCalls,
        transfer_rate: totalCalls === 0 ? 0 : transferCount / totalCalls,
        fallback_rate: totalCalls === 0 ? 0 : fallbackCount / totalCalls,
        tool_success_rate: toolTotal === 0 ? 0 : toolSuccess / toolTotal,
        average_duration_seconds:
          totalCalls === 0 ? 0 : Math.round(totalDuration / totalCalls),
        average_evaluation_score: evals._avg.overallScore ?? 0,
      });
    }

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      agents: rows.sort((a, b) => b.total_calls - a.total_calls),
    };
  }

  // --- compliance metrics ----------------------------------------------

  async complianceMetrics(
    workspaceId: string,
    query: MetricsRangeQuery,
  ): Promise<ComplianceMetrics> {
    const range = this.resolveRange(query);

    const blockedChecks = await this.prisma.complianceCheck.findMany({
      where: {
        workspaceId,
        status: 'blocked',
        checkedAt: { gte: range.from, lte: range.to },
        ...(query.agent_id ? { agentId: query.agent_id } : {}),
      },
      select: { reasons: true },
    });

    const reasonCounts = new Map<string, number>();
    let missingConsent = 0;
    let dncHits = 0;
    for (const row of blockedChecks) {
      const reasons = Array.isArray(row.reasons) ? (row.reasons as Array<{ code?: string }>) : [];
      for (const r of reasons) {
        if (!r?.code) continue;
        reasonCounts.set(r.code, (reasonCounts.get(r.code) ?? 0) + 1);
        if (r.code === 'missing_consent') missingConsent += 1;
        if (r.code === 'dnc_listed') dncHits += 1;
      }
    }

    const optOuts = await this.prisma.contact.count({
      where: {
        workspaceId,
        optOut: true,
        optOutAt: { gte: range.from, lte: range.to },
      },
    });

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      blocked_calls: blockedChecks.length,
      block_reasons: [...reasonCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      opt_outs: optOuts,
      dnc_hits: dncHits,
      missing_consent: missingConsent,
    };
  }

  // --- improvement suggestions -----------------------------------------

  async improvementSuggestions(
    workspaceId: string,
    agentId: string,
    query: MetricsRangeQuery = {},
  ): Promise<ImprovementSuggestionsResponse> {
    const range = this.resolveRange(query);

    const suggestions: ImprovementSuggestion[] = [];

    const calls = await this.prisma.call.findMany({
      where: { workspaceId, agentId, createdAt: { gte: range.from, lte: range.to } },
      select: { id: true, outcome: true, durationSeconds: true, status: true },
    });
    const totalCalls = calls.length;

    // 1) Low success rate
    if (totalCalls >= 5) {
      const successCount = calls.filter(
        (c) => c.outcome && SUCCESS_OUTCOMES.includes(c.outcome as never),
      ).length;
      const rate = successCount / totalCalls;
      if (rate < 0.4) {
        suggestions.push({
          code: 'low_success_rate',
          title: 'Low success rate',
          detail: `Only ${Math.round(rate * 100)}% of calls reached a success outcome (${successCount}/${totalCalls}). Review goals + required fields and tighten the opening prompt.`,
          severity: 'warning',
          evidence_count: totalCalls,
        });
      }
    }

    // 2) Many short calls (< 15 s) — caller hangs up early
    const shortCalls = calls.filter((c) => (c.durationSeconds ?? 0) < 15).length;
    if (totalCalls >= 5 && shortCalls / totalCalls > 0.3) {
      suggestions.push({
        code: 'high_short_call_rate',
        title: 'Callers drop off early',
        detail: `${shortCalls} of ${totalCalls} calls ended in under 15 seconds. Tune the greeting and AI disclosure to be shorter + clearer.`,
        severity: 'warning',
        evidence_count: shortCalls,
      });
    }

    // 3) Tool failures
    const toolStats = await this.prisma.toolInvocation.groupBy({
      by: ['status'],
      where: {
        workspaceId,
        agentId,
        startedAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    });
    const toolTotal = toolStats.reduce((s, r) => s + r._count._all, 0);
    const toolFailed =
      toolStats.find((r) => r.status === 'failed')?._count._all ?? 0;
    if (toolTotal >= 3 && toolFailed / toolTotal > 0.2) {
      suggestions.push({
        code: 'tool_failure_rate_high',
        title: 'Tools failing',
        detail: `${toolFailed} of ${toolTotal} tool invocations failed. Check webhook URLs, auth, and input schemas.`,
        severity: 'critical',
        evidence_count: toolFailed,
      });
    }

    // 4) Compliance blocks
    const blocked = await this.prisma.complianceCheck.count({
      where: {
        workspaceId,
        agentId,
        status: 'blocked',
        checkedAt: { gte: range.from, lte: range.to },
      },
    });
    if (blocked > 0) {
      suggestions.push({
        code: 'compliance_blocks',
        title: 'Compliance is blocking outbound calls',
        detail: `${blocked} outbound attempts were blocked. Inspect the Compliance tab for top reasons (often missing consent or DNC).`,
        severity: blocked >= 5 ? 'critical' : 'warning',
        evidence_count: blocked,
      });
    }

    // 5) Low evaluation score
    const evalAgg = await this.prisma.callEvaluation.aggregate({
      where: {
        workspaceId,
        agentId,
        createdAt: { gte: range.from, lte: range.to },
      },
      _avg: { overallScore: true },
      _count: { _all: true },
    });
    const avgScore = evalAgg._avg.overallScore ?? null;
    const evalCount = evalAgg._count._all;
    if (avgScore !== null && evalCount >= 3 && avgScore < 0.5) {
      suggestions.push({
        code: 'low_evaluation_score',
        title: 'Post-call evaluation is low',
        detail: `Average evaluation score is ${(avgScore * 100).toFixed(0)}% across ${evalCount} calls. Review weakest metric on the call detail page.`,
        severity: 'warning',
        evidence_count: evalCount,
      });
    }

    return {
      agent_id: agentId,
      generated_at: new Date().toISOString(),
      suggestions,
    };
  }

  // --- helpers ---------------------------------------------------------

  private resolveRange(query: MetricsRangeQuery): ResolvedRange {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return { from, to };
  }

  private toEventDto(row: {
    id: string;
    workspaceId: string;
    agentId: string | null;
    callId: string | null;
    eventType: string;
    payload: Prisma.JsonValue;
    occurredAt: Date;
  }): AnalyticsEvent {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      call_id: row.callId,
      event_type: row.eventType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      occurred_at: row.occurredAt.toISOString(),
    };
  }
}
