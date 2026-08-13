import { Injectable, Logger } from '@nestjs/common';
import type { AgentSpec } from '@voiceforge/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { safeFetch } from '../../common/safe-fetch';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { formatFlowInstructions } from './agent-spec-prompt';
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
} from './voice.provider.interface';

const RetellLlmSchema = z.object({ llm_id: z.string().min(1) });
const RetellAgentSchema = z.object({ agent_id: z.string().min(1) });
const RetellAgentDetailsSchema = z.object({
  response_engine: z.object({
    llm_id: z.string().min(1),
  }),
}).passthrough();
const RetellWebCallSchema = z.object({
  call_id: z.string().min(1),
  access_token: z.string().min(1),
});
const RetellPhoneCallSchema = z.object({
  call_id: z.string().min(1),
  call_status: z.string().optional(),
});
const RetellTranscriptTurnSchema = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
  words: z.array(z.object({ start: z.number().optional() }).passthrough()).optional(),
}).passthrough();
const RetellCallSchema = z.object({
  transcript: z.string().nullable().optional(),
  transcript_object: z.array(RetellTranscriptTurnSchema).optional(),
  recording_url: z.string().url().nullable().optional(),
  duration_ms: z.number().nonnegative().nullable().optional(),
}).passthrough();

function buildGeneralPrompt(spec: AgentSpec): string {
  const instructions = [
    `You are ${spec.identity.agent_name}, a voice agent for ${spec.identity.business_name}.`,
    `Agent name: ${spec.name}.`,
    `Tone: ${spec.voice.tone}.`,
    `Goals: ${spec.goals.join('; ')}.`,
  ];
  if (spec.identity.disclosure) instructions.push(`Disclosure: ${spec.identity.disclosure}`);
  if (spec.compliance.ai_disclosure_required) {
    instructions.push('Disclose that you are an AI assistant at the start of the call.');
  }
  if (spec.compliance.recording_notice_required) {
    instructions.push('Tell the caller that the call is being recorded.');
  }
  if (spec.compliance.opt_out_enabled) {
    instructions.push('Honor opt-out and do-not-call requests immediately and end politely.');
  }
  if (spec.required_fields.length > 0) {
    instructions.push(
      `Capture these required fields: ${spec.required_fields.map((field) => field.key).join(', ')}.`,
    );
  }
  instructions.push(...formatFlowInstructions(spec));
  return instructions.join('\n');
}

@Injectable()
export class RetellVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'retell';
  private readonly logger = new Logger(RetellVoiceAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const llm = await this.request('POST', '/create-retell-llm', {
      general_prompt: buildGeneralPrompt(input.spec),
      begin_message: input.spec.conversation_rules.first_message,
    }, RetellLlmSchema);

    const agent = await this.request('POST', '/create-agent', {
      agent_name: input.spec.name,
      voice_id: input.spec.voice.voice_id ?? env.RETELL_VOICE_ID,
      language: input.spec.language,
      response_engine: {
        type: 'retell-llm',
        llm_id: llm.llm_id,
      },
      metadata: {
        voiceforge_workspace_id: input.workspaceId,
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
      },
    }, RetellAgentSchema);

    await this.prisma.agentVersion.update({
      where: { id: input.agentVersionId },
      data: { providerRuntimeId: agent.agent_id },
    });
    return { provider_runtime_id: agent.agent_id };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    const agent = await this.request(
      'GET',
      `/get-agent/${encodeURIComponent(input.provider_runtime_id)}`,
      undefined,
      RetellAgentDetailsSchema,
    );
    await this.request(
      'PATCH',
      `/update-retell-llm/${encodeURIComponent(agent.response_engine.llm_id)}`,
      {
        general_prompt: buildGeneralPrompt(input.spec),
        begin_message: input.spec.conversation_rules.first_message,
      },
      z.unknown(),
    );
    await this.request('PATCH', `/update-agent/${encodeURIComponent(input.provider_runtime_id)}`, {
      agent_name: input.spec.name,
      voice_id: input.spec.voice.voice_id ?? env.RETELL_VOICE_ID,
      language: input.spec.language,
    }, z.unknown());
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    const providerRuntimeId = await this.runtimeId(input.agentVersionId);
    const call = await this.request('POST', '/v2/create-web-call', {
      agent_id: providerRuntimeId,
      metadata: {
        voiceforge_workspace_id: input.workspaceId,
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
      },
    }, RetellWebCallSchema);

    return {
      test_session_id: call.call_id,
      token: call.access_token,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const fromNumber = input.fromNumber ?? env.RETELL_FROM_NUMBER;
    if (!fromNumber) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Retell outbound calling requires fromNumber or RETELL_FROM_NUMBER.',
        400,
      );
    }

    const providerRuntimeId = await this.runtimeId(input.agentVersionId);
    const call = await this.request('POST', '/v2/create-phone-call', {
      from_number: fromNumber,
      to_number: input.toNumber,
      override_agent_id: providerRuntimeId,
      metadata: {
        voiceforge_workspace_id: input.workspaceId,
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        ...(input.metadata ?? {}),
      },
    }, RetellPhoneCallSchema);
    return {
      provider_call_id: call.call_id,
      status: call.call_status === 'ringing' ? 'ringing' : 'queued',
    };
  }

  async transferCall(_input: TransferCallInput): Promise<void> {
    throw new AppError(
      'VOICE_PROVIDER_ERROR',
      'Retell call transfers must be configured as a transfer-call tool on the agent.',
      501,
    );
  }

  async endCall(input: EndCallInput): Promise<void> {
    await this.request(
      'POST',
      `/v2/stop-call/${encodeURIComponent(input.callId)}`,
      {},
      z.unknown(),
    );
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    const call = await this.getCall(input.callId);
    const turns = (call.transcript_object ?? [])
      .filter((turn) => Boolean(turn.content))
      .map((turn) => ({
        speaker: (turn.role === 'agent' ? 'agent' : 'caller') as 'agent' | 'caller',
        text: turn.content ?? '',
        at_ms: Math.round((turn.words?.[0]?.start ?? 0) * 1000),
      }));
    return {
      transcript: call.transcript ?? turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n'),
      turns,
    };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    const call = await this.getCall(input.callId);
    return {
      url: call.recording_url ?? null,
      duration_seconds: call.duration_ms == null ? null : call.duration_ms / 1000,
    };
  }

  async handleWebhook(
    payload: Record<string, unknown>,
    _signature?: string,
  ): Promise<{ event: string; callId: string; processed: boolean }> {
    const event = String(payload['event'] ?? payload['event_type'] ?? 'unknown');
    const call = payload['call'];
    const callId = typeof call === 'object' && call !== null
      ? String((call as Record<string, unknown>)['call_id'] ?? '')
      : String(payload['call_id'] ?? '');
    this.logger.log(`Retell webhook: ${event} for call ${callId}`);
    return { event, callId, processed: true };
  }

  private async getCall(callId: string) {
    return this.request(
      'GET',
      `/v2/get-call/${encodeURIComponent(callId)}`,
      undefined,
      RetellCallSchema,
    );
  }

  private async runtimeId(agentVersionId: string): Promise<string> {
    const version = await this.prisma.agentVersion.findUnique({
      where: { id: agentVersionId },
      select: { providerRuntimeId: true },
    });
    if (!version?.providerRuntimeId) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `No Retell agent found for agent version ${agentVersionId}. Ensure the agent is published.`,
        400,
      );
    }
    return version.providerRuntimeId;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (!env.RETELL_API_KEY) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Retell adapter is not configured. Set RETELL_API_KEY and VOICE_PROVIDER=retell.',
        501,
      );
    }
    const baseUrl = env.RETELL_BASE_URL.replace(/\/$/, '');
    const response = await safeFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `Retell API error ${response.status} on ${method} ${path}.`,
        502,
        { status: response.status, path, method },
      );
    }
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new AppError(
          'VOICE_PROVIDER_ERROR',
          'Retell returned an invalid JSON response.',
          502,
        );
      }
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Retell response failed validation.',
        502,
        { issues: parsed.error.flatten() },
      );
    }
    return parsed.data;
  }
}
