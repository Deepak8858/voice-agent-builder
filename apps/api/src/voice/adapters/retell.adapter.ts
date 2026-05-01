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

interface RetellAgentResponse {
  agent_id: string;
  [key: string]: unknown;
}

interface RetellLlmResponse {
  llm_id: string;
  [key: string]: unknown;
}

interface RetellCallResponse {
  call_id: string;
  call_status?: string;
  access_token?: string;
  recording_url?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  transcript?: string;
  transcript_object?: Array<{ role: string; content: string; words?: Array<{ start: number }> }>;
  [key: string]: unknown;
}

@Injectable()
export class RetellVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'retell';
  private readonly logger = new Logger(RetellVoiceAdapter.name);

  private requireKey(): string {
    if (!env.RETELL_API_KEY) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Retell adapter requires RETELL_API_KEY.',
        501,
      );
    }
    return env.RETELL_API_KEY;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = this.requireKey();
    const url = `${env.RETELL_BASE_URL.replace(/\/$/, '')}${path}`;
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
          `Retell ${method} ${path} failed (${res.status})`,
          502,
          { status: res.status, body: parsed },
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `Retell request failed: ${(err as Error).message}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    // Retell requires an LLM resource first, then an agent that references it.
    const systemPrompt = buildSystemPrompt(input.spec);
    const llm = await this.request<RetellLlmResponse>('POST', '/create-retell-llm', {
      general_prompt: systemPrompt,
      model: 'gpt-4o',
      begin_message: greetingFromSpec(input.spec),
    });

    const agent = await this.request<RetellAgentResponse>('POST', '/create-agent', {
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      voice_id: input.spec.voice.voice_id ?? '11labs-Adrian',
      agent_name: input.spec.name,
      language: input.spec.language ?? 'en-US',
    });
    return { provider_runtime_id: agent.agent_id };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    await this.request('PATCH', `/update-agent/${input.provider_runtime_id}`, {
      voice_id: input.spec.voice.voice_id ?? '11labs-Adrian',
      agent_name: input.spec.name,
      language: input.spec.language ?? 'en-US',
    });
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    const res = await this.request<RetellCallResponse>('POST', '/create-web-call', {
      agent_id: input.agentVersionId,
    });
    return {
      test_session_id: res.call_id,
      web_socket_url: undefined,
      token: res.access_token ?? undefined,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const fromNumber = input.fromNumber ?? env.RETELL_FROM_NUMBER;
    if (!fromNumber) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        'Retell outbound requires RETELL_FROM_NUMBER env or fromNumber.',
        501,
      );
    }
    const res = await this.request<RetellCallResponse>('POST', '/create-phone-call', {
      from_number: fromNumber,
      to_number: input.toNumber,
      override_agent_id: input.agentVersionId,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return { provider_call_id: res.call_id, status: 'queued' };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    // Retell exposes call control via the agent's transfer_call function.
    // Manual transfer endpoint:
    await this.request('POST', `/update-call/${input.callId}`, {
      transfer_destination: { type: 'phone_number', number: input.targetNumber },
    });
  }

  async endCall(input: EndCallInput): Promise<void> {
    await this.request('POST', `/update-call/${input.callId}`, {
      call_status: 'ended',
    });
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    const res = await this.request<RetellCallResponse>('GET', `/get-call/${input.callId}`);
    const turns = (res.transcript_object ?? []).map((t) => ({
      speaker: (t.role === 'agent' ? 'agent' : 'caller') as 'agent' | 'caller',
      text: t.content,
      at_ms: Math.round((t.words?.[0]?.start ?? 0) * 1000),
    }));
    const transcript = res.transcript ?? turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    return { transcript, turns };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    const res = await this.request<RetellCallResponse>('GET', `/get-call/${input.callId}`);
    let duration: number | null = null;
    if (res.start_timestamp && res.end_timestamp) {
      duration = Math.max(0, Math.round((res.end_timestamp - res.start_timestamp) / 1000));
    }
    return { url: res.recording_url ?? null, duration_seconds: duration };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function greetingFromSpec(spec: AgentSpec): string {
  return `Hi, this is ${spec.identity.agent_name} from ${spec.identity.business_name}. How can I help today?`;
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
  if (spec.compliance.ai_disclosure_required) {
    parts.push('You MUST disclose that you are an AI assistant at the start of the call.');
  }
  if (spec.compliance.recording_notice_required) {
    parts.push('You MUST tell the caller this call is being recorded.');
  }
  if (spec.compliance.opt_out_enabled) {
    parts.push('Honor any opt-out request and end the call.');
  }
  return parts.join('\n');
}
