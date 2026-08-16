import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { AgentGenSession as PrismaAgentGenSession } from '@prisma/client';
import {
  AgentSpecSchema,
  type AgentGenMessage,
  type AgentGenSession,
  type AgentSpec,
  type FinalizeGenSessionDto,
  type SendGenMessageDto,
} from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QueueService } from '../queue/queue.service';
import { AgentsService } from '../agents/agents.service';
import { AppError, AgentSpecInvalidError } from '../common/errors';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from '../llm/llm.provider.interface';
import { env } from '../config/env';

export const AGENT_GEN_QUEUE = 'agent-gen';
export const AGENT_GEN_JOB = 'generate';
export const AGENT_GEN_JOB_ATTEMPTS = 2;

export class GenSessionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super('NOT_FOUND', `Generation session ${sessionId} not found.`, HttpStatus.NOT_FOUND, {
      sessionId,
    });
  }
}

/** 409 while a generation job is in flight for the session. */
export class GenSessionBusyError extends HttpException {
  constructor(sessionId: string) {
    super(
      {
        code: 'INVALID_STATUS',
        message: 'A generation is already in progress for this session.',
        details: { sessionId },
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class GenSessionInvalidStateError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_STATUS', message, HttpStatus.BAD_REQUEST, details);
  }
}

export interface AgentGenJobPayload {
  sessionId: string;
  workspaceId: string;
  template_slug?: string;
}

/**
 * Server-persisted chat-to-agent generation sessions.
 *
 * State machine (per session):
 *   awaiting_user --sendMessage--> generating --worker ok--> awaiting_user
 *                                  generating --worker err-> failed
 *   failed --sendMessage--> generating (retry keeps history + last spec)
 *   awaiting_user/failed --finalize (spec valid)--> completed
 *
 * All state lives in Postgres so a page refresh mid-generation resumes
 * cleanly: the client re-reads the session and keeps polling.
 */
@Injectable()
export class AgentGenService {
  private readonly logger = new Logger(AgentGenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly agents: AgentsService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmAgentGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async createSession(workspaceId: string, userId: string): Promise<AgentGenSession> {
    // One active (non-completed) session per user per workspace: reuse the
    // most recent one instead of piling up abandoned rows.
    const existing = await this.findActiveRow(workspaceId, userId);
    if (existing) return this.serialize(await this.sweepIfStale(existing));

    const organizationId = await this.prisma.organizationIdFor(workspaceId);
    const row = await this.prisma.agentGenSession.create({
      data: { workspaceId, organizationId, userId },
    });
    return this.serialize(row);
  }

  async getActiveSession(workspaceId: string, userId: string): Promise<AgentGenSession | null> {
    const row = await this.findActiveRow(workspaceId, userId);
    if (!row) return null;
    return this.serialize(await this.sweepIfStale(row));
  }

  async getSession(workspaceId: string, userId: string, sessionId: string): Promise<AgentGenSession> {
    const row = await this.findOwnedRow(workspaceId, userId, sessionId);
    return this.serialize(await this.sweepIfStale(row));
  }

  async deleteSession(workspaceId: string, userId: string, sessionId: string): Promise<void> {
    await this.findOwnedRow(workspaceId, userId, sessionId);
    await this.prisma.agentGenSession.delete({ where: { id: sessionId } });
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  async sendMessage(
    workspaceId: string,
    userId: string,
    sessionId: string,
    dto: SendGenMessageDto,
  ): Promise<AgentGenSession> {
    const row = await this.sweepIfStale(await this.findOwnedRow(workspaceId, userId, sessionId));

    if (row.status === 'generating') throw new GenSessionBusyError(sessionId);
    if (row.status === 'completed') {
      throw new GenSessionInvalidStateError('This session is already completed. Start a new one.');
    }

    const content = this.composeMessageContent(dto);
    const messages = [...this.parseMessages(row.messages)];
    messages.push({ role: 'user', content, at: new Date().toISOString() });

    const updated = await this.prisma.agentGenSession.update({
      where: { id: row.id },
      data: {
        status: 'generating',
        generatingAt: new Date(),
        lastError: null,
        messages: messages as unknown as object,
      },
    });

    const payload: AgentGenJobPayload = {
      sessionId: row.id,
      workspaceId,
      template_slug: dto.context?.template_slug,
    };
    await this.queue.queue(AGENT_GEN_QUEUE).add(AGENT_GEN_JOB, payload, {
      attempts: AGENT_GEN_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });

    return this.serialize(updated);
  }

  /**
   * Worker entrypoint: runs the LLM turn for a session. Idempotent — only
   * processes sessions still in 'generating' (a BullMQ retry after a
   * successful run is a no-op).
   */
  async processGeneration(payload: AgentGenJobPayload, isFinalAttempt: boolean): Promise<void> {
    const row = await this.prisma.agentGenSession.findUnique({ where: { id: payload.sessionId } });
    if (!row || row.status !== 'generating') return;

    try {
      const history = this.parseMessages(row.messages);
      const result = await this.llm.chatGenerate({
        messages: history,
        currentSpec: row.currentSpec ?? undefined,
        template_slug: payload.template_slug,
      });

      const messages = [
        ...history,
        { role: 'assistant' as const, content: result.assistant_message, at: new Date().toISOString() },
      ];
      await this.prisma.agentGenSession.update({
        where: { id: row.id },
        data: {
          status: 'awaiting_user',
          generatingAt: null,
          messages: messages as unknown as object,
          currentSpec: result.spec as unknown as object,
          specValid: true,
          lastError: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[agent-gen] generation failed for session ${row.id}: ${message}`);
      if (!isFinalAttempt) throw err; // let BullMQ retry with backoff
      await this.markFailed(row.id, message);
    }
  }

  /** Marks a session failed; used by the worker's terminal failure path. */
  async markFailed(sessionId: string, error: string): Promise<void> {
    await this.prisma.agentGenSession.updateMany({
      where: { id: sessionId, status: 'generating' },
      data: {
        status: 'failed',
        generatingAt: null,
        lastError: error.slice(0, 2000),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Finalize
  // -------------------------------------------------------------------------

  async finalize(
    workspaceId: string,
    userId: string,
    sessionId: string,
    dto: FinalizeGenSessionDto,
  ) {
    const row = await this.sweepIfStale(await this.findOwnedRow(workspaceId, userId, sessionId));

    if (row.status === 'generating') throw new GenSessionBusyError(sessionId);
    if (row.status === 'completed') {
      throw new GenSessionInvalidStateError('This session was already finalized.', {
        agentId: row.agentId,
      });
    }

    const specSource = dto.spec_override ?? row.currentSpec;
    if (!specSource) {
      throw new GenSessionInvalidStateError('No spec to finalize. Chat with the assistant first.');
    }
    const parsed = AgentSpecSchema.safeParse(specSource);
    if (!parsed.success) throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });
    const spec: AgentSpec = parsed.data;

    const agent = await this.agents.create(workspaceId, userId, {
      name: spec.name,
      industry: spec.industry,
      agent_type: spec.agent_type,
      spec,
    });

    if (dto.publish) {
      await this.agents.publish(workspaceId, agent.id, userId);
    }

    const updated = await this.prisma.agentGenSession.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        agentId: agent.id,
        ...(dto.spec_override ? { currentSpec: spec as unknown as object, specValid: true } : {}),
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId: userId,
      action: 'agent.generate.finalize',
      resourceType: 'agent',
      resourceId: agent.id,
      metadata: { session_id: row.id, published: Boolean(dto.publish) },
    });

    return { session: this.serialize(updated), agent };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async findActiveRow(workspaceId: string, userId: string) {
    return this.prisma.agentGenSession.findFirst({
      where: { workspaceId, userId, status: { in: ['awaiting_user', 'generating', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async findOwnedRow(workspaceId: string, userId: string, sessionId: string) {
    const row = await this.prisma.agentGenSession.findFirst({
      where: { id: sessionId, workspaceId, userId },
    });
    if (!row) throw new GenSessionNotFoundError(sessionId);
    return row;
  }

  /**
   * Lazy stale sweep: a session stuck in 'generating' past the deadline
   * (crashed worker, lost job) is failed on the next read so the client can
   * offer a retry instead of polling forever.
   */
  private async sweepIfStale(row: PrismaAgentGenSession): Promise<PrismaAgentGenSession> {
    if (row.status !== 'generating' || !row.generatingAt) return row;
    const ageMs = Date.now() - row.generatingAt.getTime();
    if (ageMs < env.AGENT_GEN_STALE_AFTER_SECONDS * 1_000) return row;

    this.logger.warn(`[agent-gen] session ${row.id} stale after ${Math.round(ageMs / 1000)}s; marking failed`);
    await this.markFailed(row.id, 'Generation timed out. Please try again.');
    return (await this.prisma.agentGenSession.findUnique({ where: { id: row.id } })) ?? row;
  }

  /**
   * The context drawer (template, business info, voice, CRM) is folded into
   * the message content the model sees, so it needs no schema of its own and
   * survives in the conversation history.
   */
  private composeMessageContent(dto: SendGenMessageDto): string {
    const ctx = dto.context;
    if (!ctx) return dto.content;
    const lines = [
      ctx.business_name ? `Business name: ${ctx.business_name}` : '',
      ctx.timezone ? `Timezone: ${ctx.timezone}` : '',
      ctx.call_direction ? `Call direction: ${ctx.call_direction}` : '',
      ctx.crm_providers?.length ? `CRM integrations: ${ctx.crm_providers.join(', ')}` : '',
      ctx.voice_config?.stt_model ? `Preferred STT model: ${ctx.voice_config.stt_model}` : '',
      ctx.voice_config?.tts_voice ? `Preferred TTS voice: ${ctx.voice_config.tts_voice}` : '',
      ctx.knowledge_source_ids?.length
        ? `Attach these knowledge_source_ids on knowledge.source_ids: ${JSON.stringify(ctx.knowledge_source_ids)}`
        : '',
    ].filter(Boolean);
    if (lines.length === 0) return dto.content;
    return `${dto.content}\n\n[Context]\n${lines.join('\n')}`;
  }

  private parseMessages(raw: unknown): AgentGenMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw as AgentGenMessage[];
  }

  private serialize(row: PrismaAgentGenSession): AgentGenSession {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      status: row.status as AgentGenSession['status'],
      messages: this.parseMessages(row.messages),
      current_spec: row.currentSpec ?? null,
      spec_valid: row.specValid,
      agent_id: row.agentId ?? null,
      last_error: row.lastError ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
