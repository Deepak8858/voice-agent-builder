import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AgentSpec, CallEvaluation, CallEvaluationMetric } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EvaluationsService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluateCall(callId: string): Promise<CallEvaluation | null> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        agent: true,
        evaluation: true,
        events: { orderBy: { eventTime: 'asc' } },
      },
    });
    if (!call) return null;
    if (call.status !== 'completed') return null;

    const version = call.agentVersionId
      ? await this.prisma.agentVersion.findUnique({ where: { id: call.agentVersionId } })
      : null;
    const spec = (version?.specJson ?? null) as AgentSpec | null;

    const transcript = (call.transcriptText ?? '').toLowerCase();
    const successEventTypes = new Set(
      call.events.map((e) => e.eventType).filter((t) => t.startsWith('agent.')),
    );

    const metrics: CallEvaluationMetric[] = [];

    if (spec?.goals?.length) {
      const hits = spec.goals.filter((g) => transcript.includes(g.toLowerCase().slice(0, 40))).length;
      const score = spec.goals.length === 0 ? 0 : hits / spec.goals.length;
      metrics.push({
        name: 'goal_coverage',
        score,
        reason: `${hits}/${spec.goals.length} goal phrases referenced in transcript.`,
      });
    }

    if (spec?.required_fields?.length) {
      const required = spec.required_fields.filter((f) => f.required);
      const captured = required.filter((f) => transcript.includes(f.key.toLowerCase())).length;
      const score = required.length === 0 ? 1 : captured / required.length;
      metrics.push({
        name: 'required_fields_captured',
        score,
        reason: `${captured}/${required.length} required fields appear in transcript.`,
      });
    }

    const successEvents = spec?.analytics?.success_events ?? [];
    if (successEvents.length) {
      const fired = successEvents.filter((e) => successEventTypes.has(e)).length;
      const score = fired / successEvents.length;
      metrics.push({
        name: 'success_events',
        score,
        reason: `${fired}/${successEvents.length} success events fired.`,
      });
    }

    metrics.push({
      name: 'duration_health',
      score: this.scoreDuration(call.durationSeconds),
      reason: `Duration ${call.durationSeconds ?? 0}s.`,
    });

    const overall =
      metrics.reduce((sum, m) => sum + m.score, 0) / Math.max(metrics.length, 1);

    const summary = this.buildSummary(call.outcome, overall, metrics);

    const row = await this.prisma.callEvaluation.upsert({
      where: { callId: call.id },
      create: {
        callId: call.id,
        workspaceId: call.workspaceId,
        organizationId: call.organizationId,
        agentId: call.agentId,
        agentVersionId: call.agentVersionId,
        overallScore: overall,
        metricScores: metrics as unknown as Prisma.InputJsonValue,
        summary,
        evaluatedBy: 'rule_based',
      },
      update: {
        overallScore: overall,
        metricScores: metrics as unknown as Prisma.InputJsonValue,
        summary,
        evaluatedBy: 'rule_based',
      },
    });

    return this.toDto(row);
  }

  async getForCall(workspaceId: string, callId: string): Promise<CallEvaluation | null> {
    const row = await this.prisma.callEvaluation.findFirst({
      where: { callId, workspaceId },
    });
    return row ? this.toDto(row) : null;
  }

  private scoreDuration(seconds: number | null): number {
    if (seconds == null) return 0;
    if (seconds < 5) return 0.2;
    if (seconds < 30) return 0.5;
    if (seconds < 600) return 1;
    return 0.7;
  }

  private buildSummary(
    outcome: string | null,
    overall: number,
    metrics: CallEvaluationMetric[],
  ): string {
    const grade = overall >= 0.8 ? 'strong' : overall >= 0.5 ? 'mixed' : 'weak';
    const weakest = metrics.reduce(
      (acc, m) => (m.score < acc.score ? m : acc),
      metrics[0] ?? { name: 'none', score: 1 },
    );
    return `${grade} call (${(overall * 100).toFixed(0)}%); outcome=${outcome ?? 'n/a'}; weakest=${weakest.name}.`;
  }

  private toDto(row: {
    id: string;
    callId: string;
    workspaceId: string;
    agentId: string;
    agentVersionId: string | null;
    overallScore: number;
    metricScores: Prisma.JsonValue;
    summary: string | null;
    evaluatedBy: string;
    createdAt: Date;
  }): CallEvaluation {
    return {
      id: row.id,
      call_id: row.callId,
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      agent_version_id: row.agentVersionId,
      overall_score: row.overallScore,
      metric_scores: (row.metricScores as unknown as CallEvaluationMetric[]) ?? [],
      summary: row.summary,
      evaluated_by: row.evaluatedBy as CallEvaluation['evaluated_by'],
      created_at: row.createdAt.toISOString(),
    };
  }
}
