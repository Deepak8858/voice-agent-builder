import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BrowserTestSessionResult,
  CreateBrowserTestSessionInput,
  CreateRuntimeAgentInput,
  CreateRuntimeAgentResult,
  EndCallInput,
  GetRecordingInput,
  GetTranscriptInput,
  RecordingResult,
  StartOutboundCallInput,
  StartOutboundCallResult,
  TranscriptResult,
  TransferCallInput,
  UpdateRuntimeAgentInput,
  VoiceRuntimeProvider,
} from '../voice/adapters/voice.provider.interface';

@Injectable()
export class TwilioVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioVoiceAdapter.name);
  private readonly agentIdMap = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const { agentId, agentVersionId, workspaceId } = input;

    const providerRuntimeId = `twilio_agent_${agentVersionId}`;
    this.agentIdMap.set(agentVersionId, providerRuntimeId);

    const numbers = await this.prisma.twilioPhoneNumber.findMany({
      where: { workspaceId, status: 'active' },
      take: 1,
    });

    this.logger.log(
      `Twilio agent created: ${providerRuntimeId} for agent ${agentId}, ${numbers.length} number(s) available`,
    );

    return { provider_runtime_id: providerRuntimeId };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    this.logger.log(`Twilio agent update for ${input.provider_runtime_id}`);
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    return {
      test_session_id: `browser_test_${Date.now()}`,
      web_socket_url: `${env.WEB_BASE_URL}/voice/test/ws`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const number = await this.prisma.twilioPhoneNumber.findFirst({
      where: { agentId: input.agentId, status: 'active' },
    });

    if (!number) {
      throw new AppError(
        'NO_PHONE_NUMBER',
        `No active phone number for agent ${input.agentId}. Provision a number first.`,
        400,
      );
    }

    const call = await this.twilioCreateCall({
      to: input.toNumber,
      from: number.phoneNumber,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
    });

    return { provider_call_id: call.sid, status: 'queued' };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    await this.twilioUpdateCall(input.callId, {
      Twiml: `<Response><Dial><Number>${input.targetNumber}</Number></Dial></Response>`,
    });
  }

  async endCall(input: EndCallInput): Promise<void> {
    await this.twilioUpdateCall(input.callId, { Status: 'completed' });
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    return { transcript: '', turns: [] };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    return { url: null, duration_seconds: null };
  }

  async handleWebhook(
    payload: Record<string, unknown>,
  ): Promise<{ event: string; callId: string; processed: boolean }> {
    const event = (payload['CallStatus'] ?? payload['call_status'] ?? 'unknown') as string;
    const callSid = (payload['CallSid'] ?? payload['call_sid'] ?? '') as string;

    this.logger.log(`Twilio webhook: ${event} for call ${callSid}`);

    return { event, callId: callSid, processed: true };
  }

  private get accountSid(): string {
    const sid = env.TWILIO_ACCOUNT_SID;
    if (!sid) throw new AppError('TWILIO_NOT_CONFIGURED', 'TWILIO_ACCOUNT_SID not set', 500);
    return sid;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  }

  private async twilioCreateCall(params: {
    to: string;
    from: string;
    workspaceId: string;
    agentId: string;
    agentVersionId: string;
  }): Promise<{ sid: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls.json`;

    const formData = new URLSearchParams({
      To: params.to,
      From: params.from,
      Url: `${env.TWILIO_TWIML_WEBHOOK_URL}/voice/webhook/inbound`,
      StatusCallback: `${env.TWILIO_STATUS_WEBHOOK_URL}/voice/webhook/status`,
      StatusCallbackEvent: 'initiated,ringing,in-progress,completed',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AppError('TWILIO_CALL_FAILED', `Twilio create call failed: ${text}`, res.status);
    }

    return res.json() as Promise<{ sid: string }>;
  }

  private async twilioUpdateCall(callSid: string, data: Record<string, string>): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`;

    const formData = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
      formData.set(k, v);
    }

    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
  }
}
