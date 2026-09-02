import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AccessToken,
  AgentDispatchClient,
  RoomAgentDispatch,
  RoomConfiguration,
  RoomServiceClient,
  SipClient,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { AppError } from '../common/errors';
import { env } from '../config/env';
import type {
  CreateDispatchRuleParams,
  CreateInboundSipTrunkParams,
  CreateOutboundCallParams,
  CreateOutboundSipTrunkParams,
  LiveKitDispatchRuleResult,
  LiveKitOutboundCallResult,
  LiveKitRoomResult,
  LiveKitSipTrunkResult,
} from './livekit.types';

interface LiveKitClients {
  sipClient?: Pick<
    SipClient,
    'createSipInboundTrunk' | 'createSipOutboundTrunk' | 'createSipDispatchRule' | 'createSipParticipant' | 'deleteSipTrunk' | 'deleteSipDispatchRule'
  >;
  roomClient?: Pick<RoomServiceClient, 'createRoom' | 'removeParticipant'>;
  agentDispatchClient?: Pick<AgentDispatchClient, 'createDispatch'>;
}

export const LIVEKIT_CLIENTS = Symbol('LIVEKIT_CLIENTS');

@Injectable()
export class LiveKitService {
  private readonly logger = new Logger(LiveKitService.name);
  private readonly sipClient?: LiveKitClients['sipClient'];
  private readonly roomClient?: LiveKitClients['roomClient'];
  private readonly agentDispatchClient?: LiveKitClients['agentDispatchClient'];

  constructor(@Optional() @Inject(LIVEKIT_CLIENTS) clients?: LiveKitClients) {
    const resolvedClients = clients ?? {};
    this.sipClient = resolvedClients.sipClient ?? this.buildSipClient();
    this.roomClient = resolvedClients.roomClient ?? this.buildRoomClient();
    this.agentDispatchClient = resolvedClients.agentDispatchClient ?? this.buildAgentDispatchClient();
  }

  get livekitSipHost(): string {
    if (!env.LIVEKIT_SIP_HOST) {
      // A missing SIP host is an operator gap, not a code fault: the deploy gate
      // should stop a host that has the LiveKit triplet but no SIP host. A 4xx
      // keeps this off the default error-tracking path, where a captured 500
      // reads like a bug in the assign flow that reaches this getter.
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LIVEKIT_SIP_HOST is not configured.', 422);
    }
    return env.LIVEKIT_SIP_HOST.replace(/^sip:/, '');
  }

  async createRoomForCall(params: { roomName: string; metadata?: Record<string, unknown> }): Promise<LiveKitRoomResult> {
    if (this.roomClient) {
      await this.roomClient.createRoom({
        name: params.roomName,
        metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
      });
    }
    return { roomName: params.roomName };
  }

  /**
   * Hangs up one participant's leg.
   *
   * Removing a SIP participant makes LiveKit send BYE to the carrier, which is
   * the only way to refuse an inbound call that has already been answered into
   * a room (the Twilio TwiML path can just return refusal TwiML; a call that
   * arrived straight over SIP cannot). Best-effort: the caller has already
   * decided the call is over, so a failure here is logged, not thrown.
   */
  async hangUpParticipant(roomName: string, identity: string): Promise<void> {
    if (!this.roomClient) return;
    try {
      await this.roomClient.removeParticipant(roomName, identity);
    } catch (err) {
      this.logger.warn(
        `Could not remove participant ${identity} from room ${roomName}: ${(err as Error).message}`,
      );
    }
  }

  async createAccessToken(params: {
    userId: string;
    roomName: string;
    identity: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    this.assertCredentials();
    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: params.identity,
      ttl: '15m',
      metadata: JSON.stringify({ userId: params.userId, ...(params.metadata ?? {}) }),
    });
    token.addGrant({ roomJoin: true, room: params.roomName });
    return token.toJwt();
  }

  /**
   * Dispatches an agent worker into a room that has no SIP leg.
   *
   * A browser test has no telephony participant, so it cannot ride along with
   * `createOutboundCall`; the room is joined directly from the browser and the
   * worker must be asked for separately.
   */
  async dispatchAgent(params: {
    roomName: string;
    agentName: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.requireAgentDispatchClient().createDispatch(params.roomName, params.agentName, {
      metadata: JSON.stringify(params.metadata),
    });
  }

  /**
   * The client-facing WebSocket URL of the LiveKit deployment. Browser tests
   * need it alongside their access token, and it is required rather than
   * optional because a token without a server address is unusable.
   */
  get livekitUrl(): string {
    if (!env.LIVEKIT_URL) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LIVEKIT_URL is not configured.', 500);
    }
    return env.LIVEKIT_URL;
  }

  async createInboundSipTrunk(params: CreateInboundSipTrunkParams): Promise<LiveKitSipTrunkResult> {
    const client = this.requireSipClient();
    const metadata = JSON.stringify({
      workspaceId: params.workspaceId,
      phoneNumberId: params.phoneNumberId,
      provider: params.provider,
      direction: 'inbound',
    });
    const result = await client.createSipInboundTrunk(
      `VoiceForge ${params.provider} ${params.phoneNumberE164} inbound`,
      [params.phoneNumberE164],
      {
        metadata,
        ...(params.authUsername ? { authUsername: params.authUsername } : {}),
        ...(params.authPassword ? { authPassword: params.authPassword } : {}),
      },
    );
    return { trunkId: result.sipTrunkId };
  }

  async createOutboundSipTrunk(params: CreateOutboundSipTrunkParams): Promise<LiveKitSipTrunkResult> {
    const client = this.requireSipClient();
    const address = params.sipAddress ?? this.providerOutboundAddress(params.provider);
    const result = await client.createSipOutboundTrunk(
      `VoiceForge ${params.provider} ${params.phoneNumberE164} outbound`,
      address,
      [params.phoneNumberE164],
      {
        metadata: JSON.stringify({
          workspaceId: params.workspaceId,
          phoneNumberId: params.phoneNumberId,
          provider: params.provider,
          direction: 'outbound',
        }),
        transport: 0 as never,
        ...(params.authUsername ? { authUsername: params.authUsername } : {}),
        ...(params.authPassword ? { authPassword: params.authPassword } : {}),
      },
    );
    return { trunkId: result.sipTrunkId };
  }

  async createDispatchRule(params: CreateDispatchRuleParams): Promise<LiveKitDispatchRuleResult> {
    const client = this.requireSipClient();
    const metadata = {
      workspaceId: params.workspaceId,
      phoneNumberId: params.phoneNumberId,
      agentId: params.agentId,
      ...(params.metadata ?? {}),
    };
    const result = await client.createSipDispatchRule(
      { type: 'individual', roomPrefix: params.roomPrefix },
      {
        name: `VoiceForge dispatch ${params.phoneNumberId}`,
        trunkIds: [params.trunkId],
        metadata: JSON.stringify(metadata),
        roomConfig: new RoomConfiguration({
          agents: [
            new RoomAgentDispatch({
              agentName: params.agentName,
              metadata: JSON.stringify(metadata),
            }),
          ],
        }),
      },
    );
    return { dispatchRuleId: result.sipDispatchRuleId };
  }

  async deleteSipTrunk(trunkId: string): Promise<void> {
    await this.requireSipClient().deleteSipTrunk(trunkId);
  }

  async deleteDispatchRule(dispatchRuleId: string): Promise<void> {
    await this.requireSipClient().deleteSipDispatchRule(dispatchRuleId);
  }

  async createOutboundCall(params: CreateOutboundCallParams): Promise<LiveKitOutboundCallResult> {
    const participantMetadata = {
      phoneNumberId: params.phoneNumberId,
      agentId: params.agentId,
      direction: 'outbound',
      ...(params.metadata ?? {}),
    };
    if (params.agentName) {
      await this.requireAgentDispatchClient().createDispatch(params.roomName, params.agentName, {
        metadata: JSON.stringify(participantMetadata),
      });
    }
    const result = await this.requireSipClient().createSipParticipant(
      params.outboundTrunkId,
      params.toNumber,
      params.roomName,
      {
        fromNumber: params.fromNumber,
        participantIdentity: `sip-${params.phoneNumberId}`,
        participantMetadata: JSON.stringify(participantMetadata),
        waitUntilAnswered: false,
      },
    );
    return {
      providerCallId: result.participantId ?? params.roomName,
      roomName: params.roomName,
      status: 'queued',
    };
  }

  verifyWebhook(rawBody: string, authorization: string | undefined): Promise<unknown> {
    this.assertCredentials();
    if (!authorization) {
      throw new AppError('UNAUTHORIZED', 'Missing LiveKit webhook authorization.', 401);
    }
    const apiKey = env.LIVEKIT_API_KEY;
    const apiSecret = env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LiveKit API credentials are not configured.', 500);
    }
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    return receiver.receive(rawBody, authorization);
  }

  private requireSipClient(): NonNullable<LiveKitClients['sipClient']> {
    if (!this.sipClient) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LiveKit SIP is not configured.', 500);
    }
    return this.sipClient;
  }

  private requireAgentDispatchClient(): NonNullable<LiveKitClients['agentDispatchClient']> {
    if (!this.agentDispatchClient) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LiveKit agent dispatch is not configured.', 500);
    }
    return this.agentDispatchClient;
  }

  private buildSipClient(): SipClient | undefined {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      this.logger.warn('LiveKit env vars are not fully set; LiveKit SIP operations are disabled.');
      return undefined;
    }
    return new SipClient(this.livekitHttpUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  private buildRoomClient(): RoomServiceClient | undefined {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return undefined;
    return new RoomServiceClient(this.livekitHttpUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  private buildAgentDispatchClient(): AgentDispatchClient | undefined {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return undefined;
    return new AgentDispatchClient(this.livekitHttpUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  private assertCredentials(): void {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LiveKit API credentials are not configured.', 500);
    }
  }

  private livekitHttpUrl(): string {
    this.assertCredentials();
    const url = env.LIVEKIT_URL;
    if (!url) {
      throw new AppError('LIVEKIT_NOT_CONFIGURED', 'LIVEKIT_URL is not configured.', 500);
    }
    return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  }

  private providerOutboundAddress(provider: string): string {
    const address = provider === 'twilio' ? env.TWILIO_SIP_DOMAIN : null;
    if (!address) {
      throw new AppError(
        'LIVEKIT_NOT_CONFIGURED',
        provider === 'vobiz'
          ? 'Vobiz outbound SIP domain must be provided by the user for this trunk.'
          : `Outbound SIP domain is not configured for ${provider}.`,
        500,
      );
    }
    return address.replace(/^sip:/, '');
  }
}
