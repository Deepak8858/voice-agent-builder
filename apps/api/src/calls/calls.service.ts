import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AgentSpec,
  CallDetail,
  CallSummary,
  CallTurn,
  StartOutboundCallDto,
  StartTestSessionDto,
  TestSessionResult,
} from '@voiceforge/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import {
  AgentNotFoundError,
  AgentNotPublishedError,
  AgentSpecInvalidError,
  CallNotFoundError,
  ComplianceBlockedError,
} from '../common/errors';
import { ComplianceService } from '../compliance/compliance.service';
import { EvaluationsService } from '../evaluations/evaluations.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { VOICE_PROVIDER_TOKEN } from '../voice/voice.module';
import type { VoiceRuntimeProvider } from '../voice/adapters/voice.provider.interface';

@Injectable()
export class CallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(VOICE_PROVIDER_TOKEN) private readonly voice: VoiceRuntimeProvider,
    private readonly evaluations: EvaluationsService,
    private readonly compliance: ComplianceService,
    private readonly analytics: AnalyticsService,
    private readonly billing: BillingService,
    private readonly queue: QueueService,
  ) {}

  async startTestSession(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    dto: StartTestSessionDto,
  ): Promise<TestSessionResult> {
    const { agent, version } = await this.resolveAgentVersion(workspaceId, agentId, dto.agent_version_id);

    const session = await this.voice.createBrowserTestSession({
      workspaceId,
      agentId: agent.id,
      agentVersionId: version.id,
    });

    const transcript = await this.voice.getTranscript({ callId: session.test_session_id });

    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });

    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: ws.organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        direction: 'browser_test',
        status: 'completed',
        provider: this.voice.name,
        providerCallId: session.test_session_id,
        contactName: dto.contact_name ?? 'Browser tester',
        startedAt: new Date(),
        endedAt: new Date(),
        durationSeconds: Math.ceil(
          (transcript.turns.at(-1)?.at_ms ?? 0) / 1000,
        ),
        transcriptText: transcript.transcript,
        outcome: 'test_completed',
        metadata: { test_session_id: session.test_session_id } as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'call.test_session.start',
      resourceType: 'call',
      resourceId: call.id,
      metadata: { agent_id: agent.id, version_id: version.id },
    });

    return {
      call_id: call.id,
      test_session_id: session.test_session_id,
      web_socket_url: session.web_socket_url ?? null,
      token: session.token ?? null,
      expires_at: session.expires_at,
    };
  }

  async startOutboundCall(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    dto: StartOutboundCallDto,
  ): Promise<CallSummary> {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const allowed = await this.billing.checkFeatureGate(ws.organizationId, 'outbound');
    if (!allowed) {
      throw new ForbiddenPlanError('Outbound calls require a paid plan.');
    }

    const outbound = await this.billing.canStartOutboundCall(workspaceId);
    if (!outbound.allowed) {
      throw new ForbiddenPlanError(
        outbound.limit === -1
          ? 'Outbound calls are not available on your plan.'
          : `Monthly outbound call limit reached (${outbound.limit}). Please upgrade or wait until next billing cycle.`,
      );
    }

    const { agent, version } = await this.resolveAgentVersion(
      workspaceId,
      agentId,
      dto.agent_version_id,
    );
    if (agent.status !== 'published') throw new AgentNotPublishedError(agent.id);

    // Phase 6: pre-flight compliance check. Block before we hit the voice provider.
    const purpose =
      typeof dto.metadata?.purpose === 'string' ? (dto.metadata.purpose as string) : null;
    const checkResult = await this.compliance.check({
      workspaceId,
      agentId: agent.id,
      direction: 'outbound',
      toNumber: dto.to_number,
      purpose,
    });
    if (checkResult.status === 'blocked') {
      await this.audit.log({
        workspaceId,
        actorUserId,
        action: 'call.outbound.blocked',
        resourceType: 'compliance_check',
        resourceId: checkResult.id,
        metadata: {
          to_number: dto.to_number,
          agent_id: agent.id,
          reasons: checkResult.reasons,
        },
      });
      await this.analytics.recordEventInternal({
        workspaceId,
        agentId: agent.id,
        eventType: 'call.blocked',
        payload: { reasons: checkResult.reasons, to_number: dto.to_number },
      });
      throw new ComplianceBlockedError({ reasons: checkResult.reasons });
    }

    const result = await this.voice.startOutboundCall({
      workspaceId,
      agentId: agent.id,
      agentVersionId: version.id,
      toNumber: dto.to_number,
      fromNumber: dto.from_number,
      metadata: dto.metadata,
    });

    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: ws.organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        contactId: checkResult.contact_id,
        direction: 'outbound',
        status: result.status,
        provider: this.voice.name,
        providerCallId: result.provider_call_id,
        toNumber: dto.to_number,
        fromNumber: dto.from_number ?? null,
        contactName: dto.contact_name ?? null,
        startedAt: new Date(),
        metadata: (dto.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });

    await this.compliance.attachCheckToCall(checkResult.id, call.id);

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'call.outbound.start',
      resourceType: 'call',
      resourceId: call.id,
      metadata: {
        to_number: dto.to_number,
        agent_id: agent.id,
        compliance_check_id: checkResult.id,
        contact_id: checkResult.contact_id,
      },
    });

    await this.analytics.recordEventInternal({
      workspaceId,
      agentId: agent.id,
      callId: call.id,
      eventType: 'call.started',
      payload: { direction: 'outbound', to_number: dto.to_number },
    });

    return this.toSummary(call);
  }

  async list(workspaceId: string, agentId?: string): Promise<CallSummary[]> {
    const rows = await this.prisma.call.findMany({
      where: { workspaceId, ...(agentId ? { agentId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toSummary(r));
  }

  async get(workspaceId: string, callId: string): Promise<CallDetail> {
    const call = await this.prisma.call.findFirst({
      where: { id: callId, workspaceId },
      include: { agent: { select: { name: true } } },
    });
    if (!call) throw new CallNotFoundError(callId);

    let turns: CallTurn[] = [];
    if (call.providerCallId) {
      try {
        const t = await this.voice.getTranscript({ callId: call.providerCallId });
        turns = t.turns;
      } catch {
        turns = [];
      }
    }

    const evaluation = await this.evaluations.getForCall(workspaceId, call.id);

    return {
      ...this.toSummary(call),
      transcript_text: call.transcriptText,
      recording_url: call.recordingUrl,
      turns,
      agent_name: call.agent?.name ?? null,
      evaluation,
    };
  }

  async end(workspaceId: string, callId: string, actorUserId: string): Promise<CallSummary> {
    const call = await this.prisma.call.findFirst({ where: { id: callId, workspaceId } });
    if (!call) throw new CallNotFoundError(callId);

    if (call.providerCallId) {
      try {
        await this.voice.endCall({ callId: call.providerCallId, reason: 'user_requested' });
      } catch {
        // continue; we still mark the row as ended
      }
    }

    const endedAt = new Date();
    const durationSeconds = call.startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000))
      : null;

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'completed', endedAt, durationSeconds },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'call.end',
      resourceType: 'call',
      resourceId: callId,
    });

    await this.analytics.recordEventInternal({
      workspaceId,
      agentId: updated.agentId,
      callId: updated.id,
      eventType: 'call.ended',
      payload: {
        outcome: updated.outcome,
        duration_seconds: durationSeconds,
        direction: updated.direction,
      },
    });

    // Queue async evaluation (best-effort — worker handles retries)
    try {
      await this.queue.enqueue('evaluation', 'evaluate', { callId, workspaceId });
    } catch {}

    // Phase 9: record usage
    await this.recordUsage(workspaceId, updated.id, updated.direction, durationSeconds);

    return this.toSummary(updated);
  }

  async ingestEvent(
    provider: string,
    payload: { event_type: string; provider_call_id?: string; data?: Record<string, unknown> },
  ): Promise<void> {
    if (!payload.provider_call_id) return;
    let call = await this.prisma.call.findFirst({
      where: { providerCallId: payload.provider_call_id },
    });

    // Inbound: provider sent a `call.started` for an unknown call. Resolve the
    // agent via provider_runtime_id stored on the published AgentVersion and
    // create an inbound Call row so subsequent events have a parent to attach.
    if (!call && payload.event_type === 'call.started') {
      const data = payload.data ?? {};
      const providerRuntimeId =
        typeof data.provider_runtime_id === 'string' ? data.provider_runtime_id : null;
      if (!providerRuntimeId) return;

      const version = await this.prisma.agentVersion.findFirst({
        where: { providerRuntimeId, deploymentStatus: 'deployed' },
        include: { agent: true },
        orderBy: { versionNumber: 'desc' },
      });
      if (!version) return;

      const ws = await this.prisma.workspace.findUniqueOrThrow({
        where: { id: version.agent.workspaceId },
        select: { organizationId: true },
      });

      call = await this.prisma.call.create({
        data: {
          workspaceId: version.agent.workspaceId,
          organizationId: ws.organizationId,
          agentId: version.agentId,
          agentVersionId: version.id,
          direction: 'inbound',
          status: 'in_progress',
          provider,
          providerCallId: payload.provider_call_id,
          fromNumber: typeof data.from_number === 'string' ? data.from_number : null,
          toNumber: typeof data.to_number === 'string' ? data.to_number : null,
          contactName: typeof data.contact_name === 'string' ? data.contact_name : null,
          startedAt: typeof data.started_at === 'string' ? new Date(data.started_at) : new Date(),
          metadata: (data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });
    }

    if (!call) return;

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        workspaceId: call.workspaceId,
        organizationId: call.organizationId,
        eventType: payload.event_type,
        payload: (payload.data as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });

    if (payload.event_type === 'call.ended') {
      const transcriptText =
        typeof payload.data?.transcript === 'string' ? payload.data.transcript : null;
      const recordingUrl =
        typeof payload.data?.recording_url === 'string' ? payload.data.recording_url : null;
      const outcome = typeof payload.data?.outcome === 'string' ? payload.data.outcome : null;
      const endedAt = new Date();
      const durationSeconds = call.startedAt
        ? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000))
        : null;

      const updated = await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: 'completed',
          endedAt,
          durationSeconds,
          ...(transcriptText ? { transcriptText } : {}),
          ...(recordingUrl ? { recordingUrl } : {}),
          ...(outcome ? { outcome } : {}),
        },
      });

      try {
        await this.compliance.processTranscriptOptOut({
          workspaceId: updated.workspaceId,
          callId: updated.id,
          direction: updated.direction,
          contactId: updated.contactId,
          fromNumber: updated.fromNumber,
          toNumber: updated.toNumber,
          transcript: updated.transcriptText,
        });
      } catch {
        // best-effort; never break the webhook on opt-out detection
      }

      await this.analytics.recordEventInternal({
        workspaceId: updated.workspaceId,
        agentId: updated.agentId,
        callId: updated.id,
        eventType: 'call.ended',
        payload: {
          outcome: updated.outcome,
          duration_seconds: durationSeconds,
          direction: updated.direction,
        },
      });

      if (updated.outcome) {
        await this.analytics.recordEventInternal({
          workspaceId: updated.workspaceId,
          agentId: updated.agentId,
          callId: updated.id,
          eventType: `outcome.${updated.outcome}`,
          payload: { direction: updated.direction },
        });
      }

      // Queue async evaluation (best-effort — worker handles retries)
      try {
        await this.queue.enqueue('evaluation', 'evaluate', { callId: call.id, workspaceId: call.workspaceId });
      } catch {}

      // Phase 9: record usage for provider-driven call completion
      await this.recordUsage(call.workspaceId, updated.id, updated.direction, durationSeconds);
    }
  }

  private async resolveAgentVersion(
    workspaceId: string,
    agentId: string,
    versionIdHint?: string,
  ) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!agent) throw new AgentNotFoundError(agentId);

    const version = versionIdHint
      ? agent.versions.find((v) => v.id === versionIdHint) ?? null
      : (agent.versions.find((v) => v.id === agent.activeVersionId) ?? agent.versions[0] ?? null);
    if (!version) {
      throw new AgentSpecInvalidError({
        reason: 'Agent has no versions yet. Save a draft Agent Spec before testing.',
      });
    }

    // Lazily ensure a runtime agent exists on the provider side.
    // Idempotent: createAgent on Vapi/Retell either creates new or returns
    // the existing assistant id. Errors here are non-fatal — the subsequent
    // outbound call attempt will surface a structured VOICE_PROVIDER_ERROR.
    try {
      await this.voice.createAgent({
        workspaceId,
        agentId: agent.id,
        agentVersionId: version.id,
        spec: version.specJson as unknown as AgentSpec,
      });
    } catch {
      // best-effort; real adapters surface errors via the call placement path
    }

    return { agent, version };
  }

  private async recordUsage(
    workspaceId: string,
    callId: string,
    direction: string,
    durationSeconds: number | null,
  ): Promise<void> {
    try {
      await this.billing.recordUsage(workspaceId, 'calls', 1);
      if (direction === 'outbound' && durationSeconds !== null) {
        const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
        await this.billing.recordUsage(workspaceId, 'minutes', minutes);
      }
    } catch {
      // usage recording is best-effort; never fail a call end
    }
  }

  private toSummary(c: {
    id: string;
    workspaceId: string;
    agentId: string;
    agentVersionId: string | null;
    direction: string;
    status: string;
    provider: string;
    fromNumber: string | null;
    toNumber: string | null;
    contactName: string | null;
    durationSeconds: number | null;
    outcome: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    createdAt: Date;
  }): CallSummary {
    return {
      id: c.id,
      workspace_id: c.workspaceId,
      agent_id: c.agentId,
      agent_version_id: c.agentVersionId,
      direction: c.direction as CallSummary['direction'],
      status: c.status as CallSummary['status'],
      provider: c.provider,
      from_number: c.fromNumber,
      to_number: c.toNumber,
      contact_name: c.contactName,
      duration_seconds: c.durationSeconds,
      outcome: c.outcome,
      started_at: c.startedAt?.toISOString() ?? null,
      ended_at: c.endedAt?.toISOString() ?? null,
      created_at: c.createdAt.toISOString(),
    };
  }
}
