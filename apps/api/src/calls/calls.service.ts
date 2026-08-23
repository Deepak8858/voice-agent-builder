import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validate as isUuid } from 'uuid';
import type {
  AgentSpec,
  CallDetail,
  CallSummary,
  CallTurn,
  StartOutboundCallDto,
  StartTestSessionDto,
  TestSessionResult,
  VoicePipeline,
} from '@voiceforge/shared';
import { PAID_CALL_MINIMUM_SECONDS } from '@voiceforge/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { CallAdmissionService, isCallDenied } from '../billing/call-admission.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import { EntitlementService } from '../billing/entitlement.service';
import { CacheService } from '../cache/cache.service';
import {
  AgentNotFoundError,
  AgentNotPublishedError,
  AgentSpecInvalidError,
  AppError,
  CallNotFoundError,
  ComplianceBlockedError,
} from '../common/errors';
import { ComplianceService } from '../compliance/compliance.service';
import { RetentionService } from '../compliance/retention.service';
import { env } from '../config/env';
import { EvaluationsService } from '../evaluations/evaluations.service';
import { LiveKitService } from '../livekit/livekit.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { VOICE_PROVIDER_TOKEN } from '../voice/voice.module';
import type { VoiceRuntimeProvider } from '../voice/adapters/voice.provider.interface';
import { PipelineRouterService } from '../voice/pipeline-router.service';
import { VoiceProviderRegistry } from '../voice/voice-provider.registry';

const CALL_LIST_TTL_SECONDS = 15;

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
    private readonly retention: RetentionService,
    private readonly cache: CacheService,
    private readonly admission: CallAdmissionService,
    private readonly entitlements: EntitlementService,
    private readonly voiceRegistry?: VoiceProviderRegistry,
    private readonly pipelineRouter?: PipelineRouterService,
    private readonly livekit?: LiveKitService,
  ) {}

  /**
   * Records which runtime pipeline a call was routed to.
   *
   * Routing needs the call identity, so it happens after the row exists and the
   * column is filled in a follow-up write. A routing or write failure must not
   * fail a call that is otherwise fully admitted: the pipeline is reporting and
   * reconciliation data, and the runtime receives its own copy in the dispatch
   * metadata.
   */
  private async persistPipeline(
    organizationId: string,
    callId: string,
  ): Promise<void> {
    if (!this.pipelineRouter || typeof this.entitlements?.getEffectivePlan !== 'function') return;
    try {
      const effective = await this.entitlements.getEffectivePlan(organizationId);
      const { pipeline } = this.pipelineRouter.route(effective.plan, callId);
      await this.prisma.call.update({ where: { id: callId }, data: { pipeline } });
    } catch {
      // Best-effort: the decision is deterministic and can be re-derived from
      // the plan and call id if it is ever needed and missing.
    }
  }

  async startTestSession(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    dto: StartTestSessionDto,
  ): Promise<TestSessionResult> {
    const { agent, version, voice } = await this.resolveAgentVersion(
      workspaceId,
      agentId,
      dto.agent_version_id,
    );

    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true, retentionDays: true },
    });

    // A browser test is a metered call funded by the organization's balance, so
    // entitlement is checked before any runtime is engaged. Credit is not
    // reserved here: the reservation is bound to a call row, which does not
    // exist yet.
    await this.entitlements.assertAllowed(ws.organizationId, {
      kind: 'browser_test',
      minimumSeconds: PAID_CALL_MINIMUM_SECONDS,
    });

    const pipeline = await this.testSessionPipeline(ws.organizationId);
    if (pipeline === 'standard') {
      return this.startStandardTestSession({
        workspaceId,
        organizationId: ws.organizationId,
        retentionDays: ws.retentionDays,
        actorUserId,
        agentId: agent.id,
        agentVersionId: version.id,
        contactName: dto.contact_name ?? 'Browser tester',
      });
    }

    const session = await voice.createBrowserTestSession({
      workspaceId,
      agentId: agent.id,
      agentVersionId: version.id,
    });

    let transcript: { transcript: string; turns: Array<{ at_ms: number }> };
    try {
      transcript = await voice.getTranscript({ callId: session.test_session_id });
    } catch {
      transcript = { transcript: '', turns: [] };
    }
    const transcriptReady = transcript.transcript.trim().length > 0 || transcript.turns.length > 0;

    const expiresAt = new Date(new Date().getTime() + ws.retentionDays * 24 * 60 * 60 * 1000);

    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: ws.organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        direction: 'browser_test',
        status: transcriptReady ? 'completed' : 'in_progress',
        provider: voice.name,
        pipeline: 'realtime',
        providerCallId: session.test_session_id,
        contactName: dto.contact_name ?? 'Browser tester',
        startedAt: new Date(),
        endedAt: transcriptReady ? new Date() : null,
        durationSeconds: transcriptReady
          ? Math.ceil((transcript.turns.at(-1)?.at_ms ?? 0) / 1000)
          : null,
        transcriptText: transcript.transcript,
        outcome: transcriptReady ? 'test_completed' : null,
        expiresAt,
        retentionDays: ws.retentionDays,
        metadata: {
          test_session_id: session.test_session_id,
          transcript_status: transcriptReady ? 'available' : 'pending',
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'call.test_session.start',
      resourceType: 'call',
      resourceId: call.id,
      metadata: { agent_id: agent.id, version_id: version.id, pipeline: 'realtime' },
    });
    await this.invalidateCallList(workspaceId, agent.id);

    return {
      call_id: call.id,
      test_session_id: session.test_session_id,
      pipeline: 'realtime',
      web_socket_url: session.web_socket_url ?? null,
      livekit_url: null,
      room_name: null,
      token: session.token ?? null,
      expires_at: session.expires_at,
    };
  }

  /**
   * Which runtime a browser test should use.
   *
   * A free organization is only entitled to the in-house pipeline, so its test
   * must not mint a Realtime client secret — that would hand out the expensive
   * runtime for free. Without a router (or LiveKit) available, the legacy
   * Realtime path is kept so tests keep working in development.
   */
  private async testSessionPipeline(organizationId: string): Promise<VoicePipeline> {
    if (!this.pipelineRouter || !this.livekit) return 'realtime';
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    return this.pipelineRouter.isAllowed(effective.plan, 'realtime') ? 'realtime' : 'standard';
  }

  /**
   * Runs a browser test on the in-house pipeline.
   *
   * The browser joins a LiveKit room instead of talking to a speech-to-speech
   * model directly, so the same worker, metering, and tool wiring that serve
   * telephony calls also serve the test. The transcript arrives asynchronously
   * over the existing call-event stream, so the call starts `in_progress` with
   * no transcript rather than being polled for one that cannot exist yet.
   */
  private async startStandardTestSession(input: {
    workspaceId: string;
    organizationId: string;
    retentionDays: number;
    actorUserId: string;
    agentId: string;
    agentVersionId: string;
    contactName: string;
  }): Promise<TestSessionResult> {
    const livekit = this.livekit!;
    const expiresAt = new Date(Date.now() + input.retentionDays * 24 * 60 * 60 * 1000);

    const call = await this.prisma.call.create({
      data: {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        direction: 'browser_test',
        status: 'in_progress',
        provider: 'livekit',
        pipeline: 'standard',
        contactName: input.contactName,
        startedAt: new Date(),
        transcriptText: '',
        expiresAt,
        retentionDays: input.retentionDays,
        metadata: { transcript_status: 'pending' } as Prisma.InputJsonValue,
      },
    });

    // The test is metered exactly like a telephony call, so it goes through the
    // same admission gate. This is not only a billing concern: admission is what
    // reserves the first minute and creates the `CallUsage` row, and the worker's
    // `call_connected` report commits that reservation. Without it the runtime
    // would fail to commit and hang the call up as unmetered.
    const admission = await this.admission.admitCall({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: call.id,
      provider: 'livekit',
      direction: 'browser_test',
      pipeline: 'standard',
    });
    if (isCallDenied(admission)) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: admission.reason },
      });
      throw this.admission.toError(admission);
    }

    const roomName = `${env.LIVEKIT_ROOM_PREFIX}-test-${call.id}`;
    const metadata = {
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      callId: call.id,
      direction: 'browser_test',
      pipeline: 'standard' as const,
    };

    try {
      await livekit.createRoomForCall({ roomName, metadata });
      await livekit.dispatchAgent({
        roomName,
        agentName: env.LIVEKIT_AGENT_NAME,
        metadata,
      });
    } catch (err) {
      // A room that never came up owes nothing, so the reserved minute is
      // returned and the concurrency slot is freed rather than being held until
      // the lease expires.
      await this.admission.compensate(
        input.organizationId,
        call.id,
        'provider_dispatch_failed',
      );
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'provider_dispatch_failed' },
      });
      throw err;
    }

    const token = await livekit.createAccessToken({
      userId: input.actorUserId,
      roomName,
      identity: `tester-${input.actorUserId}`,
      metadata: { callId: call.id, agentId: input.agentId },
    });

    await this.prisma.call.update({
      where: { id: call.id },
      data: { livekitRoomName: roomName, providerCallId: roomName },
    });
    await this.prisma.callUsage.updateMany({
      where: { callId: call.id },
      data: { providerCallId: roomName },
    });

    await this.audit.log({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'call.test_session.start',
      resourceType: 'call',
      resourceId: call.id,
      metadata: {
        agent_id: input.agentId,
        version_id: input.agentVersionId,
        pipeline: 'standard',
        room_name: roomName,
      },
    });
    await this.invalidateCallList(input.workspaceId, input.agentId);

    return {
      call_id: call.id,
      test_session_id: roomName,
      pipeline: 'standard',
      web_socket_url: null,
      livekit_url: livekit.livekitUrl,
      room_name: roomName,
      token,
      // The browser token, not the agent session, bounds the test window.
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
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
      select: { organizationId: true, retentionDays: true },
    });
    const allowed = await this.billing.checkFeatureGate(ws.organizationId, 'outbound');
    if (!allowed) {
      throw new ForbiddenPlanError('Outbound calls require a paid plan.');
    }

    // Idempotency: prevent double-click double-call within 60s
    const recentDuplicate = await this.findRecentOutboundDuplicate(workspaceId, agentId, dto.to_number);
    if (recentDuplicate) {
      return this.toSummary(recentDuplicate);
    }

    const { agent, version, voice } = await this.resolveAgentVersion(
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
        payload: {
          reasons: checkResult.reasons,
          to_number: dto.to_number,
          // No call row exists yet; the compliance check ID is the opaque
          // per-event scope ID for downstream analytics.
          compliance_check_id: checkResult.id,
        },
      });
      throw new ComplianceBlockedError({ reasons: checkResult.reasons });
    }

    const dedupeKey = this.outboundDedupeKey(workspaceId, agent.id, dto.to_number);
    const lockAcquired = await this.cache.acquireLock(dedupeKey, 60);
    if (!lockAcquired) {
      const duplicate = await this.findRecentOutboundDuplicate(workspaceId, agent.id, dto.to_number);
      if (duplicate) return this.toSummary(duplicate);
      throw new AppError(
        'RATE_LIMITED',
        'An outbound call to this number is already being started. Please retry in a few seconds.',
        409,
      );
    }

    const duplicateAfterLock = await this.findRecentOutboundDuplicate(workspaceId, agent.id, dto.to_number);
    if (duplicateAfterLock) {
      return this.toSummary(duplicateAfterLock);
    }

    const expiresAt = new Date(new Date().getTime() + ws.retentionDays * 24 * 60 * 60 * 1000);

    // The call row is created before dispatch because the concurrency lease,
    // the credit reservation, and the usage record are all keyed to it. It
    // starts as `queued` and is only advanced once the provider accepts.
    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: ws.organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        contactId: checkResult.contact_id,
        direction: 'outbound',
        status: 'queued',
        provider: voice.name,
        toNumber: dto.to_number,
        fromNumber: dto.from_number ?? null,
        contactName: dto.contact_name ?? null,
        startedAt: new Date(),
        expiresAt,
        retentionDays: ws.retentionDays,
        metadata: (dto.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });

    const admission = await this.admission.admitCall({
      organizationId: ws.organizationId,
      workspaceId,
      callId: call.id,
      provider: voice.name,
      direction: 'outbound',
    });
    if (isCallDenied(admission)) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: admission.reason },
      });
      throw this.admission.toError(admission);
    }

    await this.persistPipeline(ws.organizationId, call.id);

    let result: Awaited<ReturnType<VoiceRuntimeProvider['startOutboundCall']>>;
    try {
      result = await voice.startOutboundCall({
        workspaceId,
        agentId: agent.id,
        agentVersionId: version.id,
        toNumber: dto.to_number,
        fromNumber: dto.from_number,
        contactName: dto.contact_name,
        metadata: dto.metadata,
      });
    } catch (err) {
      // The provider never took the call, so the customer keeps the reserved
      // minute and the concurrency slot is returned immediately.
      await this.admission.compensate(ws.organizationId, call.id, 'provider_dispatch_failed');
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'provider_dispatch_failed' },
      });
      throw err;
    }

    const dispatched = await this.prisma.call.update({
      where: { id: call.id },
      data: { status: result.status, providerCallId: result.provider_call_id },
    });
    await this.prisma.callUsage.updateMany({
      where: { callId: call.id },
      data: { providerCallId: result.provider_call_id },
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
    await this.invalidateCallList(workspaceId, agent.id);

    return this.toSummary(dispatched);
  }

  async list(workspaceId: string, agentId?: string): Promise<CallSummary[]> {
    const key = this.callListKey(workspaceId, agentId);
    const cached = await this.cache.get<CallSummary[]>(key);
    if (cached !== null) return cached;

    const rows = await this.prisma.call.findMany({
      where: { workspaceId, ...(agentId ? { agentId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const summaries = rows.map((r) => this.toSummary(r));
    await this.cache.set(key, summaries, CALL_LIST_TTL_SECONDS);
    return summaries;
  }

  /**
   * Returns existing CallEvent rows for backfill when a client connects to SSE.
   */
  async getLiveEvents(callId: string, workspaceId: string): Promise<Array<Record<string, unknown>>> {
    // `Call.id` is a `@db.Uuid` column, so a non-UUID id makes Prisma throw
    // instead of returning no rows. Treat a malformed id as no backfill.
    if (!isUuid(callId)) return [];
    const call = await this.prisma.call.findFirst({ where: { id: callId, workspaceId } });
    if (!call) return [];
    const events = await this.prisma.callEvent.findMany({
      where: { callId },
      orderBy: { eventTime: 'asc' },
      select: { eventType: true, eventTime: true, payload: true },
    });
    return events.map((e) => ({
      type: e.eventType,
      call_id: callId,
      event_time: e.eventTime.toISOString(),
      data: e.payload,
    }));
  }

  async get(workspaceId: string, callId: string): Promise<CallDetail> {
    // `Call.id` is a `@db.Uuid` column, so a non-UUID id makes Prisma throw
    // instead of returning no rows. A malformed id is a missing call, not a 500.
    if (!isUuid(callId)) throw new CallNotFoundError(callId);
    const call = await this.prisma.call.findFirst({
      where: { id: callId, workspaceId },
      include: { agent: { select: { name: true } } },
    });
    if (!call) throw new CallNotFoundError(callId);

    // Use persisted transcript first (written on call.ended), fallback to provider
    let turns: CallTurn[] = [];
    if (call.transcriptText && call.status === 'completed') {
      // Reconstruct turns from persisted transcript if available
      // This avoids re-fetching from the voice provider on every GET
      const voice = this.voiceForProviderName(call.provider);
      const t = await voice.getTranscript({ callId: call.providerCallId ?? call.id });
      turns = t.turns;
    } else if (call.providerCallId) {
      try {
        const voice = this.voiceForProviderName(call.provider);
        const t = await voice.getTranscript({ callId: call.providerCallId });
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
        const voice = this.voiceForProviderName(call.provider);
        await voice.endCall({ callId: call.providerCallId, reason: 'user_requested' });
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
    } catch {
      // best-effort queueing
    }

    // Phase 9: record usage
    await this.recordUsage(workspaceId, updated.id, updated.direction, durationSeconds);
    await this.invalidateCallList(workspaceId, updated.agentId);

    return this.toSummary(updated);
  }

  async ingestEvent(
    provider: string,
    payload: {
      event_type: string;
      provider_call_id?: string;
      provider_event_id?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!payload.provider_call_id) return;
    if (payload.provider_event_id) {
      const duplicate = await this.prisma.callEvent.findUnique({
        where: { providerEventId: payload.provider_event_id },
        select: { id: true },
      });
      if (duplicate) return;
    }
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
        select: { organizationId: true, retentionDays: true },
      });

      const expiresAt = new Date(new Date().getTime() + ws.retentionDays * 24 * 60 * 60 * 1000);

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
          expiresAt,
          retentionDays: ws.retentionDays,
          metadata: (data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });
      await this.invalidateCallList(call.workspaceId, call.agentId);
    }

    if (!call) return;

    let callEvent;
    try {
      callEvent = await this.prisma.callEvent.create({
        data: {
          callId: call.id,
          workspaceId: call.workspaceId,
          organizationId: call.organizationId,
          providerEventId: payload.provider_event_id,
          eventType: payload.event_type,
          payload: (payload.data as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }

    // Publish to Redis Pub/Sub for real-time SSE subscribers
    await this.cache.publish(`call:${call.id}`, {
      type: payload.event_type,
      call_id: call.id,
      event_id: callEvent.id,
      event_time: callEvent.eventTime.toISOString(),
      data: payload.data,
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

      // Fetch transcript from provider if not in webhook payload
      let finalTranscriptText = transcriptText;
      if (!transcriptText && call.providerCallId) {
        try {
          const voice = this.voiceForProviderName(call.provider);
          const t = await voice.getTranscript({ callId: call.providerCallId });
          finalTranscriptText = t.transcript;
        } catch {
          // best-effort: transcript fetch failed, continue without
        }
      }

      const updated = await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: 'completed',
          endedAt,
          durationSeconds,
          ...(finalTranscriptText ? { transcriptText: finalTranscriptText } : {}),
          ...(recordingUrl ? { recordingUrl } : {}),
          ...(outcome ? { outcome } : {}),
        },
      });

      try {
        // Look up agent language for scoped opt-out matching
        const version = await this.prisma.agentVersion.findUnique({
          where: { id: call.agentVersionId ?? '' },
          select: { specJson: true },
        });
        const language = (version?.specJson as Record<string, unknown> | null)?.language as string | undefined;

        await this.compliance.processTranscriptOptOut({
          workspaceId: updated.workspaceId,
          callId: updated.id,
          direction: updated.direction,
          contactId: updated.contactId,
          fromNumber: updated.fromNumber,
          toNumber: updated.toNumber,
          transcript: updated.transcriptText,
          language,
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
      } catch {
        // best-effort queueing
      }

      // Phase 9: record usage for provider-driven call completion
      await this.recordUsage(call.workspaceId, updated.id, updated.direction, durationSeconds);
      await this.invalidateCallList(updated.workspaceId, updated.agentId);
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
    // Only call createAgent if providerRuntimeId not yet persisted (idempotent on provider side).
    const voice = await this.voiceForVersion(workspaceId, version);
    if (!version.providerRuntimeId) {
      try {
        await voice.createAgent({
          workspaceId,
          agentId: agent.id,
          agentVersionId: version.id,
          spec: version.specJson as unknown as AgentSpec,
        });
      } catch (err) {
        throw new AppError(
          'VOICE_PROVIDER_ERROR',
          `Failed to create voice agent: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
      }
    }

    return { agent, version, voice };
  }

  private voiceForProviderName(provider: string | null | undefined): VoiceRuntimeProvider {
    return this.voiceRegistry?.byName(provider) ?? this.voice;
  }

  private async voiceForVersion(
    workspaceId: string,
    version: { provider?: string | null },
  ): Promise<VoiceRuntimeProvider> {
    if (version.provider) return this.voiceForProviderName(version.provider);
    if (!this.voiceRegistry) return this.voice;

    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const subscription = await this.billing.getSubscription(ws.organizationId);
    let plan = subscription?.plan ?? 'free';
    if (
      subscription?.status === 'trialing' &&
      subscription.trialEnd &&
      new Date(subscription.trialEnd) < new Date()
    ) {
      plan = 'free';
    }
    return this.voiceRegistry.forPlan(plan);
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

  private async findRecentOutboundDuplicate(
    workspaceId: string,
    agentId: string,
    toNumber: string,
  ) {
    return this.prisma.call.findFirst({
      where: {
        workspaceId,
        agentId,
        toNumber,
        createdAt: { gt: new Date(Date.now() - 60000) },
      },
    });
  }

  private outboundDedupeKey(workspaceId: string, agentId: string, toNumber: string): string {
    const normalizedNumber = toNumber.replace(/[^+\dA-Za-z_-]/g, '_');
    return `calls:outbound:dedupe:${workspaceId}:${agentId}:${normalizedNumber}`;
  }

  private callListKey(workspaceId: string, agentId?: string): string {
    return `calls:list:${workspaceId}:${agentId ?? 'all'}`;
  }

  private async invalidateCallList(workspaceId: string, agentId?: string | null): Promise<void> {
    await Promise.all([
      this.cache.del(this.callListKey(workspaceId)),
      agentId ? this.cache.del(this.callListKey(workspaceId, agentId)) : Promise.resolve(),
    ]);
  }

  private toSummary(c: {
    id: string;
    workspaceId: string;
    agentId: string;
    agentVersionId: string | null;
    direction: string;
    status: string;
    provider: string;
    pipeline?: string | null;
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
      // The column is a plain string in the database (constrained by a CHECK),
      // and historical rows predate routing entirely, so an unset or unexpected
      // value is reported as null rather than guessed at.
      pipeline: this.toPipeline(c.pipeline),
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

  private toPipeline(value: string | null | undefined): CallSummary['pipeline'] {
    return value === 'realtime' || value === 'standard' ? value : null;
  }
}
