import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
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

/**
 * Mock voice provider. Returns plausible data and an in-memory log so the
 * frontend can exercise "test call \u2192 transcript \u2192 analytics" without real
 * voice infrastructure. Per docs/27_MOCK_BUILD_PLAN.md.
 */
@Injectable()
export class MockVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'mock';

  private runtimeIds = new Map<string, string>(); // agentVersionId -> provider_runtime_id

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const id = `mock_${uuid()}`;
    this.runtimeIds.set(input.agentVersionId, id);
    return { provider_runtime_id: id };
  }

  async updateAgent(_input: UpdateRuntimeAgentInput): Promise<void> {
    // no-op for mock
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    return {
      test_session_id: `mock_sess_${uuid()}`,
      web_socket_url: `wss://mock.voiceforge.local/test/${input.agentVersionId}`,
      token: 'mock-token',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(_input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    return { provider_call_id: `mock_call_${uuid()}`, status: 'queued' };
  }

  async transferCall(_input: TransferCallInput): Promise<void> {
    // no-op
  }

  async endCall(_input: EndCallInput): Promise<void> {
    // no-op
  }

  async getTranscript(_input: GetTranscriptInput): Promise<TranscriptResult> {
    const turns = [
      { speaker: 'agent' as const, text: 'Hi, this is Ava. How can I help?', at_ms: 400 },
      { speaker: 'caller' as const, text: "I'd like to book an appointment.", at_ms: 2100 },
      {
        speaker: 'agent' as const,
        text: 'Happy to help. May I have your full name and phone number?',
        at_ms: 3200,
      },
      { speaker: 'caller' as const, text: "John Smith, 555 123 4567.", at_ms: 5600 },
      {
        speaker: 'agent' as const,
        text: 'Thanks John. What day works best for you?',
        at_ms: 7000,
      },
    ];
    return {
      transcript: turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
      turns,
    };
  }

  async getRecording(_input: GetRecordingInput): Promise<RecordingResult> {
    return { url: null, duration_seconds: null };
  }
}
