import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
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
  TranscriptResult,
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
  return parts.join('\n');
}

/** Map Vapi speaker role to our canonical role. */
function mapRole(role: string): 'agent' | 'caller' {
  return role === 'assistant' ? 'agent' : 'caller';
}

// ---------------------------------------------------------------------------
// VapiVoiceAdapter
// ---------------------------------------------------------------------------
@Injectable()
export class VapiVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'vapi';

  // agentVersionId (VoiceForge) -> vapi assistant id
  private readonly assistantIdMap = new Map<string, string>();

  // -------------------------------------------------------------------------
  // createAgent
  // -------------------------------------------------------------------------
  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const { spec } = input;

    const assistantPayload: Record<string, unknown> = {
      name: spec.name,
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: buildSystemPrompt(spec),
      },
      voice: {
        provider: 'vapi',
        ...(spec.voice.voice_id ? { voiceId: spec.voice.voice_id } : {}),
        ...(spec.voice.speaking_rate ? { speakingRate: spec.voice.speaking_rate } : {}),
      },
      firstMessage: spec.conversation_rules.first_message,
      metadata: {
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        voiceforge_workspace_id: input.workspaceId,
      },
    };

    // Compliance / legal
    if (spec.compliance.recording_notice_required) {
      (assistantPayload as Record<string, unknown>).spcallbacks = {
        onCallStart: [{ do: 'say', args: { text: 'This call may be recorded for quality assurance.' } }],
      };
    }

    const assistant = await vapiRequest<{ id: string }>('POST', '/assistant', assistantPayload);

    // Cache so startOutboundCall can look up the vapi assistant id
    this.assistantIdMap.set(input.agentVersionId, assistant.id);

    return { provider_runtime_id: assistant.id };
  }

  // -------------------------------------------------------------------------
  // updateAgent
  // -------------------------------------------------------------------------
  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    const { spec } = input;

    const patch: Record<string, unknown> = {};

    if (spec.name) patch.name = spec.name;

    if (spec.conversation_rules.first_message) {
      patch.firstMessage = spec.conversation_rules.first_message;
    }

    // voice is mutable
    if (spec.voice.voice_id || spec.voice.speaking_rate) {
      patch.voice = {
        provider: 'vapi',
        ...(spec.voice.voice_id ? { voiceId: spec.voice.voice_id } : {}),
        ...(spec.voice.speaking_rate ? { speakingRate: spec.voice.speaking_rate } : {}),
      };
    }

    if (Object.keys(patch).length === 0) return;

    await vapiRequest<void>('PATCH', `/assistant/${input.provider_runtime_id}`, patch);
  }

  // -------------------------------------------------------------------------
  // createBrowserTestSession
  // -------------------------------------------------------------------------
  async createBrowserTestSession(
    _input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    // Vapi does not expose a browser-test / sandbox API.
    // Return a placeholder session that the UI can use to poll.
    const sessionId = `test_${Date.now()}`;
    return {
      test_session_id: sessionId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // startOutboundCall
  // -------------------------------------------------------------------------
  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    // Look up the vapi assistant id for this VoiceForge agent version
    const assistantId = this.assistantIdMap.get(input.agentVersionId);
    if (!assistantId) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `No vapi assistant found for agent version ${input.agentVersionId}. Call createAgent first.`,
        400,
      );
    }

    const callPayload: Record<string, unknown> = {
      assistantId,
      customer: { number: input.toNumber },
      metadata: {
        voiceforge_workspace_id: input.workspaceId,
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        ...(input.metadata ?? {}),
      },
    };

    if (input.fromNumber) {
      (callPayload as Record<string, unknown>).caller = { number: input.fromNumber };
    }

    const call = await vapiRequest<{ id: string; status: string }>(
      'POST',
      '/call/outbound',
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
}