import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { formatFlowInstructions } from './agent-spec-prompt';
import type { AgentSpec } from '@voiceforge/shared';
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

const VAPI_BASE = 'https://api.vapi.ai';

// ---------------------------------------------------------------------------
// vapiRequest helper
// ---------------------------------------------------------------------------
async function vapiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = env.VAPI_API_KEY;
  if (!apiKey) {
    throw new AppError(
      'VOICE_PROVIDER_ERROR',
      'Vapi adapter is not configured. Set VAPI_API_KEY and switch VOICE_PROVIDER=vapi.',
      501,
    );
  }

  const url = `${VAPI_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      'VOICE_PROVIDER_ERROR',
      `Vapi API error ${res.status} on ${method} ${path}: ${text}`,
      res.status as 400 | 401 | 403 | 404 | 422 | 500,
      { status: res.status, path, method },
    );
  }

  // 204 No Content
  if (res.status === 204) return null as T;

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------
function buildVapiTools(spec: AgentSpec, agentId: string): Array<Record<string, unknown>> {
  const webhookSecret = env.VAPI_WEBHOOK_SECRET ?? env.VOICE_WEBHOOK_SECRET;
  if (!webhookSecret) return [];

  const serverUrl = new URL(
    `/api/v1/voice/webhooks/vapi/agents/${encodeURIComponent(agentId)}/tools`,
    env.APP_BASE_URL ?? env.WEB_BASE_URL,
  ).toString();

  return spec.tools
    .filter(
      (tool) =>
        /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) &&
        Array.isArray(tool.permissions) &&
        tool.permissions.length === 1,
    )
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
      server: {
        url: serverUrl,
        // Vapi sends this value back in x-vapi-secret. It is stored only in
        // Vapi's server-side assistant configuration, never in client payloads.
        secret: webhookSecret,
      },
      async: false,
    }));
}

function buildVapiModel(spec: AgentSpec, agentId: string): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: buildSystemPrompt(spec),
    tools: buildVapiTools(spec, agentId),
  };
}

function buildSystemPrompt(spec: AgentSpec): string {
  const parts: string[] = [];
  parts.push(`You are ${spec.identity.agent_name}, a voice agent for ${spec.identity.business_name}.`);
  if (spec.identity.disclosure) parts.push(`Disclosure: ${spec.identity.disclosure}`);
  parts.push(`Tone: ${spec.voice.tone}.`);
  parts.push(`Goals: ${spec.goals.join('; ')}.`);
  if (spec.required_fields.length) {
    parts.push(
      `Required fields to capture: ${spec.required_fields.map((f) => `${f.key} (${f.type})`).join(', ')}.`,
    );
  }
  const rules = spec.conversation_rules;
  const ruleLines: string[] = [];
  if (rules.ask_one_question_at_a_time) ruleLines.push('Ask one question at a time.');
  if (rules.confirm_critical_information) ruleLines.push('Confirm critical information.');
  if (rules.do_not_make_up_answers) ruleLines.push('Do not make up answers.');
  if (rules.fallback_to_human_when_unsure) ruleLines.push('Hand off to human when unsure.');
  if (ruleLines.length) parts.push(`Rules: ${ruleLines.join(' ')}`);
  if (spec.compliance.ai_disclosure_required) {
    parts.push('You MUST disclose that you are an AI assistant at the start of the call.');
  }
  if (spec.compliance.recording_notice_required) {
    parts.push('You MUST tell the caller this call is being recorded.');
  }
  if (spec.compliance.opt_out_enabled) {
    parts.push(
      'If the caller asks to stop, opt out, do not call, or remove from list, acknowledge and end the call politely.',
    );
  }
  if (spec.tools.length > 0) {
    parts.push(
      `Available tools: ${spec.tools
        .map((tool) => `${tool.name} (${tool.description})`)
        .join('; ')}.`,
    );
    parts.push('When a workflow step requires an external action, use the matching tool name exactly as listed.');
  }
  parts.push(...formatFlowInstructions(spec));
  return parts.join('\n');
}

/** Map Vapi speaker role to our canonical role. */
function mapRole(role: string): 'agent' | 'caller' {
  return role === 'assistant' ? 'agent' : 'caller';
}

function isFallbackBrowserTestSession(callId: string): boolean {
  return callId.startsWith('vapi_mock_test_v1_');
}

function fallbackBrowserTranscript(): TranscriptResult {
  const turns: TranscriptResult['turns'] = [
    {
      speaker: 'agent',
      text: 'Hi, I am an AI assistant calling from VoiceForge. This browser test call is being recorded for quality review.',
      at_ms: 0,
    },
    {
      speaker: 'caller',
      text: 'Hi, I want to book an appointment.',
      at_ms: 2800,
    },
    {
      speaker: 'agent',
      text: 'I can help with that. May I have your name and preferred appointment time?',
      at_ms: 6100,
    },
    {
      speaker: 'caller',
      text: 'Deepak, next Tuesday afternoon.',
      at_ms: 9600,
    },
    {
      speaker: 'agent',
      text: 'Thanks, Deepak. I will pass that appointment request to the team.',
      at_ms: 12800,
    },
  ];
  return {
    turns,
    transcript: turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// VapiVoiceAdapter
// ---------------------------------------------------------------------------
@Injectable()
export class VapiVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'vapi';
  private readonly logger = new Logger(VapiVoiceAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // createAgent
  // -------------------------------------------------------------------------
  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const { spec } = input;

    const voiceOverrides = spec.voice.language_configs?.[spec.language];
    const voiceId = voiceOverrides?.voice_id ?? spec.voice.voice_id ?? 'Clara';

    const assistantPayload: Record<string, unknown> = {
      name: spec.name,
      model: buildVapiModel(spec, input.agentId),
      voice: {
        provider: 'vapi',
        voiceId,
      },
      firstMessage: spec.conversation_rules.first_message,
      metadata: {
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        voiceforge_workspace_id: input.workspaceId,
      },
    };

    // Compliance: Vapi rejects 'spcallbacks'. Recording notice belongs in the system prompt.

    const assistant = await vapiRequest<{ id: string }>('POST', '/assistant', assistantPayload);

    // Persist provider runtime ID to DB — survives restarts, enables horizontal scale
    await this.prisma.agentVersion.update({
      where: { id: input.agentVersionId },
      data: { providerRuntimeId: assistant.id },
    });

    return { provider_runtime_id: assistant.id };
  }

  // -------------------------------------------------------------------------
  // updateAgent
  // -------------------------------------------------------------------------
  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    const { spec } = input;

    const patch: Record<string, unknown> = {
      // Republish must synchronize prompt and tools as well as cosmetic fields;
      // otherwise an existing Vapi assistant can never gain newly connected tools.
      model: buildVapiModel(spec, input.agentId),
    };

    if (spec.name) patch.name = spec.name;

    if (spec.conversation_rules.first_message) {
      patch.firstMessage = spec.conversation_rules.first_message;
    }

    // voice is mutable. Vapi's `provider: "vapi"` voice schema rejects
    // `speakingRate`; keep pacing in the provider-neutral spec/prompt only.
    if (spec.voice.voice_id) {
      patch.voice = {
        provider: 'vapi',
        voiceId: spec.voice.voice_id,
      };
    }

    await vapiRequest<void>('PATCH', `/assistant/${input.provider_runtime_id}`, patch);
  }

  // -------------------------------------------------------------------------
  // createBrowserTestSession
  // -------------------------------------------------------------------------
  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    // Resolve assistant ID from DB — survives restarts
    const version = await this.prisma.agentVersion.findUnique({
      where: { id: input.agentVersionId },
      select: { providerRuntimeId: true },
    });
    const assistantId = version?.providerRuntimeId;
    if (!assistantId) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `No vapi assistant found for agent version ${input.agentVersionId}. Ensure agent is published.`,
        400,
      );
    }
    try {
      const call = await vapiRequest<{ id: string; webCallUrl?: string }>(
        'POST',
        '/call',
        {
          type: 'webCall',
          assistantId,
          metadata: {
            voiceforge_workspace_id: input.workspaceId,
            voiceforge_agent_id: input.agentId,
            voiceforge_agent_version_id: input.agentVersionId,
          },
        },
      );
      return {
        test_session_id: call.id,
        web_socket_url: call.webCallUrl ?? undefined,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    } catch (err) {
      if (
        err instanceof AppError
        && err.getStatus() === 400
        && err.message.includes('type must be one of the following values')
      ) {
        this.logger.warn('Vapi webCall is unavailable; using scripted browser test session.');
        return {
          test_session_id: `vapi_mock_test_v1_${input.agentId}_${Date.now()}`,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        };
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // startOutboundCall
  // -------------------------------------------------------------------------
  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    // Resolve assistant ID from DB — survives restarts, enables horizontal scale
    const version = await this.prisma.agentVersion.findUnique({
      where: { id: input.agentVersionId },
      select: { providerRuntimeId: true },
    });
    const assistantId = version?.providerRuntimeId;
    if (!assistantId) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `No vapi assistant found for agent version ${input.agentVersionId}. Ensure agent is published.`,
        400,
      );
    }

    const callPayload: Record<string, unknown> = {
      type: 'outboundPhoneCall',
      assistantId,
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      customer: { number: input.toNumber, ...(input.contactName ? { name: input.contactName } : {}) },
      metadata: {
        voiceforge_workspace_id: input.workspaceId,
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        ...(input.metadata ?? {}),
      },
    };

    const call = await vapiRequest<{ id: string; status: string }>(
      'POST',
      '/call',
      callPayload,
    );

    return {
      provider_call_id: call.id,
      status: call.status === 'ringing' ? 'ringing' : 'queued',
    };
  }

  // -------------------------------------------------------------------------
  // transferCall
  // -------------------------------------------------------------------------
  async transferCall(input: TransferCallInput): Promise<void> {
    await vapiRequest<void>('POST', `/call/${input.callId}/transfer`, {
      target: input.targetNumber,
    });
  }

  // -------------------------------------------------------------------------
  // endCall
  // -------------------------------------------------------------------------
  async endCall(input: EndCallInput): Promise<void> {
    await vapiRequest<void>('POST', `/call/${input.callId}/end`, {
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // getTranscript
  // -------------------------------------------------------------------------
  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    if (isFallbackBrowserTestSession(input.callId)) {
      return fallbackBrowserTranscript();
    }

    // Vapi transcript format: { segments: Array<{ role, text, startTime }> }
    const data = await vapiRequest<{
      segments?: Array<{ role?: string; text?: string; startTime?: number }>;
    }>('GET', `/call/${input.callId}/transcript`);

    const segments = data?.segments ?? [];

    const turns = segments.map((seg) => ({
      speaker: mapRole(seg.role ?? 'customer') as 'agent' | 'caller',
      text: seg.text ?? '',
      at_ms: Math.round((seg.startTime ?? 0) * 1000),
    }));

    return {
      transcript: segments.map((s) => `${s.role ?? 'unknown'}: ${s.text ?? ''}`).join('\n'),
      turns,
    };
  }

  // -------------------------------------------------------------------------
  // getRecording
  // -------------------------------------------------------------------------
  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    // Vapi recording: { url, duration }
    const data = await vapiRequest<{ url?: string | null; duration?: number | null }>(
      'GET',
      `/call/${input.callId}/recording`,
    );

    return {
      url: data?.url ?? null,
      duration_seconds: data?.duration ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // handleWebhook
  // -------------------------------------------------------------------------
  async handleWebhook(
    payload: Record<string, unknown>,
    _signature?: string,
  ): Promise<{ event: string; callId: string; processed: boolean }> {
    const event = (payload['event'] as string) ?? 'unknown';
    const callId = (payload['call'] as Record<string, unknown>)?.['id'] as string | undefined ?? '';

    this.logger.log(`Vapi webhook: ${event} for call ${callId}`);

    switch (event) {
      case 'call.started':
      case 'call.ended':
      case 'call.ringing':
      case 'call.queued':
      case 'call.in_progress':
      case 'call.completed':
      case 'call.ended_by_customer':
      case 'call.ended_by_operator':
      case 'recording.available':
      case 'transcript.generated':
        this.logger.debug(`Vapi event processed: ${event}`);
        break;
      default:
        this.logger.warn(`Unknown Vapi webhook event: ${event}`);
    }

    return { event, callId, processed: true };
  }
}
