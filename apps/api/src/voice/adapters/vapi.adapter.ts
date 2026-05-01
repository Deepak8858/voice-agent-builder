import { Injectable, Logger } from '@nestjs/common';
import type { AgentSpec } from '@voiceforge/shared';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
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

interface VapiAssistantResponse {
  id: string;
  [key: string]: unknown;
}

interface VapiCallResponse {
  id: string;
  status?: string;
  webCallUrl?: string;
  recordingUrl?: string;
  startedAt?: string;
  endedAt?: string;
  artifact?: { recordingUrl?: string };
  messages?: Array<{ role: string; message?: string; time?: number; secondsFromStart?: number }>;
  transcript?: string;
  [key: string]: unknown;
}

@Injectable()
export class VapiVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'vapi';
  private readonly logger = new Logger(VapiVoiceAdapter.name);

  private requireKey(): string {
    if (!env.VAPI_API_KEY) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Vapi adapter requires VAPI_API_KEY.',
        501,
      );
    }
    return env.VAPI_API_KEY;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = this.requireKey();
    const url = `${env.VAPI_BASE_URL.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? safeJson(text) : null;
      if (!res.ok) {
        throw new AppError(
          'VOICE_PROVIDER_ERROR',
          `Vapi ${method} ${path} failed (${res.status})`,
          502,
          { status: res.status, body: parsed },
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `Vapi request failed: ${(err as Error).message}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private specToAssistant(spec: AgentSpec): Record<string, unknown> {
    const systemPrompt = buildSystemPrompt(spec);
    const firstMessage =
      spec.flow?.nodes.find((n) => n.type === 'speak' && n.id === spec.flow?.start_node_id)?.text ??
      `Hi, this is ${spec.identity.agent_name} from ${spec.identity.business_name}. How can I help?`;

    return {
      name: spec.name,
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      voice: {
        provider: '11labs',
        voiceId: spec.voice.voice_id ?? 'rachel',
      },
      firstMessage,
      language: spec.language ?? 'en',
      endCallFunctionEnabled: true,
      recordingEnabled: spec.compliance.recording_notice_required ?? false,
    };
  }

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const res = await this.request<VapiAssistantResponse>(
      'POST',
      '/assistant',
      this.specToAssistant(input.spec),
    );
    return { provider_runtime_id: res.id };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    await this.request('PATCH', `/assistant/${input.provider_runtime_id}`, this.specToAssistant(input.spec));
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    // Vapi web call: POST /call with `type: webCall`
    const res = await this.request<VapiCallResponse>('POST', '/call', {
      type: 'webCall',
      assistantId: input.agentVersionId, // caller passes provider_runtime_id via metadata; see CallsService
    });
    return {
      test_session_id: res.id,
      web_socket_url: res.webCallUrl ?? undefined,
      token: undefined,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    if (!env.VAPI_PHONE_NUMBER_ID && !input.fromNumber) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Vapi outbound requires VAPI_PHONE_NUMBER_ID env or fromNumber.',
        501,
      );
    }
    const body: Record<string, unknown> = {
      type: 'outboundPhoneCall',
      customer: { number: input.toNumber },
      ...(env.VAPI_PHONE_NUMBER_ID ? { phoneNumberId: env.VAPI_PHONE_NUMBER_ID } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const res = await this.request<VapiCallResponse>('POST', '/call', body);
    const status = res.status === 'ringing' ? 'ringing' : 'queued';
    return { provider_call_id: res.id, status };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    await this.request('POST', `/call/${input.callId}/control`, {
      type: 'transfer',
      destination: { type: 'number', number: input.targetNumber },
    });
  }

  async endCall(input: EndCallInput): Promise<void> {
    await this.request('POST', `/call/${input.callId}/control`, {
      type: 'end-call',
    });
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    const res = await this.request<VapiCallResponse>('GET', `/call/${input.callId}`);
    const turns = (res.messages ?? [])
      .filter((m) => m.role === 'assistant' || m.role === 'user')
      .map((m) => ({
        speaker: (m.role === 'assistant' ? 'agent' : 'caller') as 'agent' | 'caller',
        text: m.message ?? '',
        at_ms: Math.round((m.secondsFromStart ?? 0) * 1000),
      }));
    const transcript = res.transcript ?? turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    return { transcript, turns };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    const res = await this.request<VapiCallResponse>('GET', `/call/${input.callId}`);
    const url = res.artifact?.recordingUrl ?? res.recordingUrl ?? null;
    let duration: number | null = null;
    if (res.startedAt && res.endedAt) {
      duration = Math.max(
        0,
        Math.round((new Date(res.endedAt).getTime() - new Date(res.startedAt).getTime()) / 1000),
      );
    }
    return { url, duration_seconds: duration };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  return parts.join('\n');
}
