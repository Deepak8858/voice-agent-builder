import { Injectable } from '@nestjs/common';
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

const RETELL_BASE = 'https://api.retellai.com';

async function retellRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = env.RETELL_API_KEY;
  if (!apiKey) {
    throw new AppError(
      'VOICE_PROVIDER_ERROR',
      'Retell adapter is not configured. Set RETELL_API_KEY and switch VOICE_PROVIDER=retell.',
      501,
    );
  }

  const url = `${RETELL_BASE}${path}`;
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
      `Retell API error ${res.status} on ${method} ${path}: ${text}`,
      res.status as 400 | 401 | 403 | 404 | 422 | 500,
      { status: res.status, path, method },
    );
  }

  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

@Injectable()
export class RetellVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'retell';

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const res = await retellRequest<{ agent_id: string }>('POST', '/create-agent', {
      model: 'gpt-4o',
      transcript_plan: { provider: 'google' },
      recording_enabled: input.spec.compliance.recording_notice_required ?? false,
    });
    return { provider_runtime_id: res.agent_id };
  }

  async updateAgent(_input: UpdateRuntimeAgentInput): Promise<void> {
    // Retell agent updates done via dashboard; minimal support here
  }

  async createBrowserTestSession(
    _input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    return {
      test_session_id: `retell_test_${Date.now()}`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const res = await retellRequest<{ call_id: string; status: string }>(
      'POST',
      '/create-outbound-call',
      {
        agent_id: input.agentVersionId,
        phone_number_to_call: input.toNumber,
        ...(input.fromNumber ? { caller_number: input.fromNumber } : {}),
      },
    );
    return {
      provider_call_id: res.call_id,
      status: res.status === 'in_progress' ? 'ringing' : 'queued',
    };
  }

  async endCall(input: EndCallInput): Promise<void> {
    await retellRequest('POST', `/end-call/${input.callId}`);
  }

  async transferCall(_input: TransferCallInput): Promise<void> {
    // Transfer via end + new outbound call
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    const data = await retellRequest<{ transcript?: string; segments?: Array<{ role?: string; text?: string; start_time?: number }> }>(
      'GET',
      `/get-call/${input.callId}/transcript`,
    );
    const turns = (data.segments ?? []).map((s) => ({
      speaker: (s.role === 'agent' ? 'agent' : 'caller') as 'agent' | 'caller',
      text: s.text ?? '',
      at_ms: Math.round((s.start_time ?? 0) * 1000),
    }));
    const transcript = data.transcript ?? turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    return { transcript, turns };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    const data = await retellRequest<{ recording_url?: string }>('GET', `/get-call/${input.callId}`);
    return { url: data.recording_url ?? null, duration_seconds: null };
  }
}