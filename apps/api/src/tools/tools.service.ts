import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateToolDto,
  InvokeToolDto,
  ToolDetail,
  ToolInvocationDetail,
  ToolInvocationSummary,
  ToolSummary,
  ToolType,
  UpdateToolDto,
  WebhookConfig,
} from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import {
  AgentNotFoundError,
  ComplianceBlockedError,
  ToolExecutionFailedError,
  ToolInputInvalidError,
  ToolNotFoundError,
} from '../common/errors';
import { ComplianceService } from '../compliance/compliance.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateToolInput } from './input-validator';
import { WebhookExecutor } from './webhook-executor';
import { GoogleCalendarExecutor } from './executors/google-calendar.executor';
import { GmailExecutor } from './executors/gmail.executor';
import { SheetsExecutor } from './executors/sheets.executor';
import { CrmExecutor, type CrmContactArgs, type CrmProvider } from './crm-executor';

type ToolCrmProvider = Exclude<CrmProvider, 'generic_webhook'>;

/** Loose “looks like an email address” shape used to find contact references
 * inside exported row values. Deliberately permissive: false positives only
 * cost one indexed contact lookup. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tenant scope for an execution. Executors that resolve credentials at call
 * time (Gmail, Sheets) need the workspace id; config never carries tokens.
 */
export interface ToolExecutionContext {
  workspaceId: string;
}

export interface ToolExecutor {
  readonly name: string;
  execute(
    params: Record<string, unknown>,
    config: Record<string, string>,
    context?: ToolExecutionContext,
  ): Promise<ToolCallResult>;
}

export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

@Injectable()
export class ToolsService {
  private readonly executors: Map<string, ToolExecutor>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly webhookExecutor: WebhookExecutor,
    private readonly googleCalendarExecutor: GoogleCalendarExecutor,
    private readonly gmailExecutor: GmailExecutor,
    private readonly sheetsExecutor: SheetsExecutor,
    private readonly crmExecutor?: CrmExecutor,
    private readonly billing?: BillingService,
    private readonly compliance?: ComplianceService,
  ) {
    this.executors = new Map<string, ToolExecutor>([
      ['webhook', webhookExecutor],
      ['http_post', webhookExecutor],
      ['http_get', webhookExecutor],
      [googleCalendarExecutor.name, googleCalendarExecutor],
      [gmailExecutor.name, gmailExecutor],
      [sheetsExecutor.name, sheetsExecutor],
    ]);
    if (crmExecutor) {
      this.executors.set('crm', {
        name: 'crm',
        execute: async (params, config) => this.executeCrmTool(params, config),
      });
    }
  }

  async list(workspaceId: string, agentId?: string | null): Promise<ToolSummary[]> {
    const rows = await this.prisma.integrationTool.findMany({
      where: {
        workspaceId,
        ...(agentId === undefined ? {} : { agentId }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toSummary(r));
  }

  async get(workspaceId: string, toolId: string): Promise<ToolDetail> {
    const row = await this.prisma.integrationTool.findFirst({
      where: { id: toolId, workspaceId },
    });
    if (!row) throw new ToolNotFoundError(toolId);
    return this.toDetail(row);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: CreateToolDto,
  ): Promise<ToolDetail> {
    await this.assertToolsAllowed(workspaceId);

    if (dto.agent_id) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: dto.agent_id, workspaceId },
      });
      if (!agent) throw new AgentNotFoundError(dto.agent_id);
    }

    const row = await this.prisma.integrationTool.create({
      data: {
        workspaceId,
        organizationId: await this.prisma.organizationIdFor(workspaceId),
        agentId: dto.agent_id ?? null,
        name: dto.name,
        description: dto.description,
        toolType: dto.tool_type,
        config: dto.config as Prisma.InputJsonValue,
        inputSchema: dto.input_schema as Prisma.InputJsonValue,
        enabled: dto.enabled,
        createdBy: actorUserId,
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'tool.create',
      resourceType: 'integration_tool',
      resourceId: row.id,
      metadata: { name: dto.name, tool_type: dto.tool_type },
    });
    return this.toDetail(row);
  }

  async update(
    workspaceId: string,
    toolId: string,
    actorUserId: string,
    dto: UpdateToolDto,
  ): Promise<ToolDetail> {
    const existing = await this.prisma.integrationTool.findFirst({
      where: { id: toolId, workspaceId },
    });
    if (!existing) throw new ToolNotFoundError(toolId);

    if (dto.agent_id !== undefined && dto.agent_id !== null) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: dto.agent_id, workspaceId },
      });
      if (!agent) throw new AgentNotFoundError(dto.agent_id);
    }

    const row = await this.prisma.integrationTool.update({
      where: { id: toolId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.tool_type !== undefined ? { toolType: dto.tool_type } : {}),
        ...(dto.agent_id !== undefined ? { agentId: dto.agent_id } : {}),
        ...(dto.config !== undefined
          ? { config: dto.config as Prisma.InputJsonValue }
          : {}),
        ...(dto.input_schema !== undefined
          ? { inputSchema: dto.input_schema as Prisma.InputJsonValue }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'tool.update',
      resourceType: 'integration_tool',
      resourceId: row.id,
    });
    return this.toDetail(row);
  }

  async remove(workspaceId: string, toolId: string, actorUserId: string): Promise<void> {
    const existing = await this.prisma.integrationTool.findFirst({
      where: { id: toolId, workspaceId },
    });
    if (!existing) throw new ToolNotFoundError(toolId);

    await this.prisma.integrationTool.delete({ where: { id: toolId } });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'tool.delete',
      resourceType: 'integration_tool',
      resourceId: toolId,
    });
  }

  async invoke(
    workspaceId: string,
    toolId: string,
    actorUserId: string | null,
    dto: InvokeToolDto,
  ): Promise<ToolInvocationDetail> {
    const tool = await this.prisma.integrationTool.findFirst({
      where: { id: toolId, workspaceId },
    });
    if (!tool) throw new ToolNotFoundError(toolId);
    if (!tool.enabled) {
      throw new ToolExecutionFailedError(`Tool ${tool.name} is disabled.`);
    }
    await this.assertToolsAllowed(workspaceId);

    const validation = validateToolInput(
      tool.inputSchema as Parameters<typeof validateToolInput>[0],
      dto.arguments ?? {},
    );
    if (!validation.valid) {
      throw new ToolInputInvalidError({ errors: validation.errors });
    }

    // Compliance gate: outbound communications and data exports are checked
    // centrally, before the invocation row is created and before any token
    // resolution or provider call, and block on failure. Blocks are audited
    // with reason codes only — never the recipient or message content.
    try {
      if (tool.toolType === 'gmail') {
        await this.assertOutboundEmailAllowed(workspaceId, dto.arguments ?? {});
      } else if (tool.toolType === 'google_sheets') {
        await this.assertDataExportAllowed(workspaceId, dto.arguments ?? {});
      }
    } catch (err) {
      if (err instanceof ComplianceBlockedError) {
        await this.logBlockedInvocation(workspaceId, actorUserId, tool.id, tool.toolType, err);
      }
      throw err;
    }

    const invocation = await this.prisma.toolInvocation.create({
      data: {
        workspaceId,
        organizationId: await this.prisma.organizationIdFor(workspaceId),
        toolId: tool.id,
        agentId: dto.agent_id ?? tool.agentId,
        callId: dto.call_id ?? null,
        status: 'pending',
        requestPayload: (dto.arguments as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    const exec = this.executors.get(tool.toolType as string);
    if (!exec) {
      const errorMessage = `Tool type ${tool.toolType} is not supported for execution.`;
      const failed = await this.prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage,
        },
      });
      await this.logInvocation(workspaceId, actorUserId, failed.id, tool.id, 'failed');
      throw new ToolExecutionFailedError(errorMessage, { tool_type: tool.toolType });
    }

    try {
      const result = await exec.execute(
        dto.arguments ?? {},
        tool.config as Record<string, string>,
        { workspaceId },
      );
      const status = result.success ? 'success' : 'failed';
      const updated = await this.prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: {
          status,
          finishedAt: new Date(),
          responseBody: this.serializeResponse(result.result),
          errorMessage: result.error ?? null,
        },
      });
      await this.logInvocation(workspaceId, actorUserId, updated.id, tool.id, status);
      return this.toInvocationDetail(updated);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const updated = await this.prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage,
        },
      });
      await this.logInvocation(workspaceId, actorUserId, updated.id, tool.id, 'failed');
      throw new ToolExecutionFailedError(errorMessage);
    }
  }

  /**
   * Invoke a tool by its workspace-unique name. Used by the internal LiveKit
   * endpoint, where the runtime knows tool names from the Agent Spec but not
   * tool ids. Reuses the id-based path so invocation logging and auditing
   * behave identically.
   */
  async invokeByName(
    workspaceId: string,
    toolName: string,
    actorUserId: string | null,
    dto: InvokeToolDto,
    expectedToolType?: ToolType,
  ): Promise<ToolInvocationDetail> {
    // Only workspace-wide tools (agentId null) or tools owned by the
    // requesting agent are eligible — an agent must not be able to invoke a
    // sibling agent's private tool by name. When the caller declares the tool
    // type it expects (from the Agent Spec), the lookup enforces it too, so a
    // Gmail-declared spec tool can never resolve to a same-named webhook or
    // CRM tool that happens to exist in the workspace.
    const tool = await this.prisma.integrationTool.findFirst({
      where: {
        workspaceId,
        name: toolName,
        ...(expectedToolType ? { toolType: expectedToolType } : {}),
        OR: [{ agentId: null }, ...(dto.agent_id ? [{ agentId: dto.agent_id }] : [])],
      },
      select: { id: true },
    });
    if (!tool) throw new ToolNotFoundError(toolName);
    return this.invoke(workspaceId, tool.id, actorUserId, dto);
  }

  async listInvocations(
    workspaceId: string,
    filters: { toolId?: string; agentId?: string; callId?: string } = {},
  ): Promise<ToolInvocationSummary[]> {
    const rows = await this.prisma.toolInvocation.findMany({
      where: {
        workspaceId,
        ...(filters.toolId ? { toolId: filters.toolId } : {}),
        ...(filters.agentId ? { agentId: filters.agentId } : {}),
        ...(filters.callId ? { callId: filters.callId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toInvocationSummary(r));
  }

  private async logInvocation(
    workspaceId: string,
    actorUserId: string | null,
    invocationId: string,
    toolId: string,
    status: 'success' | 'failed',
  ) {
    await this.audit.log({
      workspaceId,
      actorUserId: actorUserId ?? undefined,
      action: status === 'success' ? 'tool.invoke.success' : 'tool.invoke.failed',
      resourceType: 'tool_invocation',
      resourceId: invocationId,
      metadata: { tool_id: toolId },
    });
  }

  private serializeResponse(body: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (body == null) return Prisma.JsonNull;
    if (typeof body === 'string') return { text: body };
    return body as Prisma.InputJsonValue;
  }

  /**
   * Blocks outbound email to contacts who opted out. The recipient is taken
   * from the validated tool arguments; the schema already requires `to`.
   */
  private async assertOutboundEmailAllowed(
    workspaceId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!this.compliance) return;
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    if (!to) return;
    const result = await this.compliance.checkOutboundEmail(workspaceId, to);
    if (!result.allowed) {
      throw new ComplianceBlockedError({ reasons: result.reasons });
    }
  }

  /**
   * Blocks Sheets appends that would export data about opted-out contacts.
   * Email-shaped values in the appended row identify the contacts involved;
   * a row referencing an opted-out contact is refused.
   */
  private async assertDataExportAllowed(
    workspaceId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (typeof this.compliance?.checkDataExport !== 'function') return;
    const values = Array.isArray(args.values) ? args.values : [];
    const emails = values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => EMAIL_SHAPE.test(value));
    const result = await this.compliance.checkDataExport(workspaceId, emails);
    if (!result.allowed) {
      throw new ComplianceBlockedError({ reasons: result.reasons });
    }
  }

  /**
   * Records a compliance block in the audit trail. Only the tool identity
   * and machine-readable reason codes are stored — never the recipient
   * address, row values, or message content.
   */
  private async logBlockedInvocation(
    workspaceId: string,
    actorUserId: string | null,
    toolId: string,
    toolType: string,
    err: ComplianceBlockedError,
  ): Promise<void> {
    const rawReasons = err.details?.reasons;
    const reasonCodes = Array.isArray(rawReasons)
      ? rawReasons
          .map((reason) => (reason as { code?: unknown }).code)
          .filter((code): code is string => typeof code === 'string')
      : [];
    await this.audit.log({
      workspaceId,
      actorUserId: actorUserId ?? undefined,
      action: 'tool.invoke.blocked',
      resourceType: 'integration_tool',
      resourceId: toolId,
      metadata: { tool_id: toolId, tool_type: toolType, reason_codes: reasonCodes },
    });
  }

  private async assertToolsAllowed(workspaceId: string): Promise<void> {
    if (typeof this.billing?.checkFeatureGate !== 'function') return;
    const organizationId = await this.prisma.organizationIdFor(workspaceId);
    const allowed = await this.billing.checkFeatureGate(organizationId, 'tools');
    if (!allowed) {
      throw new ForbiddenPlanError(
        'Integration tools require a paid plan. Free workspaces can use Vapi calling without external tools.',
      );
    }
  }

  private toSummary(row: {
    id: string;
    workspaceId: string;
    agentId: string | null;
    name: string;
    description: string;
    toolType: string;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): ToolSummary {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      name: row.name,
      description: row.description,
      tool_type: row.toolType as ToolType,
      enabled: row.enabled,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private toDetail(row: {
    id: string;
    workspaceId: string;
    agentId: string | null;
    name: string;
    description: string;
    toolType: string;
    enabled: boolean;
    config: Prisma.JsonValue;
    inputSchema: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }): ToolDetail {
    if (
      row.toolType === 'google_calendar' ||
      row.toolType === 'gmail' ||
      row.toolType === 'google_sheets'
    ) {
      // Google tool configs identify operation and target only — OAuth tokens
      // are resolved from the workspace's unified connection at invocation time.
      return {
        ...this.toSummary(row),
        config: (row.config ?? {}) as ToolDetail['config'],
        input_schema: row.inputSchema as ToolDetail['input_schema'],
      };
    }

    if (row.toolType === 'crm') {
      const cfg = (row.config ?? {}) as {
        provider?: string;
        api_key?: string;
        base_url?: string;
        object_type?: string;
      };
      const { api_key, ...publicCfg } = cfg;
      return {
        ...this.toSummary(row),
        config: {
          provider: crmProvider(publicCfg.provider) ?? 'generic',
          object_type: publicCfg.object_type ?? 'contact',
          ...(publicCfg.base_url ? { base_url: publicCfg.base_url } : {}),
          api_key_set: Boolean(api_key),
        },
        input_schema: row.inputSchema as ToolDetail['input_schema'],
      };
    }

    const cfg = (row.config ?? {}) as WebhookConfig & { hmac_secret?: string };
    const { hmac_secret, ...publicCfg } = cfg;
    return {
      ...this.toSummary(row),
      config: { ...publicCfg, hmac_secret_set: Boolean(hmac_secret) },
      input_schema: row.inputSchema as ToolDetail['input_schema'],
    };
  }

  private toInvocationSummary(row: {
    id: string;
    workspaceId: string;
    toolId: string;
    agentId: string | null;
    callId: string | null;
    status: string;
    responseStatus: number | null;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
    errorMessage: string | null;
  }): ToolInvocationSummary {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      tool_id: row.toolId,
      agent_id: row.agentId,
      call_id: row.callId,
      status: row.status as ToolInvocationSummary['status'],
      response_status: row.responseStatus,
      duration_ms: row.durationMs,
      started_at: row.startedAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
      error_message: row.errorMessage,
    };
  }

  private toInvocationDetail(row: {
    id: string;
    workspaceId: string;
    toolId: string;
    agentId: string | null;
    callId: string | null;
    status: string;
    responseStatus: number | null;
    responseBody: Prisma.JsonValue | null;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
    errorMessage: string | null;
    requestPayload: Prisma.JsonValue;
  }): ToolInvocationDetail {
    return {
      ...this.toInvocationSummary(row),
      request_payload: (row.requestPayload as Record<string, unknown>) ?? {},
      response_body: row.responseBody ?? null,
    };
  }

  private async executeCrmTool(
    params: Record<string, unknown>,
    config: Record<string, string>,
  ): Promise<ToolCallResult> {
    if (!this.crmExecutor) {
      return { success: false, error: 'CRM executor is not configured.' };
    }
    const provider = crmProvider(config.provider);
    if (!provider) {
      return { success: false, error: 'CRM provider must be pipedrive, hubspot, salesforce, or generic.' };
    }
    const fullName = stringParam(params.full_name) ?? stringParam(params.name);
    if (!fullName) {
      return { success: false, error: 'full_name is required.' };
    }
    const args: CrmContactArgs = { full_name: fullName };
    const phone = stringParam(params.phone);
    const email = stringParam(params.email);
    const notes = stringParam(params.notes);
    const company = stringParam(params.company);
    if (phone) args.phone = phone;
    if (email) args.email = email;
    if (notes) args.notes = notes;
    if (company) args.company = company;
    const result = await this.crmExecutor.createContact(provider, config, args);
    return { success: true, result };
  }
}

function crmProvider(value: unknown): ToolCrmProvider | null {
  return value === 'pipedrive' || value === 'hubspot' || value === 'salesforce' || value === 'generic'
    ? value
    : null;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
