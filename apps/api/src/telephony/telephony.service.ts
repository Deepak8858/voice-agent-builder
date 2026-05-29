import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AssignPhoneNumberAgentDto,
  CreateTelephonyConnectionDto,
  ImportPhoneNumbersDto,
  ManualPhoneNumberDto,
  ProviderCredentials,
  StartTelephonyOutboundCallDto,
  SyncedProviderPhoneNumber,
} from '@voiceforge/shared';
import { AppError, ComplianceBlockedError } from '../common/errors';
import { env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EncryptionService } from '../security/encryption.service';
import { LiveKitService } from '../livekit/livekit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from './providers/provider-registry';
import type { ConnectedPhoneNumber, NormalizedCallStatus } from './providers/provider.types';
import { TwilioProviderAdapter } from './providers/twilio.provider';

@Injectable()
export class TelephonyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
    private readonly registry: ProviderRegistry,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly compliance: ComplianceService,
    private readonly twilioFallback: TwilioProviderAdapter,
  ) {}

  providers() {
    return {
      items: [
        {
          id: 'twilio',
          name: 'Twilio',
          supportsAutomaticSync: true,
          supportsAutomaticRouting: true,
          supportsManualSetup: true,
        },
        {
          id: 'vobiz',
          name: 'Vobiz / Vobiz.ai',
          supportsAutomaticSync: true,
          supportsAutomaticRouting: true,
          supportsManualSetup: true,
        },
      ],
    };
  }

  async createConnection(workspaceId: string, actorUserId: string, dto: CreateTelephonyConnectionDto) {
    const workspace = await this.workspace(workspaceId);
    const adapter = this.registry.adapterFor(dto.provider);
    const validation = await adapter.validateCredentials(dto.credentials);
    if (!validation.valid) {
      throw new AppError(
        'PROVIDER_CREDENTIALS_INVALID',
        validation.message ?? 'Provider credentials are invalid.',
        400,
      );
    }

    const connection = await this.prisma.telephonyProviderConnection.create({
      data: {
        workspaceId,
        organizationId: workspace.organizationId,
        provider: dto.provider,
        displayName: dto.display_name,
        providerAccountId: validation.providerAccountId ?? null,
        encryptedCredentials: this.encryption.encryptJson(dto.credentials) as unknown as Prisma.InputJsonValue,
        status: 'connected',
        lastVerifiedAt: new Date(),
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.connection.create',
      resourceType: 'telephony_provider_connection',
      resourceId: connection.id,
      metadata: { provider: dto.provider },
    });

    return this.connectionDto(connection);
  }

  async listConnections(workspaceId: string) {
    const rows = await this.prisma.telephonyProviderConnection.findMany({
      where: { workspaceId, status: { not: 'disconnected' } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((row) => this.connectionDto(row)) };
  }

  async syncNumbers(workspaceId: string, connectionId: string, actorUserId: string) {
    const connection = await this.connection(workspaceId, connectionId);
    const credentials = this.encryption.decryptJson<ProviderCredentials>(connection.encryptedCredentials);
    const numbers = await this.registry.adapterFor(connection.provider as never).listPhoneNumbers(credentials);

    await this.prisma.telephonyProviderConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), status: 'connected' },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.connection.sync_numbers',
      resourceType: 'telephony_provider_connection',
      resourceId: connection.id,
      metadata: { count: numbers.length },
    });

    const items: SyncedProviderPhoneNumber[] = numbers.map((number) => ({
      provider_number_id: number.providerNumberId,
      phone_number: number.phoneNumberE164,
      friendly_name: number.friendlyName ?? null,
      requires_phone_number: !number.phoneNumberE164,
      capabilities: number.capabilities,
      metadata: number.metadata ?? {},
    }));
    return { items };
  }

  async importNumbers(workspaceId: string, actorUserId: string, dto: ImportPhoneNumbersDto) {
    const connection = await this.connection(workspaceId, dto.connection_id);
    const workspace = await this.workspace(workspaceId);
    const created = [];
    for (const number of dto.numbers) {
      const existing = await this.prisma.telephonyPhoneNumber.findUnique({
        where: { phoneNumberE164: number.phone_number },
      });
      if (existing && existing.workspaceId !== workspaceId) {
        throw new AppError(
          'PHONE_NUMBER_ALREADY_CONNECTED',
          'This phone number is already connected to another workspace.',
          409,
        );
      }

      const data = {
        providerConnectionId: connection.id,
        providerNumberId: number.provider_number_id,
        friendlyName: number.friendly_name ?? null,
        capabilities: (number.capabilities as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        providerMetadata: (number.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        status: this.importedNumberStatus(number.metadata),
        lastSyncedAt: new Date(),
      };

      const row = existing
        ? await this.prisma.telephonyPhoneNumber.update({
            where: { id: existing.id },
            data,
          })
        : await this.prisma.telephonyPhoneNumber.create({
            data: {
              ...data,
              workspaceId,
              organizationId: workspace.organizationId,
              provider: connection.provider,
              phoneNumberE164: number.phone_number,
              inboundEnabled: true,
              outboundEnabled: false,
              sipTrunkId: typeof number.metadata?.sipTrunkId === 'string' ? number.metadata.sipTrunkId : null,
            },
          });
      created.push(row);
    }
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.import',
      resourceType: 'telephony_phone_number',
      metadata: { connection_id: connection.id, count: created.length },
    });
    return { items: created.map((row) => this.phoneNumberDto(row)) };
  }

  async createManualNumber(workspaceId: string, actorUserId: string, dto: ManualPhoneNumberDto) {
    const workspace = await this.workspace(workspaceId);
    const existing = await this.prisma.telephonyPhoneNumber.findUnique({
      where: { phoneNumberE164: dto.phone_number },
    });
    if (existing) {
      throw new AppError(
        'PHONE_NUMBER_ALREADY_CONNECTED',
        'This phone number is already connected.',
        409,
      );
    }

    const row = await this.prisma.telephonyPhoneNumber.create({
      data: {
        workspaceId,
        organizationId: workspace.organizationId,
        provider: dto.provider,
        providerNumberId: dto.provider_number_id ?? dto.sip_trunk_id ?? null,
        phoneNumberE164: dto.phone_number,
        friendlyName: dto.friendly_name ?? null,
        status: 'pending_verification',
        inboundEnabled: dto.inbound_enabled,
        outboundEnabled: dto.outbound_enabled,
        sipTrunkId: dto.sip_trunk_id ?? null,
        verificationToken: cryptoRandomToken(),
        providerMetadata: {
          providerAccountId: dto.provider_account_id ?? null,
          sipTrunkDomain: dto.sip_trunk_domain ?? null,
          hasWebhookSecret: Boolean(dto.webhook_secret),
        },
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.manual_create',
      resourceType: 'telephony_phone_number',
      resourceId: row.id,
      metadata: { provider: dto.provider },
    });
    return this.phoneNumberDto(row);
  }

  async listPhoneNumbers(workspaceId: string) {
    const rows = await this.prisma.telephonyPhoneNumber.findMany({
      where: { workspaceId, status: { not: 'disconnected' } },
      include: {
        assignedAgent: { select: { id: true, name: true } },
        livekitConfig: true,
        providerConnection: { select: { id: true, displayName: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((row) => this.phoneNumberDto(row)) };
  }

  async assignAgent(workspaceId: string, numberId: string, actorUserId: string, dto: AssignPhoneNumberAgentDto) {
    const number = await this.number(workspaceId, numberId);
    if (dto.agent_id) {
      await this.agent(workspaceId, dto.agent_id);
    }
    const updated = await this.prisma.telephonyPhoneNumber.update({
      where: { id: number.id },
      data: {
        assignedAgentId: dto.agent_id,
        inboundEnabled: dto.inbound_enabled ?? number.inboundEnabled,
        outboundEnabled: dto.outbound_enabled ?? number.outboundEnabled,
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.assign_agent',
      resourceType: 'telephony_phone_number',
      resourceId: number.id,
      metadata: { agent_id: dto.agent_id },
    });
    return this.phoneNumberDto(updated);
  }

  async configureLiveKit(workspaceId: string, numberId: string, actorUserId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: numberId, workspaceId },
      include: { providerConnection: true, livekitConfig: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    if (!number.assignedAgentId) {
      throw new AppError('VALIDATION_ERROR', 'Assign an agent before configuring LiveKit.', 400);
    }
    const agent = await this.agent(workspaceId, number.assignedAgentId);

    const inbound = await this.livekit.createInboundSipTrunk({
      workspaceId,
      phoneNumberId: number.id,
      phoneNumberE164: number.phoneNumberE164,
      provider: number.provider as never,
    });

    let outboundTrunkId: string | null = null;
    if (number.outboundEnabled) {
      const metadata = this.objectMetadata(number.providerMetadata);
      const outbound = await this.livekit.createOutboundSipTrunk({
        workspaceId,
        phoneNumberId: number.id,
        phoneNumberE164: number.phoneNumberE164,
        provider: number.provider as never,
        sipAddress: typeof metadata.sipTrunkDomain === 'string' ? metadata.sipTrunkDomain : null,
      });
      outboundTrunkId = outbound.trunkId;
    }

    const roomPrefix = `${env.LIVEKIT_ROOM_PREFIX ?? 'call'}-${number.id}-`;
    const dispatch = await this.livekit.createDispatchRule({
      workspaceId,
      phoneNumberId: number.id,
      agentId: agent.id,
      trunkId: inbound.trunkId,
      roomPrefix,
      agentName: `${env.LIVEKIT_AGENT_NAME_PREFIX ?? 'voiceforge-agent'}-${agent.id}`,
      metadata: {
        provider: number.provider,
        direction: 'inbound',
        model: env.OPENAI_REALTIME_MODEL,
      },
    });

    const config = await this.prisma.liveKitTelephonyConfig.upsert({
      where: { phoneNumberId: number.id },
      create: {
        workspaceId,
        organizationId: number.organizationId,
        phoneNumberId: number.id,
        agentId: agent.id,
        livekitRoomPrefix: roomPrefix,
        livekitSipHost: this.livekit.livekitSipHost,
        inboundTrunkId: inbound.trunkId,
        outboundTrunkId,
        dispatchRuleId: dispatch.dispatchRuleId,
        status: 'configured',
      },
      update: {
        agentId: agent.id,
        livekitRoomPrefix: roomPrefix,
        livekitSipHost: this.livekit.livekitSipHost,
        inboundTrunkId: inbound.trunkId,
        outboundTrunkId,
        dispatchRuleId: dispatch.dispatchRuleId,
        status: 'configured',
      },
    });

    let providerRouting: unknown = null;
    if (number.providerConnection) {
      const credentials = this.encryption.decryptJson<ProviderCredentials>(
        number.providerConnection.encryptedCredentials,
      );
      providerRouting = await this.registry.adapterFor(number.provider as never).configureInboundRouting({
        credentials,
        phoneNumber: this.connectedNumber(number),
        livekitSipUri: `sip:${this.livekit.livekitSipHost}`,
        fallbackWebhookUrl: this.webhookUrl(`telephony/${number.provider}/fallback/${number.id}`),
        statusCallbackUrl: this.webhookUrl(`telephony/${number.provider}/status/${number.id}`),
      });
    }

    await this.prisma.telephonyPhoneNumber.update({
      where: { id: number.id },
      data: { status: 'livekit_configured' },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.livekit.configure',
      resourceType: 'telephony_phone_number',
      resourceId: number.id,
      metadata: {
        inbound_trunk_id: inbound.trunkId,
        outbound_trunk_id: outboundTrunkId,
        dispatch_rule_id: dispatch.dispatchRuleId,
      },
    });

    return { status: config.status, config, provider_routing: providerRouting };
  }

  async disconnectNumber(workspaceId: string, numberId: string, actorUserId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: numberId, workspaceId },
      include: { livekitConfig: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    if (number.livekitConfig?.dispatchRuleId) {
      await this.livekit.deleteDispatchRule(number.livekitConfig.dispatchRuleId).catch(() => undefined);
    }
    if (number.livekitConfig?.inboundTrunkId) {
      await this.livekit.deleteSipTrunk(number.livekitConfig.inboundTrunkId).catch(() => undefined);
    }
    if (number.livekitConfig?.outboundTrunkId) {
      await this.livekit.deleteSipTrunk(number.livekitConfig.outboundTrunkId).catch(() => undefined);
    }
    const updated = await this.prisma.telephonyPhoneNumber.update({
      where: { id: number.id },
      data: { status: 'disconnected' },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.disconnect',
      resourceType: 'telephony_phone_number',
      resourceId: number.id,
    });
    return this.phoneNumberDto(updated);
  }

  async startOutboundCall(workspaceId: string, actorUserId: string, dto: StartTelephonyOutboundCallDto) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: dto.phone_number_id, workspaceId },
      include: { livekitConfig: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    if (!number.assignedAgentId || !number.livekitConfig?.outboundTrunkId) {
      throw new AppError('VALIDATION_ERROR', 'This phone number is not configured for outbound LiveKit calls.', 400);
    }

    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true, retentionDays: true },
    });
    const featureAllowed = await this.billing.checkFeatureGate(workspace.organizationId, 'outbound');
    if (!featureAllowed) {
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

    const purpose = typeof dto.metadata?.purpose === 'string' ? dto.metadata.purpose : null;
    const checkResult = await this.compliance.check({
      workspaceId,
      agentId: number.assignedAgentId,
      direction: 'outbound',
      toNumber: dto.to_number,
      purpose,
    });
    if (checkResult.status === 'blocked') {
      await this.audit.log({
        workspaceId,
        actorUserId,
        action: 'telephony.outbound_call.blocked',
        resourceType: 'compliance_check',
        resourceId: checkResult.id,
        metadata: {
          phone_number_id: number.id,
          to_number: dto.to_number,
          reasons: checkResult.reasons,
        },
      });
      throw new ComplianceBlockedError({ reasons: checkResult.reasons });
    }

    const duplicate = await this.findRecentOutboundDuplicate(
      workspaceId,
      number.assignedAgentId,
      number.id,
      dto.to_number,
    );
    if (duplicate) {
      return {
        call_id: duplicate.id,
        provider_call_id: duplicate.providerCallId,
        room_name: duplicate.livekitRoomName,
      };
    }

    const roomName = `${env.LIVEKIT_ROOM_PREFIX ?? 'call'}-${number.id}-outbound-${Date.now()}`;
    const result = await this.livekit.createOutboundCall({
      phoneNumberId: number.id,
      agentId: number.assignedAgentId,
      outboundTrunkId: number.livekitConfig.outboundTrunkId,
      toNumber: dto.to_number,
      fromNumber: number.phoneNumberE164,
      roomName,
    });
    const expiresAt = new Date(new Date().getTime() + workspace.retentionDays * 24 * 60 * 60 * 1000);
    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: number.organizationId,
        agentId: number.assignedAgentId,
        contactId: checkResult.contact_id,
        direction: 'outbound',
        status: result.status,
        provider: 'livekit',
        providerCallId: result.providerCallId,
        phoneNumberId: number.id,
        livekitRoomName: result.roomName,
        fromNumber: number.phoneNumberE164,
        toNumber: dto.to_number,
        contactName: dto.contact_name ?? null,
        startedAt: new Date(),
        expiresAt,
        retentionDays: workspace.retentionDays,
        metadata: (dto.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });
    await this.compliance.attachCheckToCall(checkResult.id, call.id);
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.outbound_call.start',
      resourceType: 'call',
      resourceId: call.id,
      metadata: {
        phone_number_id: number.id,
        to_number: dto.to_number,
        compliance_check_id: checkResult.id,
        contact_id: checkResult.contact_id,
      },
    });
    return { call_id: call.id, provider_call_id: result.providerCallId, room_name: result.roomName };
  }

  async handleTwilioVoice(phoneNumberId: string, payload: Record<string, unknown>): Promise<string> {
    const number = await this.prisma.telephonyPhoneNumber.findUnique({
      where: { id: phoneNumberId },
      include: { assignedAgent: true, livekitConfig: true },
    });
    if (!number?.assignedAgent || !number.livekitConfig) {
      return this.twilioFallback.buildFallbackTwiml();
    }
    const callSid = String(payload.CallSid ?? '');
    if (callSid) {
      await this.ensureInboundCall({
        workspaceId: number.workspaceId,
        organizationId: number.organizationId,
        agentId: number.assignedAgentId!,
        phoneNumberId: number.id,
        provider: 'twilio',
        providerCallId: callSid,
        fromNumber: typeof payload.From === 'string' ? payload.From : null,
        toNumber: typeof payload.To === 'string' ? payload.To : null,
      });
    }
    return this.twilioFallback.buildLiveKitDialTwiml(`sip:${number.livekitConfig.livekitSipHost}`);
  }

  async handleStatusWebhook(provider: 'twilio' | 'vobiz', phoneNumberId: string, payload: Record<string, unknown>) {
    const normalized = this.normalizeStatus(provider, payload);
    await this.recordWebhookEvent(provider, normalized.eventId ?? normalized.providerCallId, 'call.status', phoneNumberId, payload, true);
    const call = await this.prisma.call.findFirst({ where: { providerCallId: normalized.providerCallId } });
    if (call) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: this.statusMap(normalized.status),
          endedAt: this.isTerminalStatus(normalized.status) ? new Date() : undefined,
        },
      });
    }
    return { processed: true };
  }

  async handleLiveKitWebhook(rawBody: string, authorization: string | undefined) {
    const parsed = this.livekit.verifyWebhook(rawBody, authorization) as Record<string, unknown>;
    const eventType = String(parsed.event ?? parsed.type ?? 'livekit.unknown');
    const eventId = String(parsed.id ?? `${eventType}:${parsed.createdAt ?? Date.now()}`);
    await this.recordWebhookEvent('livekit', eventId, eventType, null, parsed, true);
    return { processed: true, event: eventType };
  }

  private async ensureInboundCall(params: {
    workspaceId: string;
    organizationId: string;
    agentId: string;
    phoneNumberId: string;
    provider: string;
    providerCallId: string;
    fromNumber: string | null;
    toNumber: string | null;
  }) {
    const existing = await this.prisma.call.findFirst({ where: { providerCallId: params.providerCallId } });
    if (existing) return existing;
    return this.prisma.call.create({
      data: {
        workspaceId: params.workspaceId,
        organizationId: params.organizationId,
        agentId: params.agentId,
        phoneNumberId: params.phoneNumberId,
        direction: 'inbound',
        status: 'queued',
        provider: params.provider,
        providerCallId: params.providerCallId,
        fromNumber: params.fromNumber,
        toNumber: params.toNumber,
        startedAt: new Date(),
      },
    });
  }

  private normalizeStatus(provider: 'twilio' | 'vobiz', payload: Record<string, unknown>): NormalizedCallStatus {
    if (provider === 'twilio') {
      return {
        providerCallId: String(payload.CallSid ?? payload.call_sid ?? ''),
        status: String(payload.CallStatus ?? payload.call_status ?? 'unknown'),
        eventId: String(payload.SmsSid ?? payload.CallSid ?? ''),
      };
    }
    return {
      providerCallId: String(payload.call_id ?? payload.callId ?? payload.id ?? ''),
      status: String(payload.status ?? payload.call_status ?? 'unknown'),
      eventId: String(payload.event_id ?? payload.id ?? ''),
    };
  }

  private async recordWebhookEvent(
    provider: string,
    eventId: string,
    eventType: string,
    phoneNumberId: string | null,
    payload: Record<string, unknown>,
    signatureValid: boolean,
  ) {
    if (!eventId) return null;
    const phoneNumber = phoneNumberId
      ? await this.prisma.telephonyPhoneNumber.findUnique({
          where: { id: phoneNumberId },
          select: { workspaceId: true },
        })
      : null;
    try {
      return await this.prisma.telephonyWebhookEvent.create({
        data: {
          provider,
          eventId,
          eventType,
          phoneNumberId,
          workspaceId: phoneNumber?.workspaceId ?? null,
          rawPayloadJson: payload as Prisma.InputJsonValue,
          signatureValid,
          status: 'processed',
          processedAt: new Date(),
        },
      });
    } catch {
      return null;
    }
  }

  private async workspace(workspaceId: string) {
    return this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
  }

  private async connection(workspaceId: string, connectionId: string) {
    const connection = await this.prisma.telephonyProviderConnection.findFirst({
      where: { id: connectionId, workspaceId, status: { not: 'disconnected' } },
    });
    if (!connection) throw new AppError('TELEPHONY_NOT_FOUND', 'Provider connection not found.', 404);
    return connection;
  }

  private async number(workspaceId: string, numberId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: numberId, workspaceId, status: { not: 'disconnected' } },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    return number;
  }

  private async agent(workspaceId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true, name: true, activeVersionId: true },
    });
    if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found.', 404);
    return agent;
  }

  private connectedNumber(number: {
    id: string;
    provider: string;
    providerNumberId: string | null;
    phoneNumberE164: string;
    sipTrunkId: string | null;
    providerMetadata?: Prisma.JsonValue | null;
  }): ConnectedPhoneNumber {
    return {
      id: number.id,
      provider: number.provider as never,
      providerNumberId: number.providerNumberId,
      phoneNumberE164: number.phoneNumberE164,
      sipTrunkId: number.sipTrunkId,
      metadata: this.objectMetadata(number.providerMetadata),
    };
  }

  private connectionDto(connection: {
    id: string;
    provider: string;
    displayName: string;
    providerAccountId: string | null;
    status: string;
    lastVerifiedAt: Date | null;
    lastSyncAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: connection.id,
      provider: connection.provider,
      display_name: connection.displayName,
      provider_account_id: this.encryption.mask(connection.providerAccountId),
      status: connection.status,
      last_verified_at: connection.lastVerifiedAt?.toISOString() ?? null,
      last_sync_at: connection.lastSyncAt?.toISOString() ?? null,
      created_at: connection.createdAt.toISOString(),
    };
  }

  private phoneNumberDto(number: {
    id: string;
    provider: string;
    providerConnectionId?: string | null;
    phoneNumberE164: string;
    friendlyName: string | null;
    status: string;
    assignedAgentId?: string | null;
    inboundEnabled: boolean;
    outboundEnabled: boolean;
    lastSyncedAt?: Date | null;
    createdAt: Date;
    assignedAgent?: { id: string; name: string } | null;
    livekitConfig?: { status: string; livekitSipHost: string; inboundTrunkId: string | null; outboundTrunkId: string | null; dispatchRuleId: string | null } | null;
    providerConnection?: { id: string; displayName: string; status: string } | null;
  }) {
    return {
      id: number.id,
      provider: number.provider,
      provider_connection_id: number.providerConnectionId ?? null,
      phone_number: number.phoneNumberE164,
      friendly_name: number.friendlyName,
      status: number.status,
      assigned_agent_id: number.assignedAgentId ?? null,
      agent: number.assignedAgent ?? null,
      inbound_enabled: number.inboundEnabled,
      outbound_enabled: number.outboundEnabled,
      last_synced_at: number.lastSyncedAt?.toISOString() ?? null,
      created_at: number.createdAt.toISOString(),
      livekit: number.livekitConfig
        ? {
            status: number.livekitConfig.status,
            sip_host: number.livekitConfig.livekitSipHost,
            inbound_trunk_id: number.livekitConfig.inboundTrunkId,
            outbound_trunk_id: number.livekitConfig.outboundTrunkId,
            dispatch_rule_id: number.livekitConfig.dispatchRuleId,
          }
        : null,
      provider_connection: number.providerConnection ?? null,
    };
  }

  private webhookUrl(path: string): string {
    return new URL(`/api/v1/${path}`, env.APP_BASE_URL ?? env.WEB_BASE_URL).toString();
  }

  private objectMetadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private importedNumberStatus(metadata: Record<string, unknown> | undefined): string {
    if (metadata?.requiresPhoneNumber === true || metadata?.phoneNumberSource === 'manual_import') {
      return 'pending_verification';
    }
    return 'verified';
  }

  private statusMap(status: string): string {
    const map: Record<string, string> = {
      queued: 'queued',
      ringing: 'ringing',
      initiated: 'queued',
      'in-progress': 'in_progress',
      in_progress: 'in_progress',
      completed: 'completed',
      answered: 'in_progress',
      ended: 'completed',
      failed: 'failed',
      busy: 'failed',
      'no-answer': 'failed',
      cancelled: 'cancelled',
      canceled: 'cancelled',
    };
    return map[status] ?? 'in_progress';
  }

  private isTerminalStatus(status: string): boolean {
    return ['completed', 'failed', 'busy', 'no-answer', 'cancelled', 'canceled', 'ended'].includes(status);
  }

  private findRecentOutboundDuplicate(
    workspaceId: string,
    agentId: string,
    phoneNumberId: string,
    toNumber: string,
  ) {
    return this.prisma.call.findFirst({
      where: {
        workspaceId,
        agentId,
        phoneNumberId,
        toNumber,
        createdAt: { gt: new Date(Date.now() - 60000) },
      },
    });
  }
}

function cryptoRandomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
