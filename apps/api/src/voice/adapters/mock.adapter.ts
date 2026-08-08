import { Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class MockVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockVoiceAdapter.name);
  private readonly transcripts = new Map<string, TranscriptResult>();

  constructor(private readonly prisma: PrismaService) {}

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    const providerRuntimeId = `mock_agent_${input.agentVersionId}`;
    await this.prisma.agentVersion.update({
      where: { id: input.agentVersionId },
      data: { providerRuntimeId },
    });
    return { provider_runtime_id: providerRuntimeId };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    if (!input.provider_runtime_id) await this.createAgent(input);
  }

  async createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult> {
    const testSessionId = `mock_test_${input.agentVersionId}_${Date.now()}`;
    this.transcripts.set(testSessionId, this.mockTranscript());
    return {
      test_session_id: testSessionId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    const callId = `mock_call_${input.agentVersionId}_${Date.now()}`;
    this.transcripts.set(callId, this.mockTranscript());
    return { provider_call_id: callId, status: 'queued' };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    this.logger.log(`Mock transfer for ${input.callId} to ${input.targetNumber}.`);
  }

  async endCall(input: EndCallInput): Promise<void> {
    this.logger.log(`Mock end for ${input.callId}.`);
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    return this.transcripts.get(input.callId) ?? this.mockTranscript();
  }

  async getRecording(_input: GetRecordingInput): Promise<RecordingResult> {
    return { url: null, duration_seconds: null };
  }

  async handleWebhook(
    payload: Record<string, unknown>,
    _signature?: string,
  ): Promise<{ event: string; callId: string; processed: boolean }> {
    return {
      event: String(payload['event'] ?? 'mock.event'),
      callId: String(payload['call_id'] ?? ''),
      processed: true,
    };
  }

  private mockTranscript(): TranscriptResult {
    const turns: TranscriptResult['turns'] = [
      { speaker: 'agent', text: 'Hello, this is a VoiceForge test call.', at_ms: 0 },
      { speaker: 'caller', text: 'I would like to test this agent.', at_ms: 1800 },
      { speaker: 'agent', text: 'The mock voice runtime is working.', at_ms: 3600 },
    ];
    return {
      transcript: turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n'),
      turns,
    };
  }
}
