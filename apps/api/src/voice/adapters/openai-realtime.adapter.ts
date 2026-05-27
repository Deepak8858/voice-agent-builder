import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentSpec } from '@voiceforge/shared';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
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

const ClientSecretResponseSchema = z.object({
  client_secret: z.object({
    value: z.string().min(1),
    expires_at: z.number().int().positive(),
  }),
});

function openAiRealtimeRuntimeId(agentVersionId: string): string {
  return `openai_rt_${agentVersionId}`;
}

function compactPhoneForId(phone: string): string {
  return phone.replace(/[^0-9A-Za-z]/g, '') || 'unknown';
}

function realtimeHttpBaseUrl(): string {
  return env.OPENAI_REALTIME_BASE_URL.replace(/\/$/, '');
}

function realtimeWebSocketUrl(): string {
  const base = realtimeHttpBaseUrl().replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  return `${base}/realtime?model=${encodeURIComponent(env.OPENAI_REALTIME_MODEL)}`;
}

function buildInstructions(spec: AgentSpec): string {
  const lines: string[] = [
    `You are ${spec.identity.agent_name}, a voice agent for ${spec.identity.business_name}.`,
    `Agent name: ${spec.name}.`,
    `Tone: ${spec.voice.tone}.`,
    `Goals: ${spec.goals.join('; ')}.`,
  ];

  if (spec.identity.disclosure) {
    lines.push(`Disclosure: ${spec.identity.disclosure}`);
  }
  if (spec.conversation_rules.first_message) {
    lines.push(`Opening message: ${spec.conversation_rules.first_message}`);
  }
  if (spec.required_fields.length) {
    lines.push(
      `Required fields to capture: ${spec.required_fields
        .map((field) => `${field.key} (${field.type})`)
        .join(', ')}.`,
    );
  }
  if (spec.conversation_rules.ask_one_question_at_a_time) {
    lines.push('Ask one question at a time.');
  }
  if (spec.conversation_rules.confirm_critical_information) {
    lines.push('Confirm critical information before taking action.');
  }
  if (spec.conversation_rules.do_not_make_up_answers) {
    lines.push('Do not make up answers. Say when information is unavailable.');
  }
  if (spec.conversation_rules.fallback_to_human_when_unsure) {
    lines.push('Offer a human handoff when you are unsure.');
  }
  if (spec.compliance.ai_disclosure_required) {
    lines.push('You MUST disclose that you are an AI assistant at the start of the call.');
  }
  if (spec.compliance.recording_notice_required) {
    lines.push('You MUST tell the caller this call is being recorded.');
  }
  if (spec.compliance.opt_out_enabled) {
    lines.push('If the caller asks to stop, opt out, or not be called, acknowledge and end politely.');
  }

  return lines.join('\n');
}

function buildSessionConfig(spec: AgentSpec): Record<string, unknown> {
  return {
    type: 'realtime',
    model: env.OPENAI_REALTIME_MODEL,
    instructions: buildInstructions(spec),
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: { type: 'semantic_vad' },
      },
      output: {
        format: { type: 'audio/pcm' },
        voice: spec.voice.voice_id ?? env.OPENAI_REALTIME_VOICE,
      },
    },
  };
}

@Injectable()
export class OpenAIRealtimeVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'openai-realtime';
  private readonly logger = new Logger(OpenAIRealtimeVoiceAdapter.name);
  private readonly mockTranscripts = new Map<string, TranscriptResult>();

  constructor(private readonly prisma: PrismaService) {}

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const providerRuntimeId = openAiRealtimeRuntimeId(input.agentVersionId);

    await this.prisma.agentVersion.update({
      where: { id: input.agentVersionId },
      data: { providerRuntimeId },
    });

    return { provider_runtime_id: providerRuntimeId };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    if (!input.provider_runtime_id) {
      await this.createAgent(input);
    }
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    const spec = await this.loadSpec(input.agentVersionId);
    const testSessionId = `${env.OPENAI_API_KEY ? 'openai_rt_test' : 'openai_mock_test'}_${input.agentVersionId}_${Date.now()}`;

    if (!env.OPENAI_API_KEY) {
      this.logger.warn('OPENAI_API_KEY is not set; returning mock OpenAI Realtime browser session.');
      this.mockTranscripts.set(testSessionId, this.buildMockTranscript(spec));
      return {
        test_session_id: testSessionId,
        web_socket_url: realtimeWebSocketUrl(),
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
    }

    const response = await this.openAiRequest('/realtime/client_secrets', {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: buildSessionConfig(spec),
    });

    this.mockTranscripts.set(testSessionId, this.buildMockTranscript(spec));

    return {
      test_session_id: testSessionId,
      web_socket_url: realtimeWebSocketUrl(),
      token: response.client_secret.value,
      expires_at: new Date(response.client_secret.expires_at * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const providerCallId = `openai_mock_call_${input.agentVersionId}_${compactPhoneForId(input.toNumber)}`;
    this.logger.warn(
      'OpenAI Realtime outbound PSTN bridge is not configured; queued deterministic mock outbound call.',
    );
    return { provider_call_id: providerCallId, status: 'queued' };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    this.logger.log(`OpenAI Realtime transfer requested for ${input.callId} to ${input.targetNumber}.`);
  }

  async endCall(input: EndCallInput): Promise<void> {
    this.logger.log(`OpenAI Realtime end requested for ${input.callId}.`);
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    return this.mockTranscripts.get(input.callId) ?? { transcript: '', turns: [] };
  }

  async getRecording(_input: GetRecordingInput): Promise<RecordingResult> {
    return { url: null, duration_seconds: null };
  }

  async handleWebhook(
    payload: Record<string, unknown>,
    _signature?: string,
  ): Promise<{ event: string; callId: string; processed: boolean }> {
    const rawEvent = String(payload['event_type'] ?? payload['type'] ?? 'unknown');
    const callId = String(payload['provider_call_id'] ?? payload['call_id'] ?? payload['id'] ?? '');
    const event = this.normalizeEvent(rawEvent);

    this.logger.log(`OpenAI Realtime webhook: ${rawEvent} for call ${callId}`);
    return { event, callId, processed: true };
  }

  private async loadSpec(agentVersionId: string): Promise<AgentSpec> {
    const version = await this.prisma.agentVersion.findUnique({
      where: { id: agentVersionId },
      select: { specJson: true },
    });
    if (!version?.specJson) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `No Agent Spec JSON found for agent version ${agentVersionId}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return version.specJson as unknown as AgentSpec;
  }

  private async openAiRequest(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${realtimeHttpBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `OpenAI Realtime API error ${res.status}: ${text}`,
        HttpStatus.BAD_GATEWAY,
        { status: res.status, path },
      );
    }

    const json = await res.json();
    const parsed = ClientSecretResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'OpenAI Realtime client secret response failed validation.',
        HttpStatus.BAD_GATEWAY,
        { issues: parsed.error.flatten() },
      );
    }
    return parsed.data;
  }

  private buildMockTranscript(spec: AgentSpec): TranscriptResult {
    const firstMessage =
      spec.conversation_rules.first_message ??
      `Hello, this is ${spec.identity.agent_name} from ${spec.identity.business_name}.`;
    const turns: TranscriptResult['turns'] = [
      { speaker: 'agent', text: firstMessage, at_ms: 0 },
      { speaker: 'caller', text: 'Hi, I would like to test this agent.', at_ms: 1800 },
      {
        speaker: 'agent',
        text: 'I can help with that. What would you like to check first?',
        at_ms: 3600,
      },
    ];
    return {
      transcript: turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n'),
      turns,
    };
  }

  private normalizeEvent(event: string): string {
    switch (event) {
      case 'realtime.call.incoming':
      case 'session.created':
      case 'call.started':
        return 'call.started';
      case 'session.ended':
      case 'response.done':
      case 'call.ended':
        return 'call.ended';
      default:
        return event;
    }
  }
}
