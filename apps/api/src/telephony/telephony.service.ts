import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  AssignPhoneNumberAgentDto,
  CreateTelephonyConnectionDto,
  HandoffDialRequest,
  HandoffDialResponse,
  ImportPhoneNumbersDto,
  InboundCallAdmitRequest,
  InboundCallAdmitResponse,
  ManualPhoneNumberDto,
  PhoneNumberProvider,
  ProviderCredentials,
  SipTrunkNumberDto,
  StartTelephonyOutboundCallDto,
  SyncedProviderPhoneNumber,
  VoicePipeline,
} from '@voiceforge/shared';
import { normalizePhone } from '@voiceforge/shared';
import { parsePhoneNumber } from 'libphonenumber-js';
import {
  AppError,
  ComplianceBlockedError,
  ForbiddenError,
  UnauthorizedError,
} from '../common/errors';
import { env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import { CallAdmissionService, isCallDenied } from '../billing/call-admission.service';
import { EntitlementService } from '../billing/entitlement.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EncryptionService } from '../security/encryption.service';
import { LiveKitService } from '../livekit/livekit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineRouterService } from '../voice/pipeline-router.service';
import { ProviderRegistry } from './providers/provider-registry';
import type {
  ConnectedPhoneNumber,
  NormalizedCallStatus,
  ProviderPhoneNumber,
} from './providers/provider.types';
import { TwilioProviderAdapter } from './providers/twilio.provider';

type WebhookRequestContext = {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  rawBody?: string;
};

const BILLING_UPGRADE_PATH = '/dashboard/billing';

/**
 * How long the human's phone rings before the caller is told nobody answered.
 * The caller is holding the whole time, so this is a patience budget, not a
 * carrier limit.
 */
const HANDOFF_RING_SECONDS = 25;

/**
 * Only the handoff block is needed here; the runtime already holds the rest.
 * `enabled` defaults the way AgentSpecSchema does, so a stored spec that
 * predates the flag reads the same on both sides.
 */
const HandoffConfigSchema = z.object({
  handoff: z
    .object({ enabled: z.boolean().default(true), target_phone: z.string().optional() })
    .optional(),
});

/** Prisma reports a unique-index rejection as `P2002`. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

const BYO_TELEPHONY_PLAN_LIMIT_DETAILS = {
  limitType: 'byo_telephony',
  currentPlan: 'free',
  upgradePath: BILLING_UPGRADE_PATH,
} as const;

@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
    private readonly registry: ProviderRegistry,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly compliance: ComplianceService,
    private readonly twilioFallback: TwilioProviderAdapter,
    private readonly admission: CallAdmissionService,
    private readonly pipelineRouter?: PipelineRouterService,
    private readonly entitlements?: EntitlementService,
  ) {}

  /**
   * Chooses the runtime pipeline for a call and reports it in the shape the
   * call row and the LiveKit dispatch metadata both need.
   *
   * Returns `null` when routing is unavailable (no router or plan lookup wired
   * in), so the runtime keeps its legacy Realtime behavior and the call row
   * records no pipeline rather than an invented one.
   */
  private async resolvePipeline(
    organizationId: string,
    callId: string,
  ): Promise<VoicePipeline | null> {
    if (!this.pipelineRouter || typeof this.entitlements?.getEffectivePlan !== 'function') {
      return null;
    }
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    const route = this.pipelineRouter.route(effective.plan, callId);
    if (route.reason === 'standard_pipeline_disabled' && route.pipeline === 'standard') {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Voice calls are temporarily unavailable. Please retry shortly.',
        503,
      );
    }
    return route.pipeline;
  }

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
        {
          id: 'sip',
          name: 'SIP trunk',
          supportsAutomaticSync: false,
          supportsAutomaticRouting: false,
          supportsManualSetup: true,
        },
      ],
    };
  }

  async createConnection(
    workspaceId: string,
    actorUserId: string,
    dto: CreateTelephonyConnectionDto,
  ) {
    const workspace = await this.workspace(workspaceId);
    await this.assertByoTelephonyAllowed(workspace.organizationId);
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
        encryptedCredentials: this.encryption.encryptJson(
          dto.credentials,
        ) as unknown as Prisma.InputJsonValue,
        status: 'connected',
        lastVerifiedAt: new Date(),
        ...(validation.accountType ? { metadata: { account_type: validation.accountType } } : {}),
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

    // Provisioning runs after the row and its audit entry exist, so a Twilio
    // outage surfaces as a 502 on a connection the user can retry (import or
    // assign an agent runs this again) instead of throwing their credentials
    // away.
    await this.ensureProviderSipTrunk(connection);

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
    const workspace = await this.workspace(workspaceId);
    await this.assertByoTelephonyAllowed(workspace.organizationId);
    const connection = await this.connection(workspaceId, connectionId);
    const numbers = await this.providerInventory(connection);

    await this.prisma.telephonyProviderConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), status: 'connected' },
    });
    await this.refreshAccountType(connection);
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
    const workspace = await this.workspace(workspaceId);
    await this.assertByoTelephonyAllowed(workspace.organizationId);
    const connection = await this.connection(workspaceId, dto.connection_id);
    // One listing for the whole request. The connection's credentials are the
    // only ownership proof this API holds, and `phoneNumberE164` is uniquely
    // indexed, so importing a number the account does not carry lets a workspace
    // squat a string and deny its rightful owner a 409 forever.
    const inventory = await this.providerInventory(connection);
    const created = [];
    for (const number of dto.numbers) {
      const metadata = this.objectMetadata(number.metadata);
      const sipTrunkDomain = this.normalizeSipTrunkDomain(
        connection.provider,
        typeof metadata.sipTrunkDomain === 'string' ? metadata.sipTrunkDomain : null,
      );
      const isVobizTrunkOnlyImport =
        connection.provider === 'vobiz' &&
        (metadata.requiresPhoneNumber === true ||
          metadata.phoneNumberSource === 'manual_import' ||
          typeof metadata.sipTrunkId === 'string');
      if (isVobizTrunkOnlyImport && !sipTrunkDomain) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Enter the user-specific Vobiz outbound SIP domain for each trunk-only import.',
          400,
        );
      }
      const webhookSecret = this.normalizeWebhookSecret(number.webhook_secret);
      if (connection.provider === 'vobiz' && !webhookSecret) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Enter the per-number Vobiz webhook secret before importing.',
          400,
        );
      }
      // Matched by E.164 against the provider's own inventory. Checked before the
      // duplicate lookup below so a caller importing a number it does not own
      // learns nothing about which numbers other workspaces hold.
      const ownedRecord = inventory.find((item) => item.phoneNumberE164 === number.phone_number);
      const owned = ownedRecord !== undefined;
      // Vobiz falls back to listing trunks when the account exposes no DIDs, and
      // a trunk carries no E.164 to match on, so the number entered against one
      // is unverifiable here by construction. That branch keeps its previous
      // behavior and stays `pending_verification` — which is now enforced at
      // assign and outbound — instead of being refused outright. The trunk itself
      // must still be in the account, and the branch is taken from the provider's
      // response rather than the caller's `metadata`, which is client-supplied.
      const unverifiableTrunk =
        !owned &&
        inventory.some(
          (item) => item.providerNumberId === number.provider_number_id && !item.phoneNumberE164,
        );
      if (!owned && !unverifiableTrunk) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${number.phone_number} is not in this provider connection's account.`,
          400,
        );
      }

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
        // The provider id comes from the inventory record the E.164 matched, not
        // from the request: routing configures the provider resource this id
        // names, so a caller-supplied id could bind a verified number to a
        // DIFFERENT resource in the account. Only the null-E.164 trunk branch —
        // where there is no matched record — keeps the caller's value, and that
        // value was itself just checked against the inventory above.
        providerNumberId: ownedRecord?.providerNumberId ?? number.provider_number_id,
        friendlyName: number.friendly_name ?? null,
        capabilities: (number.capabilities as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        providerMetadata: {
          ...metadata,
          ...(sipTrunkDomain ? { sipTrunkDomain } : {}),
          ...this.webhookSecretMetadata(webhookSecret),
        } as Prisma.InputJsonValue,
        status: owned ? 'verified' : 'pending_verification',
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
              // A trunked Twilio number can dial out as soon as it is
              // configured; a BYO SIP trunk cannot until the user tells us its
              // outbound domain, so only Twilio defaults to on.
              outboundEnabled: connection.provider === 'twilio',
              sipTrunkId:
                typeof number.metadata?.sipTrunkId === 'string' ? number.metadata.sipTrunkId : null,
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

  /**
   * Records a number the caller says it controls, with no connection to check it
   * against, so the row lands `pending_verification` and is refused at assign,
   * configure-livekit, and outbound until an import proves it (see
   * `assertNumberVerified` and `importNumbers`). Nothing here moves it out of
   * that state: a manual row carries no credentials this API can query. That
   * "pending until an import proves it" rule covers twilio/vobiz rows only —
   * provider 'sip' rows go through `createSipTrunkNumber` below instead.
   */
  async createManualNumber(workspaceId: string, actorUserId: string, dto: ManualPhoneNumberDto) {
    const workspace = await this.workspace(workspaceId);
    await this.assertByoTelephonyAllowed(workspace.organizationId);
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
    const webhookSecret = this.normalizeWebhookSecret(dto.webhook_secret);
    if (dto.provider === 'vobiz' && !webhookSecret) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Enter the per-number Vobiz webhook secret before adding this number.',
        400,
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
          sipTrunkDomain: this.normalizeSipTrunkDomain(dto.provider, dto.sip_trunk_domain),
          ...this.webhookSecretMetadata(webhookSecret),
        } as unknown as Prisma.InputJsonValue,
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

  /**
   * Records a generic BYO SIP trunk number as 'verified' on create: no provider
   * API exists to verify a generic trunk. Inbound only rings if the user points
   * their carrier at our SIP host, outbound authenticates with their own trunk
   * credentials, and the global @unique on phoneNumberE164 remains the squat guard.
   */
  async createSipTrunkNumber(workspaceId: string, actorUserId: string, dto: SipTrunkNumberDto) {
    const workspace = await this.workspace(workspaceId);
    await this.assertByoTelephonyAllowed(workspace.organizationId);
    if (dto.sip_auth_password && !dto.sip_auth_username) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A SIP auth password requires a SIP auth username.',
        400,
      );
    }
    const sipTrunkDomain = this.normalizeSipTrunkDomain('sip', dto.sip_trunk_domain);
    if (!sipTrunkDomain) {
      throw new AppError('VALIDATION_ERROR', 'Enter the SIP trunk domain.', 400);
    }

    if (!this.entitlements) {
      throw new AppError('BILLING_UNAVAILABLE', 'Plan entitlements are unavailable.', 503);
    }
    // The phone-number quota is one plan number across both worlds: managed
    // (platform-rented Twilio) and BYO rows.
    const [managed, byo] = await Promise.all([
      this.prisma.twilioPhoneNumber.count({
        where: { workspace: { organizationId: workspace.organizationId } },
      }),
      this.prisma.telephonyPhoneNumber.count({
        where: { organizationId: workspace.organizationId, status: { not: 'disconnected' } },
      }),
    ]);
    await this.entitlements.assertAllowed(workspace.organizationId, {
      kind: 'phone_number_create',
      current: managed + byo,
    });

    let row;
    try {
      row = await this.prisma.telephonyPhoneNumber.create({
        data: {
          workspaceId,
          organizationId: workspace.organizationId,
          provider: 'sip',
          phoneNumberE164: dto.phone_number,
          friendlyName: dto.phone_number,
          status: 'verified',
          inboundEnabled: true,
          outboundEnabled: true,
          providerMetadata: {
            sipTrunkDomain,
            sipAuthUsernameEncrypted: dto.sip_auth_username
              ? this.encryption.encryptJson({ value: dto.sip_auth_username })
              : null,
            sipAuthPasswordEncrypted: dto.sip_auth_password
              ? this.encryption.encryptJson({ value: dto.sip_auth_password })
              : null,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // The global @unique on phoneNumberE164 is the uniqueness check.
      if (isUniqueConstraintViolation(err)) {
        throw new AppError(
          'PHONE_NUMBER_ALREADY_CONNECTED',
          'This phone number is already connected.',
          409,
        );
      }
      throw err;
    }
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.sip_create',
      resourceType: 'telephony_phone_number',
      resourceId: row.id,
      metadata: { provider: 'sip' },
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

  async assignAgent(
    workspaceId: string,
    numberId: string,
    actorUserId: string,
    dto: AssignPhoneNumberAgentDto,
  ) {
    const number = await this.number(workspaceId, numberId);
    await this.assertByoTelephonyAllowed(number.organizationId);
    this.assertNumberVerified(number);
    if (dto.agent_id) {
      const agent = await this.agent(workspaceId, dto.agent_id);
      // The compliance engine refuses calls for non-published agents at dial
      // time; failing here instead gives the user the fix while they are
      // still on the assignment screen.
      if (agent.status !== 'published') {
        throw new AppError(
          'AGENT_NOT_PUBLISHED',
          'Publish the agent before assigning it to a phone number.',
          409,
        );
      }
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
    // Assigning the agent is the last step the user takes, so it is the moment
    // routing is (idempotently) set up — for every provider, not just BYO SIP.
    // A separate "configure" button after assignment was a dead end nobody
    // pressed, and the page keeps a Reconfigure action for retries.
    if (dto.agent_id) {
      const result = await this.configureLiveKit(workspaceId, number.id, actorUserId);
      // Re-read: configure just flipped the status and created the LiveKit
      // config, and the assign response must reflect what a refresh shows.
      const configured = await this.prisma.telephonyPhoneNumber.findFirst({
        where: { id: number.id, workspaceId },
        include: { livekitConfig: true },
      });
      // `provider_routing` rides along because a provider that could not be
      // configured by API returns the steps the customer has to take at their
      // carrier, and assignment is now the only place most users see them.
      if (configured) {
        return { ...this.phoneNumberDto(configured), provider_routing: result.provider_routing };
      }
    }
    return this.phoneNumberDto(updated);
  }

  async configureLiveKit(workspaceId: string, numberId: string, actorUserId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: numberId, workspaceId },
      include: { providerConnection: true, livekitConfig: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    await this.assertByoTelephonyAllowed(number.organizationId);
    this.assertNumberVerified(number);
    if (!number.assignedAgentId) {
      throw new AppError('VALIDATION_ERROR', 'Assign an agent before configuring LiveKit.', 400);
    }
    const agent = await this.agent(workspaceId, number.assignedAgentId);
    // Read before any LiveKit resource is created: this getter throws when
    // LIVEKIT_SIP_HOST is unconfigured, and a configuration error must fail
    // the call before it can strand a trunk — LiveKit refuses a second
    // inbound trunk covering the same number, so a stranded one blocks every
    // retry (observed live: trunk ST_cMBRdWguE3yR, 2026-09-01).
    const livekitSipHost = this.livekit.livekitSipHost;
    // Before anything is torn down: this reaches out to Twilio, and a failure
    // must leave the working configuration in place.
    const providerTrunk = number.providerConnection
      ? await this.ensureProviderSipTrunk(number.providerConnection)
      : null;

    const metadata = this.objectMetadata(number.providerMetadata);
    const sipAuthUsernameEncrypted = metadata.sipAuthUsernameEncrypted ?? null;
    const sipAuthPasswordEncrypted = metadata.sipAuthPasswordEncrypted ?? null;
    const authUsername = sipAuthUsernameEncrypted
      ? this.encryption.decryptJson<{ value?: string }>(sipAuthUsernameEncrypted).value
      : undefined;
    const authPassword = sipAuthPasswordEncrypted
      ? this.encryption.decryptJson<{ value?: string }>(sipAuthPasswordEncrypted).value
      : undefined;

    // Re-configuration replaces the LiveKit resources, so the previous ones
    // are deleted first — otherwise every reconfigure leaks a trunk and the
    // new inbound trunk conflicts with the old one over the number.
    await this.deleteRecordedLiveKitResources(number.livekitConfig);

    const roomPrefix = `${env.LIVEKIT_ROOM_PREFIX ?? 'call'}-${number.id}-`;
    let inboundTrunkId: string | null = null;
    let outboundTrunkId: string | null = null;
    let dispatchRuleId: string;
    try {
      const inbound = await this.livekit.createInboundSipTrunk({
        workspaceId,
        phoneNumberId: number.id,
        phoneNumberE164: number.phoneNumberE164,
        provider: number.provider as PhoneNumberProvider,
        ...(authUsername ? { authUsername } : {}),
        ...(authPassword ? { authPassword } : {}),
      });
      inboundTrunkId = inbound.trunkId;

      if (number.outboundEnabled) {
        // Outbound goes back out through the same trunk the provider gave us:
        // for Twilio that is the trunk's own termination domain and SIP
        // credential, for a BYO trunk it is the domain the user typed.
        const outbound = await this.livekit.createOutboundSipTrunk({
          workspaceId,
          phoneNumberId: number.id,
          phoneNumberE164: number.phoneNumberE164,
          provider: number.provider as PhoneNumberProvider,
          sipAddress:
            providerTrunk?.domainName ??
            (typeof metadata.sipTrunkDomain === 'string' ? metadata.sipTrunkDomain : null),
          ...(providerTrunk?.username ?? authUsername
            ? { authUsername: (providerTrunk?.username ?? authUsername) as string }
            : {}),
          ...(providerTrunk?.password ?? authPassword
            ? { authPassword: (providerTrunk?.password ?? authPassword) as string }
            : {}),
        });
        outboundTrunkId = outbound.trunkId;
      }

      const dispatch = await this.livekit.createDispatchRule({
        workspaceId,
        phoneNumberId: number.id,
        agentId: agent.id,
        trunkId: inboundTrunkId,
        roomPrefix,
        agentName: env.LIVEKIT_AGENT_NAME,
        metadata: {
          // The dispatch rule is created once per number, so it cannot carry a
          // call id. It carries the organization instead, which is what lets the
          // runtime resolve the admitted call for this room and meter it.
          organizationId: number.organizationId,
          provider: number.provider,
          direction: 'inbound',
          model: env.OPENAI_REALTIME_MODEL,
        },
      });
      dispatchRuleId = dispatch.dispatchRuleId;
    } catch (err) {
      // A partially configured number must stay retryable: delete whatever
      // this run created so the next attempt starts from a clean slate.
      if (inboundTrunkId) {
        await this.livekit.deleteSipTrunk(inboundTrunkId).catch(() => undefined);
      }
      if (outboundTrunkId) {
        await this.livekit.deleteSipTrunk(outboundTrunkId).catch(() => undefined);
      }
      throw err;
    }

    const config = await this.prisma.liveKitTelephonyConfig.upsert({
      where: { phoneNumberId: number.id },
      create: {
        workspaceId,
        organizationId: number.organizationId,
        phoneNumberId: number.id,
        agentId: agent.id,
        livekitRoomPrefix: roomPrefix,
        livekitSipHost,
        inboundTrunkId,
        outboundTrunkId,
        dispatchRuleId,
        sipAuthUsernameEncrypted:
          (sipAuthUsernameEncrypted as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        sipAuthPasswordEncrypted:
          (sipAuthPasswordEncrypted as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        status: 'configured',
      },
      update: {
        agentId: agent.id,
        livekitRoomPrefix: roomPrefix,
        livekitSipHost,
        inboundTrunkId,
        outboundTrunkId,
        dispatchRuleId,
        sipAuthUsernameEncrypted:
          (sipAuthUsernameEncrypted as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        sipAuthPasswordEncrypted:
          (sipAuthPasswordEncrypted as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        status: 'configured',
      },
    });

    let providerRouting: unknown = null;
    if (number.providerConnection) {
      // Released only now that the replacement LiveKit resources exist: a
      // failure above must leave the carrier still pointing at us, because the
      // number can sit on only one trunk and re-attaching it is this method's
      // job. Release then re-attach also covers the case where the trunk itself
      // changed since the last run.
      await this.removeProviderRouting(number);
      const credentials = this.encryption.decryptJson<ProviderCredentials>(
        number.providerConnection.encryptedCredentials,
      );
      providerRouting = await this.registry
        .adapterFor(number.provider as never)
        .configureInboundRouting({
          credentials,
          phoneNumber: this.connectedNumber(number),
          livekitSipUri: `sip:${livekitSipHost}`,
          trunkSid: providerTrunk?.trunkSid ?? null,
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
        inbound_trunk_id: inboundTrunkId,
        outbound_trunk_id: outboundTrunkId,
        dispatch_rule_id: dispatchRuleId,
      },
    });

    return { status: config.status, config, provider_routing: providerRouting };
  }

  /**
   * Delete the LiveKit dispatch rule and SIP trunks a config row recorded. Each
   * delete swallows its error so a resource LiveKit already dropped does not
   * block the rest, which lets a retry clear an earlier half-finished attempt.
   */
  private async deleteRecordedLiveKitResources(
    config: {
      dispatchRuleId: string | null;
      inboundTrunkId: string | null;
      outboundTrunkId: string | null;
    } | null,
  ): Promise<void> {
    if (!config) return;
    if (config.dispatchRuleId) {
      await this.livekit.deleteDispatchRule(config.dispatchRuleId).catch(() => undefined);
    }
    if (config.inboundTrunkId) {
      await this.livekit.deleteSipTrunk(config.inboundTrunkId).catch(() => undefined);
    }
    if (config.outboundTrunkId) {
      await this.livekit.deleteSipTrunk(config.outboundTrunkId).catch(() => undefined);
    }
  }

  async disconnectNumber(workspaceId: string, numberId: string, actorUserId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: numberId, workspaceId },
      include: { livekitConfig: true, providerConnection: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    await this.deleteRecordedLiveKitResources(number.livekitConfig);
    // The number goes back to the customer's account, off our trunk: left
    // attached, it keeps sending calls to a trunk that no longer exists and the
    // caller hears silence.
    await this.removeProviderRouting(number);
    // Hard delete, not a status flip: `phone_number_e164` is globally unique,
    // so a lingering "disconnected" row permanently blocked re-adding the same
    // number. Call history survives (`calls.phone_number_id` is ON DELETE SET
    // NULL) and the LiveKit config row cascades; the audit row below is the
    // durable record of the number ever having existed.
    await this.prisma.telephonyPhoneNumber.delete({ where: { id: number.id } });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'telephony.phone_number.disconnect',
      resourceType: 'telephony_phone_number',
      resourceId: number.id,
      metadata: { phone_number: number.phoneNumberE164, provider: number.provider },
    });
    return this.phoneNumberDto({ ...number, status: 'disconnected' });
  }

  async startOutboundCall(
    workspaceId: string,
    actorUserId: string,
    dto: StartTelephonyOutboundCallDto,
  ) {
    const number = await this.prisma.telephonyPhoneNumber.findFirst({
      where: { id: dto.phone_number_id, workspaceId },
      include: { livekitConfig: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    this.assertNumberVerified(number);
    if (!number.assignedAgentId || !number.livekitConfig?.outboundTrunkId) {
      throw new AppError(
        'VALIDATION_ERROR',
        'This phone number is not configured for outbound LiveKit calls.',
        400,
      );
    }

    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true, retentionDays: true },
    });
    await this.assertByoTelephonyAllowed(workspace.organizationId);
    const featureAllowed = await this.billing.checkFeatureGate(
      workspace.organizationId,
      'outbound',
    );
    if (!featureAllowed) {
      throw new ForbiddenPlanError('Outbound calls require a paid plan.');
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
    const expiresAt = new Date(
      new Date().getTime() + workspace.retentionDays * 24 * 60 * 60 * 1000,
    );

    // Persisted before dispatch so the concurrency lease, credit reservation,
    // and usage record have a call to attach to.
    const call = await this.prisma.call.create({
      data: {
        workspaceId,
        organizationId: number.organizationId,
        agentId: number.assignedAgentId,
        contactId: checkResult.contact_id,
        direction: 'outbound',
        status: 'queued',
        provider: 'livekit',
        phoneNumberId: number.id,
        livekitRoomName: roomName,
        fromNumber: number.phoneNumberE164,
        toNumber: dto.to_number,
        contactName: dto.contact_name ?? null,
        startedAt: new Date(),
        expiresAt,
        retentionDays: workspace.retentionDays,
        metadata: (dto.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });

    // Route after the call row exists because percentage splits are keyed to
    // call identity, but before admission so billing, storage, and dispatch all
    // use the same pipeline decision.
    let pipeline: VoicePipeline | null;
    try {
      pipeline = await this.resolvePipeline(number.organizationId, call.id);
      if (pipeline) {
        await this.prisma.call.update({ where: { id: call.id }, data: { pipeline } });
      }
    } catch (err) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'pipeline_routing_failed' },
      });
      throw err;
    }

    const admission = await this.admission.admitCall({
      organizationId: number.organizationId,
      workspaceId,
      callId: call.id,
      provider: 'livekit',
      direction: 'outbound',
      ...(pipeline ? { pipeline } : {}),
    });
    if (isCallDenied(admission)) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: admission.reason },
      });
      throw this.admission.toError(admission);
    }

    let result: Awaited<ReturnType<LiveKitService['createOutboundCall']>>;
    try {
      result = await this.livekit.createOutboundCall({
        phoneNumberId: number.id,
        agentId: number.assignedAgentId,
        agentName: env.LIVEKIT_AGENT_NAME,
        outboundTrunkId: number.livekitConfig.outboundTrunkId,
        toNumber: dto.to_number,
        fromNumber: number.phoneNumberE164,
        roomName,
        metadata: {
          workspaceId,
          organizationId: number.organizationId,
          callId: call.id,
          phoneNumberId: number.id,
          provider: number.provider,
          model: env.OPENAI_REALTIME_MODEL,
          purpose,
          ...(pipeline ? { pipeline } : {}),
        },
      });
    } catch (err) {
      await this.admission.compensate(number.organizationId, call.id, 'provider_dispatch_failed');
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'provider_dispatch_failed' },
      });
      throw err;
    }

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status: result.status,
        providerCallId: result.providerCallId,
        livekitRoomName: result.roomName,
      },
    });
    await this.prisma.callUsage.updateMany({
      where: { callId: call.id },
      data: { providerCallId: result.providerCallId },
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
    return {
      call_id: call.id,
      provider_call_id: result.providerCallId,
      room_name: result.roomName,
    };
  }

  async handleTwilioVoice(
    phoneNumberId: string,
    payload: Record<string, unknown>,
    request?: WebhookRequestContext,
  ): Promise<string> {
    const number = await this.prisma.telephonyPhoneNumber.findUnique({
      where: { id: phoneNumberId },
      include: { assignedAgent: true, livekitConfig: true, providerConnection: true },
    });
    if (!number) {
      return this.twilioFallback.buildFallbackTwiml();
    }
    await this.assertTwilioWebhookSignature(number, payload, request, 'call.voice');
    if (!number.assignedAgent || !number.livekitConfig) {
      return this.twilioFallback.buildFallbackTwiml();
    }
    const callSid = String(payload.CallSid ?? '');
    if (callSid) {
      await this.recordWebhookEvent(
        'twilio',
        `${callSid}:voice`,
        'call.voice',
        number.id,
        payload,
        true,
      );
      const call = await this.ensureInboundCall({
        workspaceId: number.workspaceId,
        organizationId: number.organizationId,
        agentId: number.assignedAgentId!,
        phoneNumberId: number.id,
        provider: 'twilio',
        providerCallId: callSid,
        fromNumber: typeof payload.From === 'string' ? payload.From : null,
        toNumber: typeof payload.To === 'string' ? payload.To : null,
      });
      // An answered inbound call costs the same as an outbound one, so it is
      // gated before the caller is bridged into LiveKit rather than after.
      const admitted = await this.admitInboundCall({
        organizationId: number.organizationId,
        workspaceId: number.workspaceId,
        callId: call.id,
        provider: 'livekit',
        providerCallId: callSid,
      });
      if (!admitted.admitted) {
        await this.prisma.call.update({
          where: { id: call.id },
          data: { status: 'failed', endedAt: new Date(), outcome: 'billing_denied' },
        });
        return this.twilioFallback.buildBillingRefusalTwiml();
      }
    }
    // The user part matters: LiveKit matches an inbound trunk on the number
    // being called, so `sip:<host>` alone matches nothing and the caller hears
    // silence. (This path only runs for numbers still on Programmable Voice;
    // a trunked number never reaches a TwiML webhook.)
    return this.twilioFallback.buildLiveKitDialTwiml(
      `sip:${number.phoneNumberE164}@${number.livekitConfig.livekitSipHost}`,
    );
  }

  /**
   * Admits an inbound call that arrived over SIP, on behalf of the runtime.
   *
   * The Twilio TwiML webhook used to be the only place an inbound call could be
   * admitted, so a call delivered straight to LiveKit over SIP (a BYO trunk, a
   * Vobiz trunk, or a Twilio number moved onto an Elastic SIP trunk) reached
   * the agent with no call row and no paid minute, and the caller heard
   * silence. The agent asks here before it speaks, and the answer is the same
   * admission the webhook paths take, so the two cannot diverge.
   *
   * Refusal is enforced, not advisory, and this method owns the teardown: every
   * path that answers `admitted: false` (or throws) first removes the SIP
   * participant, which makes LiveKit send BYE to the carrier. The runtime only
   * has to stop the job -- it never speaks to a refused caller, because by the
   * time it reads the answer the leg is already gone.
   */
  async admitSipInboundCall(input: InboundCallAdmitRequest): Promise<InboundCallAdmitResponse> {
    const number = await this.prisma.telephonyPhoneNumber.findUnique({
      where: { id: input.phoneNumberId },
      select: {
        id: true,
        workspaceId: true,
        organizationId: true,
        assignedAgentId: true,
        provider: true,
        phoneNumberE164: true,
      },
    });
    // The dispatch metadata is written by us, so a number that does not match it
    // means the number was deleted or re-tenanted mid-call. Nothing can be
    // billed against it, and nothing may be admitted for another tenant.
    if (
      !number ||
      number.workspaceId !== input.workspaceId ||
      number.organizationId !== input.organizationId
    ) {
      await this.hangUpSipLeg(input);
      throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    }
    if (number.assignedAgentId !== input.agentId) {
      const hungUp = await this.hangUpSipLeg(input);
      return {
        admitted: false,
        callId: null,
        reason: hungUp ? 'number_not_assigned' : 'number_not_assigned_still_connected',
      };
    }

    const call = await this.ensureInboundCall({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      agentId: input.agentId,
      phoneNumberId: number.id,
      provider: input.provider,
      providerCallId: input.providerCallId,
      fromNumber: input.fromNumber ?? null,
      toNumber: input.toNumber ?? number.phoneNumberE164,
    });
    // `livekit` is the usage provider on every inbound path: the media is
    // carried by LiveKit whichever carrier delivered the leg.
    const admitted = await this.admitInboundCall({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: call.id,
      provider: 'livekit',
      providerCallId: input.providerCallId,
    });
    if (!admitted.admitted) {
      // Teardown comes before the bookkeeping: admission is already denied, and
      // a database that will not take the update must not leave a refused
      // caller connected. The write still throws to the caller if it fails.
      const hungUp = await this.hangUpSipLeg(input);
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'billing_denied' },
      });
      const reason = admitted.reason ?? 'billing_denied';
      return {
        admitted: false,
        callId: call.id,
        reason: hungUp ? reason : `${reason}_still_connected`,
      };
    }
    return { admitted: true, callId: call.id, reason: null };
  }

  /**
   * Disconnects the carrier leg of a call the API is about to refuse.
   *
   * Returns false when the leg may still be up: either the runtime did not tell
   * us which participant to remove, or LiveKit refused both the removal and the
   * room delete. The refusal itself still stands -- the call row is already
   * marked and the runtime still stops -- but the reason carries
   * `_still_connected` so a stuck carrier leg shows up in the runtime log
   * instead of looking like a clean refusal.
   */
  /**
   * Warm transfer: dials the agent's configured human into the caller's room
   * and reports once they have answered, so the runtime can introduce the
   * caller and step out. Nothing here ends the call: the agent job keeps
   * metering until one of the two people hangs up.
   *
   * Only the call -> agent binding is trusted from the request; the target
   * number and the trunk come from the agent's spec and the number the call
   * arrived on. Every failure but authorisation is a `connected: false` with a
   * reason, because the caller is holding and the runtime handles all of them
   * the same way: apologise and offer a message.
   */
  async dialHandoff(input: HandoffDialRequest): Promise<HandoffDialResponse> {
    const call = await this.prisma.call.findUnique({
      where: { id: input.callId },
      select: {
        id: true,
        workspaceId: true,
        organizationId: true,
        agentId: true,
        livekitRoomName: true,
        phoneNumber: {
          select: {
            phoneNumberE164: true,
            livekitConfig: { select: { outboundTrunkId: true } },
          },
        },
        agent: { select: { specJson: true, activeVersionId: true } },
      },
    });
    if (!call || call.agentId !== input.agentId) {
      throw new ForbiddenError('Call is not bound to this agent.');
    }

    const fail = async (reason: string): Promise<HandoffDialResponse> => {
      this.logger.warn(`Handoff for call ${call.id} failed: ${reason}`);
      await this.prisma.callEvent.create({
        data: {
          callId: call.id,
          workspaceId: call.workspaceId,
          organizationId: call.organizationId,
          eventType: 'handoff.failed',
          payload: { reason } as Prisma.InputJsonValue,
        },
      });
      return { connected: false, participantIdentity: null, reason };
    };

    const trunkId = call.phoneNumber?.livekitConfig?.outboundTrunkId;
    if (!call.livekitRoomName || !call.phoneNumber || !trunkId) {
      // Browser tests and numbers without an outbound trunk have no leg to add.
      return fail('no_outbound_trunk');
    }
    const handoff = await this.handoffConfig(call.agent);
    // The runtime only offers the tool when handoff is on, but the runtime is
    // not the trust boundary: an agent that disabled handoff must not be
    // dialled for, whatever the request says.
    if (!handoff.enabled) return fail('handoff_disabled');
    const target = handoff.target_phone
      ? normalizePhone(handoff.target_phone, this.lineCountry(call.phoneNumber.phoneNumberE164))
      : null;
    if (!target) return fail('invalid_target');

    // One dial per call at a time. The requested event doubles as the claim:
    // its provider event id is unique, so a retry of a request whose response
    // was lost, or a second concurrent request, cannot start a second SIP leg
    // while one is ringing or connected. A failed dial releases the claim so
    // the caller can ask again.
    const participantIdentity = `sip-human-${call.id}`;
    const claim = `handoff:${call.id}`;
    try {
      await this.prisma.callEvent.create({
        data: {
          providerEventId: claim,
          callId: call.id,
          workspaceId: call.workspaceId,
          organizationId: call.organizationId,
          eventType: 'handoff.requested',
          payload: { target, summary: input.summary ?? null } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      // A duplicate claim is either a dial still ringing or a dial that already
      // connected whose response was lost. The second must read as the success
      // it was: reporting it as a failure would hand the caller back to the
      // agent while the human is on the line.
      const connected = await this.prisma.callEvent.findFirst({
        where: { workspaceId: call.workspaceId, callId: call.id, eventType: 'handoff.connected' },
        select: { id: true },
      });
      if (connected) return { connected: true, participantIdentity, reason: null };
      this.logger.warn(`Handoff for call ${call.id} already in progress; not dialling again.`);
      return { connected: false, participantIdentity: null, reason: 'handoff_in_progress' };
    }
    try {
      await this.livekit.addSipParticipant({
        outboundTrunkId: trunkId,
        toNumber: target,
        fromNumber: call.phoneNumber.phoneNumberE164,
        roomName: call.livekitRoomName,
        participantIdentity,
        ringingTimeoutSeconds: HANDOFF_RING_SECONDS,
        metadata: { callId: call.id, role: 'human_handoff' },
      });
    } catch (err) {
      await this.prisma.callEvent.updateMany({
        where: { workspaceId: call.workspaceId, providerEventId: claim },
        data: { providerEventId: null },
      });
      return fail(`dial_failed: ${(err as Error).message}`.slice(0, 200));
    }

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        workspaceId: call.workspaceId,
        organizationId: call.organizationId,
        eventType: 'handoff.connected',
        payload: { target, participantIdentity } as Prisma.InputJsonValue,
      },
    });
    await this.prisma.call.update({
      where: { id: call.id },
      data: { outcome: 'human_transfer_completed' },
    });
    return { connected: true, participantIdentity, reason: null };
  }

  /** The agent's handoff block, read the way the runtime reads its spec. */
  private async handoffConfig(agent: {
    specJson: Prisma.JsonValue | null;
    activeVersionId: string | null;
  }): Promise<{ enabled: boolean; target_phone: string | undefined }> {
    let specJson: Prisma.JsonValue | null = agent.specJson;
    if (!specJson && agent.activeVersionId) {
      const version = await this.prisma.agentVersion.findUnique({
        where: { id: agent.activeVersionId },
        select: { specJson: true },
      });
      specJson = version?.specJson ?? null;
    }
    const parsed = HandoffConfigSchema.safeParse(specJson);
    const handoff = parsed.success ? parsed.data.handoff : undefined;
    return { enabled: handoff?.enabled ?? false, target_phone: handoff?.target_phone?.trim() };
  }

  /**
   * Operators type the handoff number the way they dial it locally, so a
   * number with no country code is read in the country of the line the call
   * is on. ponytail: wrong for a line in one country and a human in another;
   * store E.164 in the spec (the UI can normalise on save) if it bites.
   */
  private lineCountry(lineNumberE164: string): string | undefined {
    try {
      return parsePhoneNumber(lineNumberE164).country;
    } catch {
      return undefined;
    }
  }

  private async hangUpSipLeg(input: InboundCallAdmitRequest): Promise<boolean> {
    if (!input.roomName || !input.participantIdentity) {
      this.logger.warn(
        `Refused inbound call ${input.providerCallId} without a room/participant to hang up.`,
      );
      return false;
    }
    return this.livekit.hangUpParticipant(input.roomName, input.participantIdentity);
  }

  /**
   * Admits an inbound call exactly once.
   *
   * Providers retry voice webhooks, and a retry must not reserve a second
   * minute. The usage record written by a successful admission is the marker
   * that the call is already paid for; a repeat delivery only re-asserts the
   * concurrency slot (idempotent per call) before it is bridged.
   */
  private async admitInboundCall(input: {
    organizationId: string;
    workspaceId: string;
    callId: string;
    provider: string;
    providerCallId: string;
  }): Promise<{ admitted: boolean; reason: string | null }> {
    const existingUsage = await this.prisma.callUsage.findUnique({
      where: { callId: input.callId },
      select: { finalizationState: true },
    });
    if (existingUsage && existingUsage.finalizationState !== 'finalized') {
      // The call is already paid for, but the concurrency lease taken by the
      // original admission may have expired between webhook deliveries. The
      // slot is re-asserted so a retried delivery can never bridge a call
      // that holds no lease and push the organization past its cap.
      const reasserted = await this.admission.reassertLease(input.organizationId, input.callId);
      return {
        admitted: reasserted,
        reason: reasserted ? null : 'organization_concurrency_reached',
      };
    }

    const admission = await this.admission.admitCall({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
      provider: input.provider,
      direction: 'inbound',
      providerCallId: input.providerCallId,
    });
    return {
      admitted: admission.admitted,
      reason: isCallDenied(admission) ? admission.reason : null,
    };
  }

  async handleStatusWebhook(
    provider: 'twilio' | 'vobiz',
    phoneNumberId: string,
    payload: Record<string, unknown>,
    request?: WebhookRequestContext,
  ) {
    if (provider === 'twilio') {
      const number = await this.prisma.telephonyPhoneNumber.findUnique({
        where: { id: phoneNumberId },
        include: { providerConnection: true },
      });
      if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
      await this.assertTwilioWebhookSignature(number, payload, request, 'call.status');
    } else {
      const number = await this.vobizNumber(phoneNumberId);
      await this.assertVobizWebhookSignature(number, payload, request, 'call.status');
    }
    const normalized = this.normalizeStatus(provider, payload);
    await this.recordWebhookEvent(
      provider,
      normalized.eventId ?? normalized.providerCallId,
      'call.status',
      phoneNumberId,
      payload,
      true,
    );
    const call = await this.prisma.call.findFirst({
      where: {
        provider,
        providerCallId: normalized.providerCallId,
        phoneNumberId,
      },
    });
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

  /**
   * Handles a Vobiz inbound-call webhook.
   *
   * Vobiz media never transits this API: `configureInboundRouting` points the
   * trunk's `inbound_destination` straight at the LiveKit SIP URI, so by the time
   * this fires the caller is already being bridged and no response here can
   * refuse the call. Admission is therefore evaluated and recorded but never
   * enforced — a denied call is audited and still proceeds, so an existing Vobiz
   * customer does not lose inbound calls without notice.
   *
   * ponytail: advisory admission only, and no metering. Refusal and minute
   * debiting have to be driven from the LiveKit side, which is the only place
   * that sees the media; billing minutes from here would report usage that
   * nothing on this path can finalize.
   */
  async handleVobizInboundWebhook(
    phoneNumberId: string,
    payload: Record<string, unknown>,
    request?: WebhookRequestContext,
  ) {
    const number = await this.vobizNumber(phoneNumberId);
    await this.assertVobizWebhookSignature(number, payload, request, 'call.inbound');

    const { providerCallId } = this.normalizeStatus('vobiz', payload);
    await this.recordWebhookEvent(
      'vobiz',
      this.providerWebhookEventId('vobiz', payload, 'call.inbound', number.id),
      'call.inbound',
      number.id,
      payload,
      true,
    );
    // Without a provider call id there is no call identity to key admission on,
    // and an unassigned number has no agent to attribute the call to.
    if (!providerCallId || !number.assignedAgentId) {
      return { processed: true, admitted: null };
    }

    const call = await this.ensureInboundCall({
      workspaceId: number.workspaceId,
      organizationId: number.organizationId,
      agentId: number.assignedAgentId,
      phoneNumberId: number.id,
      provider: 'vobiz',
      providerCallId,
      fromNumber: stringValue(payload.from ?? payload.from_number ?? payload.caller_id),
      toNumber: stringValue(payload.to ?? payload.to_number) ?? number.phoneNumberE164,
    });
    // `livekit` is the usage provider, matching the Twilio inbound path: the
    // media is carried by LiveKit even though the call row belongs to Vobiz.
    const admitted = await this.admitInboundCall({
      organizationId: number.organizationId,
      workspaceId: number.workspaceId,
      callId: call.id,
      provider: 'livekit',
      providerCallId,
    });
    if (!admitted.admitted) {
      // The denial itself is already audited by the admission service. This
      // records the part that is specific to Vobiz: the call was let through
      // anyway, because this webhook cannot stop it.
      await Promise.resolve(
        this.audit.log({
          workspaceId: number.workspaceId,
          organizationId: number.organizationId,
          action: 'telephony.inbound_call.admission_not_enforced',
          resourceType: 'call',
          resourceId: call.id,
          metadata: { provider: 'vobiz', phone_number_id: number.id, enforcement: 'advisory' },
        }),
      ).catch(() => undefined);
    }
    return { processed: true, call_id: call.id, admitted: admitted.admitted };
  }

  /**
   * Handles a Vobiz number-verification webhook.
   *
   * Verifying the signature and recording the delivery under its own event type
   * is the whole job. It deliberately does not mark the number verified: the
   * signing secret is supplied by the workspace during manual setup, so a valid
   * signature proves the tenant signed the payload, not that the tenant controls
   * the phone number.
   */
  async handleVobizVerifyWebhook(
    phoneNumberId: string,
    payload: Record<string, unknown>,
    request?: WebhookRequestContext,
  ) {
    const number = await this.vobizNumber(phoneNumberId);
    await this.assertVobizWebhookSignature(number, payload, request, 'number.verify');
    await this.recordWebhookEvent(
      'vobiz',
      this.providerWebhookEventId('vobiz', payload, 'number.verify', number.id),
      'number.verify',
      number.id,
      payload,
      true,
    );
    return { processed: true };
  }

  private async vobizNumber(phoneNumberId: string) {
    const number = await this.prisma.telephonyPhoneNumber.findUnique({
      where: { id: phoneNumberId },
      include: { providerConnection: true },
    });
    if (!number) throw new AppError('TELEPHONY_NOT_FOUND', 'Phone number not found.', 404);
    if (number.provider !== 'vobiz') {
      throw new AppError('TELEPHONY_NOT_FOUND', 'Vobiz phone number not found.', 404);
    }
    return number;
  }

  async handleLiveKitWebhook(rawBody: string, authorization: string | undefined) {
    // `receive()` is async: without the await the Promise itself was parsed, so
    // every event became `livekit.unknown` with a `{}` payload and never
    // reached the call it belonged to.
    const parsed = (await this.livekit.verifyWebhook(rawBody, authorization)) as Record<
      string,
      unknown
    >;
    const eventType = String(parsed.event ?? parsed.type ?? 'livekit.unknown');
    const eventId = String(parsed.id ?? `${eventType}:${parsed.createdAt ?? Date.now()}`);
    const context = await this.liveKitWebhookContext(parsed);
    const recorded = await this.recordWebhookEvent(
      'livekit',
      eventId,
      eventType,
      context.phoneNumberId,
      parsed,
      true,
      context.call?.id ?? null,
    );
    // LiveKit redelivers every event about three times. The unique
    // (provider, event_id) index already refuses the copies; acting on them
    // anyway tripled call_events and raced the status writes.
    if (recorded === 'duplicate') {
      return { processed: false, event: eventType, duplicate: true };
    }
    if (context.call) {
      await this.updateCallFromLiveKitWebhook(
        context.call,
        eventType,
        parsed,
        context.participantId,
      );
    }
    return { processed: true, event: eventType };
  }

  private async assertTwilioWebhookSignature(
    number: {
      id: string;
      workspaceId: string;
      providerConnection?: { encryptedCredentials: unknown } | null;
      providerMetadata?: Prisma.JsonValue | null;
    },
    payload: Record<string, unknown>,
    request:
      | {
          headers: Record<string, string | string[] | undefined>;
          url: string;
          rawBody?: string;
        }
      | undefined,
    eventType: string,
  ): Promise<void> {
    if (!request) {
      await this.recordInvalidWebhook(
        'twilio',
        number,
        payload,
        eventType,
        'missing_request_context',
      );
      throw new UnauthorizedError('Missing Twilio webhook signature context.');
    }

    const secret = this.twilioWebhookSecret(number);
    if (!secret) {
      await this.recordInvalidWebhook(
        'twilio',
        number,
        payload,
        eventType,
        'missing_webhook_secret',
      );
      throw new UnauthorizedError('Twilio webhook signing secret is not configured.');
    }

    const adapter = this.registry.adapterFor('twilio');
    const valid = await adapter.validateWebhookSignature?.({
      secret,
      headers: request.headers,
      url: request.url,
      body: payload,
      rawBody: request.rawBody,
    });
    if (!valid) {
      await this.recordInvalidWebhook('twilio', number, payload, eventType, 'invalid_signature');
      throw new UnauthorizedError('Invalid Twilio webhook signature.');
    }
  }

  private async assertVobizWebhookSignature(
    number: {
      id: string;
      workspaceId: string;
      providerMetadata?: Prisma.JsonValue | null;
    },
    payload: Record<string, unknown>,
    request: WebhookRequestContext | undefined,
    eventType: string,
  ): Promise<void> {
    if (!request) {
      await this.recordInvalidWebhook(
        'vobiz',
        number,
        payload,
        eventType,
        'missing_request_context',
      );
      throw new UnauthorizedError('Missing Vobiz webhook signature context.');
    }

    const secret = this.storedWebhookSecret(number);
    if (!secret) {
      await this.recordInvalidWebhook(
        'vobiz',
        number,
        payload,
        eventType,
        'missing_webhook_secret',
      );
      throw new UnauthorizedError('Vobiz webhook signing secret is not configured.');
    }

    const adapter = this.registry.adapterFor('vobiz');
    const valid = await adapter.validateWebhookSignature?.({
      secret,
      headers: request.headers,
      url: request.url,
      body: payload,
      rawBody: request.rawBody,
    });
    if (!valid) {
      await this.recordInvalidWebhook('vobiz', number, payload, eventType, 'invalid_signature');
      throw new UnauthorizedError('Invalid Vobiz webhook signature.');
    }
  }

  private twilioWebhookSecret(number: {
    providerConnection?: { encryptedCredentials: unknown } | null;
    providerMetadata?: Prisma.JsonValue | null;
  }): string | null {
    if (number.providerConnection) {
      const credentials = this.encryption.decryptJson<ProviderCredentials>(
        number.providerConnection.encryptedCredentials,
      );
      return credentials.provider === 'twilio' ? credentials.authToken : null;
    }

    return this.storedWebhookSecret(number);
  }

  private storedWebhookSecret(number: {
    providerMetadata?: Prisma.JsonValue | null;
  }): string | null {
    const metadata = this.objectMetadata(number.providerMetadata);
    const encryptedSecret = metadata.webhookSecretEncrypted;
    if (!encryptedSecret) return null;
    const value = this.encryption.decryptJson<{ secret?: string }>(encryptedSecret);
    return typeof value.secret === 'string' && value.secret ? value.secret : null;
  }

  private async recordInvalidWebhook(
    provider: 'twilio' | 'vobiz',
    number: { id: string; workspaceId: string },
    payload: Record<string, unknown>,
    eventType: string,
    reason: string,
  ): Promise<void> {
    await this.recordWebhookEvent(
      provider,
      provider === 'twilio'
        ? this.twilioWebhookEventId(payload, eventType, number.id)
        : this.providerWebhookEventId(provider, payload, eventType, number.id),
      eventType,
      number.id,
      payload,
      false,
    );
    await Promise.resolve(
      this.audit.log({
        workspaceId: number.workspaceId,
        action: 'telephony.webhook.invalid_signature',
        resourceType: 'telephony_phone_number',
        resourceId: number.id,
        metadata: { provider, event_type: eventType, reason },
      }),
    ).catch(() => undefined);
  }

  /**
   * Resolves the call row for an inbound provider call, creating it once.
   *
   * Providers retry voice webhooks, so two deliveries can race. The compound
   * `(provider, providerCallId)` key makes the winner unambiguous, and the
   * loser is reconciled by re-reading rather than by creating a second row.
   *
   * `update: {}` is deliberate — a retry must not reset call state — but Prisma
   * does not lower an empty update to a native `INSERT ... ON CONFLICT`, so a
   * concurrent insert surfaces as `P2002` instead of being absorbed. That is
   * caught here and resolved by reading the row the winner created.
   */
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
    const identity = {
      provider: params.provider,
      providerCallId: params.providerCallId,
    };

    let call;
    try {
      call = await this.prisma.call.upsert({
        where: { provider_providerCallId: identity },
        create: {
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
        update: {},
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      call = await this.prisma.call.findUnique({
        where: { provider_providerCallId: identity },
      });
      // The unique index just rejected the insert, so the row exists. If it is
      // gone by the time we read, state is not what the constraint reported and
      // we refuse rather than create a duplicate.
      if (!call) {
        throw new AppError(
          'CALL_IDENTITY_COLLISION',
          'Provider call identity could not be resolved.',
          409,
        );
      }
    }

    if (
      call.workspaceId !== params.workspaceId ||
      call.organizationId !== params.organizationId ||
      call.agentId !== params.agentId ||
      call.phoneNumberId !== params.phoneNumberId
    ) {
      throw new AppError(
        'CALL_IDENTITY_COLLISION',
        'Provider call identity belongs to another tenant.',
        409,
      );
    }
    return call;
  }

  private normalizeStatus(
    provider: 'twilio' | 'vobiz',
    payload: Record<string, unknown>,
  ): NormalizedCallStatus {
    if (provider === 'twilio') {
      const callSid = String(payload.CallSid ?? payload.call_sid ?? '');
      const status = String(payload.CallStatus ?? payload.call_status ?? 'unknown');
      return {
        providerCallId: callSid,
        status,
        eventId: this.twilioWebhookEventId(payload, 'call.status', 'unknown'),
      };
    }
    return {
      providerCallId: String(payload.call_id ?? payload.callId ?? payload.id ?? ''),
      status: String(payload.status ?? payload.call_status ?? 'unknown'),
      eventId: String(payload.event_id ?? payload.id ?? ''),
    };
  }

  private twilioWebhookEventId(
    payload: Record<string, unknown>,
    eventType: string,
    phoneNumberId: string,
  ): string {
    const callSid = String(payload.CallSid ?? payload.call_sid ?? '');
    const status = String(payload.CallStatus ?? payload.call_status ?? '');
    if (callSid && status) return `${callSid}:${eventType}:${status}`;
    if (callSid) return `${callSid}:${eventType}`;
    return `twilio:${eventType}:${phoneNumberId}:${Date.now()}`;
  }

  private providerWebhookEventId(
    provider: string,
    payload: Record<string, unknown>,
    eventType: string,
    phoneNumberId: string,
  ): string {
    const eventId = String(payload.event_id ?? payload.id ?? '');
    const callId = String(payload.call_id ?? payload.callId ?? '');
    if (eventId) return `${provider}:${eventType}:${eventId}`;
    if (callId) return `${provider}:${eventType}:${callId}`;
    return `${provider}:${eventType}:${phoneNumberId}:${Date.now()}`;
  }

  private async recordWebhookEvent(
    provider: string,
    eventId: string,
    eventType: string,
    phoneNumberId: string | null,
    payload: Record<string, unknown>,
    signatureValid: boolean,
    callId: string | null = null,
  ): Promise<'recorded' | 'duplicate' | 'skipped'> {
    if (!eventId) return 'skipped';
    const phoneNumber = phoneNumberId
      ? await this.prisma.telephonyPhoneNumber.findUnique({
          where: { id: phoneNumberId },
          select: { workspaceId: true },
        })
      : null;
    try {
      await this.prisma.telephonyWebhookEvent.create({
        data: {
          provider,
          eventId,
          eventType,
          phoneNumberId,
          callId,
          workspaceId: phoneNumber?.workspaceId ?? null,
          rawPayloadJson: payload as Prisma.InputJsonValue,
          signatureValid,
          status: 'processed',
          processedAt: new Date(),
        },
      });
      return 'recorded';
    } catch (err) {
      // Recording is bookkeeping; a failure to write it must not drop the
      // event. Only a duplicate is a signal the caller acts on.
      return isUniqueConstraintViolation(err) ? 'duplicate' : 'skipped';
    }
  }

  private async workspace(workspaceId: string) {
    return this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
  }

  private async assertByoTelephonyAllowed(organizationId: string): Promise<void> {
    const allowed = await this.billing.checkFeatureGate(organizationId, 'byo_telephony');
    if (!allowed) {
      throw new ForbiddenPlanError(
        'BYO phone numbers and GPT Realtime calling require a paid plan. Free workspaces can use the VoiceForge voice pipeline only.',
        BYO_TELEPHONY_PLAN_LIMIT_DETAILS,
      );
    }
  }

  /** The numbers (or, for a DID-less Vobiz account, trunks) this connection's own credentials can see. */
  /**
   * Re-reads the provider account type on sync so connections made before the
   * flag existed pick it up. A Twilio trial account can only call numbers
   * verified in the Twilio console; every other dial is refused before it
   * rings, and nothing in the call itself says why.
   *
   * The write is a JSON merge in the database, not a read-modify-write:
   * `ensureProviderSipTrunk` stores the Twilio trunk SID and SIP credentials in
   * the same column, and a snapshot taken before the provider round trip would
   * overwrite them.
   */
  private async refreshAccountType(connection: {
    id: string;
    provider: string;
    encryptedCredentials: unknown;
  }): Promise<void> {
    try {
      const credentials = this.encryption.decryptJson<ProviderCredentials>(
        connection.encryptedCredentials,
      );
      const validation = await this.registry
        .adapterFor(connection.provider as never)
        .validateCredentials(credentials);
      if (!validation.valid || !validation.accountType) return;
      await this.prisma.$executeRaw`UPDATE telephony_provider_connections
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('account_type', ${validation.accountType}::text)
        WHERE id = ${connection.id}::uuid`;
    } catch (err) {
      this.logger.warn(
        `Could not refresh the account type of connection ${connection.id}: ${(err as Error).message}`,
      );
    }
  }

  private async providerInventory(connection: {
    provider: string;
    encryptedCredentials: unknown;
  }): Promise<ProviderPhoneNumber[]> {
    const credentials = this.encryption.decryptJson<ProviderCredentials>(
      connection.encryptedCredentials,
    );
    return this.registry.adapterFor(connection.provider as never).listPhoneNumbers(credentials);
  }

  /**
   * Refuses a number whose ownership was never proven against a provider account.
   *
   * `createManualNumber` writes `pending_verification` and nothing used to read
   * it: assign → configure-livekit walked a squatted row straight to
   * `livekit_configured`. Both mutations are gated here, not just assign, because
   * a row assigned before this gate existed would otherwise still be launderable
   * through configure. Outbound placement is gated too, so a pre-existing pending
   * row cannot dial.
   *
   * Inbound is deliberately NOT refused. A carrier only delivers webhooks for
   * numbers actually in its account and the signature is verified against those
   * credentials, so a squatter cannot receive calls for a number it does not
   * hold; refusing inbound here would only drop the legitimate owner's calls
   * while they are mid-verification.
   */
  private assertNumberVerified(number: { status: string; phoneNumberE164: string }): void {
    if (number.status !== 'pending_verification') return;
    throw new AppError(
      'INVALID_STATUS',
      `${number.phoneNumberE164} has not been verified against a provider account. ` +
        'Connect the provider, sync its numbers, and import this one before using it.',
      409,
    );
  }

  private async connection(workspaceId: string, connectionId: string) {
    const connection = await this.prisma.telephonyProviderConnection.findFirst({
      where: { id: connectionId, workspaceId, status: { not: 'disconnected' } },
    });
    if (!connection)
      throw new AppError('TELEPHONY_NOT_FOUND', 'Provider connection not found.', 404);
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
      select: { id: true, name: true, status: true, activeVersionId: true },
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
    metadata?: Prisma.JsonValue | null;
  }) {
    return {
      id: connection.id,
      provider: connection.provider,
      display_name: connection.displayName,
      /** Twilio reports `Trial` or `Full`; other providers have no equivalent. */
      account_type: stringValue(this.objectMetadata(connection.metadata).account_type),
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
    providerMetadata?: Prisma.JsonValue;
    assignedAgent?: { id: string; name: string } | null;
    livekitConfig?: {
      status: string;
      livekitSipHost: string;
      inboundTrunkId: string | null;
      outboundTrunkId: string | null;
      dispatchRuleId: string | null;
    } | null;
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
      carrier_setup: this.carrierSetup(number),
    };
  }

  private webhookUrl(path: string): string {
    return new URL(`/api/v1/${path}`, env.APP_BASE_URL ?? env.WEB_BASE_URL).toString();
  }

  /**
   * Creates (or reuses) the SIP trunk this connection's numbers route through,
   * and remembers it on the connection.
   *
   * Only Twilio implements this: a Twilio number reaches LiveKit either through
   * Programmable Voice (an extra billed leg, inbound only, and it cannot dial
   * out at all) or through an Elastic SIP trunk in the customer's own account.
   * We create the trunk for them, which is what makes "paste your Account SID
   * and pick numbers" enough. Every step of the adapter call looks before it
   * creates, so this is safe on every connect, import and reconfigure.
   */
  private async ensureProviderSipTrunk(connection: {
    id: string;
    provider: string;
    encryptedCredentials: unknown;
    metadata: unknown;
  }): Promise<{
    trunkSid: string;
    domainName: string;
    username?: string;
    password?: string;
  } | null> {
    // 'sip' has no adapter at all: a BYO trunk is configured by hand, by the
    // user, at their own carrier.
    if (connection.provider !== 'twilio' && connection.provider !== 'vobiz') return null;
    const adapter = this.registry.adapterFor(connection.provider);
    if (!adapter.ensureSipTrunk) return null;
    const metadata = this.objectMetadata(connection.metadata);
    const stored = this.objectMetadata(metadata.twilioTrunk);
    const storedUsername = typeof stored.username === 'string' ? stored.username : null;
    const credentials = this.encryption.decryptJson<ProviderCredentials>(
      connection.encryptedCredentials,
    );
    const trunk = await adapter.ensureSipTrunk({
      credentials,
      // Host only: Twilio puts the dialled number in the request URI's user
      // part itself, which is what lets LiveKit match the inbound trunk.
      originationSipUri: `sip:${this.livekit.livekitSipHost};transport=tcp`,
      ...(storedUsername ? { existingUsername: storedUsername } : {}),
      ...(typeof stored.trunkSid === 'string' ? { existingTrunkSid: stored.trunkSid } : {}),
    });
    // A password is only returned the first time it is minted — Twilio never
    // reads one back — so a re-run keeps the stored envelope.
    const passwordEncrypted = trunk.password
      ? (this.encryption.encryptJson({ value: trunk.password }) as unknown)
      : (stored.passwordEncrypted ?? null);
    const username = trunk.username ?? storedUsername;
    await this.prisma.telephonyProviderConnection.update({
      where: { id: connection.id },
      data: {
        metadata: {
          ...metadata,
          twilioTrunk: {
            trunkSid: trunk.trunkSid,
            domainName: trunk.domainName,
            originationUrlSid: trunk.originationUrlSid ?? stored.originationUrlSid ?? null,
            credentialListSid: trunk.credentialListSid ?? stored.credentialListSid ?? null,
            username,
            passwordEncrypted,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const password =
      trunk.password ??
      (passwordEncrypted
        ? this.encryption.decryptJson<{ value?: string }>(passwordEncrypted).value
        : undefined);
    return {
      trunkSid: trunk.trunkSid,
      domainName: trunk.domainName,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  }

  /**
   * Hands a number back to its provider when we stop routing it, so the trunk
   * association does not outlive the row that created it (a number still bound
   * to our trunk cannot be used anywhere else).
   */
  private async removeProviderRouting(number: {
    id: string;
    provider: string;
    phoneNumberE164: string;
    providerNumberId: string | null;
    sipTrunkId: string | null;
    providerMetadata?: Prisma.JsonValue;
    providerConnection?: { encryptedCredentials: unknown; metadata: unknown } | null;
  }): Promise<void> {
    if (!number.providerConnection) return;
    if (number.provider !== 'twilio' && number.provider !== 'vobiz') return;
    const stored = this.objectMetadata(
      this.objectMetadata(number.providerConnection.metadata).twilioTrunk,
    );
    try {
      await this.registry.adapterFor(number.provider).removeRouting({
        credentials: this.encryption.decryptJson<ProviderCredentials>(
          number.providerConnection.encryptedCredentials,
        ),
        phoneNumber: this.connectedNumber(number),
        trunkSid: typeof stored.trunkSid === 'string' ? stored.trunkSid : null,
      });
    } catch (err) {
      // The row is going away either way; a provider that refuses the release
      // must not block the user from removing the number.
      this.logger.warn(
        `Could not release ${number.phoneNumberE164} at ${number.provider}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * What the customer has to give their own carrier for a BYO SIP trunk.
   *
   * Nobody can configure a trunk from a status badge: the carrier needs the
   * exact URI to send INVITEs to, and it will drop LiveKit's INVITEs until its
   * IP allow-list is opened (observed live: `sip.voicelink.co.in` answered
   * nothing at all). Providers we automate get no card -- there is nothing for
   * the user to do -- so this is null for them.
   */
  private carrierSetup(number: {
    provider: string;
    phoneNumberE164: string;
    providerMetadata?: Prisma.JsonValue;
    livekitConfig?: { livekitSipHost: string } | null;
  }): {
    inbound_sip_uri: string;
    auth_username: string | null;
    outbound_sip_domain: string | null;
    ip_allowlist_hint: string;
  } | null {
    if (number.provider !== 'sip') return null;
    const sipHost = number.livekitConfig?.livekitSipHost ?? env.LIVEKIT_SIP_HOST ?? null;
    if (!sipHost) return null;
    const metadata = this.objectMetadata(number.providerMetadata);
    const usernameEnvelope = metadata.sipAuthUsernameEncrypted ?? null;
    return {
      inbound_sip_uri: `sip:${number.phoneNumberE164}@${sipHost};transport=tcp`,
      auth_username: usernameEnvelope
        ? (this.encryption.decryptJson<{ value?: string }>(usernameEnvelope).value ?? null)
        : null,
      outbound_sip_domain:
        typeof metadata.sipTrunkDomain === 'string' ? metadata.sipTrunkDomain : null,
      ip_allowlist_hint:
        "Your carrier must accept SIP from LiveKit Cloud's static IPs (LiveKit Cloud -> Settings -> Static IPs) and permit this number as caller ID. Until it does, inbound INVITEs get no answer and the caller hears silence.",
    };
  }

  private objectMetadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private async liveKitWebhookContext(payload: Record<string, unknown>): Promise<{
    call: {
      id: string;
      workspaceId: string;
      organizationId: string | null;
      status: string;
      outcome: string | null;
      startedAt: Date | null;
      endedAt: Date | null;
      metadata: Prisma.JsonValue | null;
    } | null;
    phoneNumberId: string | null;
    participantId: string | null;
  }> {
    const room = this.objectMetadata(payload.room);
    const participant = this.objectMetadata(payload.participant);
    const participantMetadata = parseJsonObject(participant.metadata);
    const roomName = stringValue(room.name ?? payload.room_name ?? payload.roomName);
    const participantId = stringValue(
      participant.sid ?? participant.identity ?? payload.participant_id,
    );
    const phoneNumberId =
      stringValue(participantMetadata.phoneNumberId) ?? extractPhoneNumberIdFromRoom(roomName);

    const call =
      roomName || participantId
        ? await this.prisma.call.findFirst({
            where: {
              OR: [
                ...(roomName ? [{ livekitRoomName: roomName }] : []),
                ...(participantId ? [{ providerCallId: participantId }] : []),
              ],
            },
            select: {
              id: true,
              workspaceId: true,
              organizationId: true,
              status: true,
              outcome: true,
              startedAt: true,
              endedAt: true,
              metadata: true,
            },
          })
        : null;

    return { call, phoneNumberId: phoneNumberId ?? null, participantId: participantId ?? null };
  }

  private async updateCallFromLiveKitWebhook(
    call: {
      id: string;
      workspaceId: string;
      organizationId: string | null;
      status: string;
      outcome: string | null;
      startedAt: Date | null;
      endedAt: Date | null;
      metadata: Prisma.JsonValue | null;
    },
    eventType: string,
    payload: Record<string, unknown>,
    participantId: string | null,
  ): Promise<void> {
    const normalizedStatus = this.liveKitStatus(eventType, payload);
    if (!normalizedStatus) {
      // The agent or the warm-transfer human leaving is not the caller hanging
      // up; keep the event, leave the call alone.
      await this.recordLiveKitCallEvent(call, eventType, payload);
      return;
    }
    // Whether anyone was ever on the line is the ledger's `connected_at`, which
    // the runtime stamps when the far end answers. The status column is not
    // that truth: the agent joining the room moved a still-dialing call to
    // `in_progress`, and a dial the carrier refused was then filed as
    // `completed` when the room closed.
    const usage = normalizedStatus.terminal
      ? await this.prisma.callUsage.findUnique({
          where: { callId: call.id },
          select: { connectedAt: true },
        })
      : null;
    const neverConnected = usage !== null && usage.connectedAt === null;
    const unanswered = normalizedStatus.terminal
      ? this.unansweredOutcome(call, payload, neverConnected)
      : null;
    // The SIP leg's disconnect reason is the only carrier signal LiveKit gives
    // us; keep it on the call so "no answer" can be told apart from "refused".
    const sipLeg = this.sipLegDisconnect(payload);
    const metadata = sipLeg
      ? ({
          ...this.objectMetadata(call.metadata),
          sip_disconnect_reason: sipLeg.reason,
          ...(sipLeg.status ? { sip_last_status: sipLeg.status } : {}),
        } as Prisma.InputJsonValue)
      : null;
    // Terminal events arrive more than once (participant_left, then
    // room_finished, plus LiveKit's own redelivery). A call already settled as
    // failed must not be promoted to completed by the second one, or the
    // campaign counts a call nobody answered as a success.
    //
    // The read above can be stale as well: the two events for one hang-up are
    // handled concurrently and both see `ringing`. The same guard in the WHERE
    // lets the row decide, so the duplicate that loses the race gets P2025
    // instead of a later write over the failure the winner recorded.
    const endedAt = normalizedStatus.terminal && !call.endedAt ? new Date() : null;
    if (call.status !== 'failed' && call.status !== 'cancelled') {
      try {
        await this.prisma.call.update({
          where: { id: call.id, status: { notIn: ['failed', 'cancelled'] } },
          data: {
            status: unanswered ? 'failed' : normalizedStatus.status,
            ...(unanswered ? { outcome: unanswered } : {}),
            ...(metadata ? { metadata } : {}),
            ...(participantId ? { livekitParticipantId: participantId } : {}),
            ...(endedAt ? { endedAt } : {}),
            ...(endedAt && call.startedAt
              ? {
                  durationSeconds: Math.max(
                    0,
                    Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000),
                  ),
                }
              : {}),
          },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')) {
          throw err;
        }
      }
    } else if (metadata) {
      // The call is already settled; the carrier reason is still worth keeping.
      await this.prisma.call.update({ where: { id: call.id }, data: { metadata } });
    }
    await this.recordLiveKitCallEvent(call, eventType, payload);
  }

  private async recordLiveKitCallEvent(
    call: { id: string; workspaceId: string; organizationId: string | null },
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        workspaceId: call.workspaceId,
        organizationId: call.organizationId,
        eventType: `livekit.${eventType}`,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Whether a participant is the caller's own carrier leg: a SIP participant
   * (LiveKit stamps `sip.callID` on every SIP leg and keeps it after the leg is
   * gone) that is not the warm-transfer human (`sip-human-<callId>`). The agent
   * worker, a browser tester or any other room member leaving must not be filed
   * as the caller hanging up while the carrier leg is still connected.
   */
  private isCarrierLeg(
    participant: Record<string, unknown>,
    attributes: Record<string, unknown>,
  ): boolean {
    if (!('sip.callID' in attributes)) return false;
    return !(stringValue(participant.identity) ?? '').startsWith('sip-human-');
  }

  /** The disconnect reason of a SIP leg's `participant_left`, or null for any other event. */
  private sipLegDisconnect(
    payload: Record<string, unknown>,
  ): { reason: string; status: string | null } | null {
    const participant = this.objectMetadata(payload.participant);
    const attributes = this.objectMetadata(participant.attributes);
    if (!('sip.callID' in attributes)) return null;
    const reason = stringValue(participant.disconnectReason);
    if (!reason) return null;
    return { reason, status: stringValue(attributes['sip.callStatus']) };
  }

  /**
   * The outcome for a call that ended without ever connecting, or null when the
   * call did connect and `completed` is the truth.
   *
   * A dial nobody answers reaches LiveKit as `participant_left` with a
   * `disconnectReason` while the SIP status is still `dialing`, and the plain
   * terminal mapping turned that into `completed` with no outcome: the call list
   * showed an unanswered dial as a finished conversation. A call that did reach
   * `in_progress`, and any call whose outcome is already recorded (a billing
   * denial, for instance), is left alone.
   */
  private unansweredOutcome(
    call: { status: string; outcome: string | null },
    payload: Record<string, unknown>,
    neverConnected: boolean,
  ): string | null {
    if (call.outcome) return null;
    if (!neverConnected && call.status !== 'queued' && call.status !== 'ringing') return null;
    const participant = this.objectMetadata(payload.participant);
    const reason = stringValue(participant.disconnectReason)?.toUpperCase() ?? '';
    if (reason === 'USER_REJECTED') return 'declined';
    if (reason === 'DUPLICATE_IDENTITY' || reason === 'JOIN_FAILURE') return 'agent_connect_failed';
    // A trunk failure is the carrier refusing or failing the dial (SIP 5xx, a
    // rate limit, DNS). Nobody's phone rang, so it is not an unanswered call and
    // it is not the agent's fault: it is the same class as the dispatch errors
    // recorded elsewhere as `provider_dispatch_failed`.
    if (reason === 'SIP_TRUNK_FAILURE') return 'provider_dispatch_failed';
    return 'no_answer';
  }

  /** The call status an event implies, or null when the event says nothing about the call. */
  private liveKitStatus(
    eventType: string,
    payload: Record<string, unknown>,
  ): { status: string; terminal: boolean } | null {
    const participant = this.objectMetadata(payload.participant);
    const attributes = this.objectMetadata(participant.attributes);
    const sipStatus = stringValue(attributes['sip.callStatus'])?.toLowerCase();
    const event = eventType.toLowerCase();
    if (event === 'participant_left' && !this.isCarrierLeg(participant, attributes)) return null;
    // A leg that has left is gone whatever its last attribute said. LiveKit
    // stops updating `sip.callStatus` once the participant disconnects, so a
    // refused dial leaves as `participant_left` still marked `dialing`; letting
    // the attribute win filed that as a non-terminal `queued` and the carrier's
    // disconnect reason was never read.
    const rawStatus =
      event === 'participant_left' || event === 'room_finished' ? event : (sipStatus ?? event);
    const map: Record<string, { status: string; terminal: boolean }> = {
      dialing: { status: 'queued', terminal: false },
      ringing: { status: 'ringing', terminal: false },
      automation: { status: 'in_progress', terminal: false },
      active: { status: 'in_progress', terminal: false },
      hangup: { status: 'completed', terminal: true },
      participant_joined: { status: 'in_progress', terminal: false },
      participant_left: { status: 'completed', terminal: true },
      room_finished: { status: 'completed', terminal: true },
    };
    return map[rawStatus] ?? { status: 'in_progress', terminal: false };
  }

  private normalizeWebhookSecret(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized ? normalized : null;
  }

  private webhookSecretMetadata(secret: string | null): Record<string, unknown> {
    return {
      hasWebhookSecret: Boolean(secret),
      webhookSecretEncrypted: secret ? this.encryption.encryptJson({ secret }) : null,
    };
  }

  private normalizeSipTrunkDomain(
    provider: string,
    value: string | null | undefined,
  ): string | null {
    const raw = value?.trim().replace(/^sip:/, '') ?? '';
    if (!raw) return null;
    const domain = provider === 'vobiz' && !raw.includes('.') ? `${raw}.sip.vobiz.ai` : raw;
    if (!/^[a-zA-Z0-9.-]+$/.test(domain) || !domain.includes('.')) {
      throw new AppError(
        'VALIDATION_ERROR',
        'SIP domain must be a valid host, for example tenant.sip.vobiz.ai.',
        400,
      );
    }
    return domain.toLowerCase();
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
    return ['completed', 'failed', 'busy', 'no-answer', 'cancelled', 'canceled', 'ended'].includes(
      status,
    );
  }

  /**
   * Finds a call from the last minute that a repeated request should be answered
   * with instead of placing a second call.
   *
   * Only a call that is still in flight, or one that genuinely completed, counts.
   * A call that failed terminally (failed, busy, no-answer, cancelled, including
   * a billing denial) must not suppress the retry: the caller replays the row to
   * the API client as a placed call, so returning a dead call reports success for
   * a call that never happened.
   */
  private async findRecentOutboundDuplicate(
    workspaceId: string,
    agentId: string,
    phoneNumberId: string,
    toNumber: string,
  ) {
    const recent = await this.prisma.call.findMany({
      where: {
        workspaceId,
        agentId,
        phoneNumberId,
        toNumber,
        createdAt: { gt: new Date(Date.now() - 60000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    return (
      recent.find((call) => !this.isTerminalStatus(call.status) || call.status === 'completed') ??
      null
    );
  }
}

function cryptoRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractPhoneNumberIdFromRoom(roomName: string | null): string | null {
  if (!roomName) return null;
  const match = roomName.match(
    /^call-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i,
  );
  return match?.[1] ?? null;
}
