import type { AgentSpec } from '@voiceforge/shared';

export interface CreateRuntimeAgentInput {
  workspaceId: string;
  agentId: string;
  agentVersionId: string;
  spec: AgentSpec;
}
export interface CreateRuntimeAgentResult {
  provider_runtime_id: string;
}

export interface UpdateRuntimeAgentInput extends CreateRuntimeAgentInput {
  provider_runtime_id: string;
}

export interface CreateBrowserTestSessionInput {
  workspaceId: string;
  agentId: string;
  agentVersionId: string;
}
export interface BrowserTestSessionResult {
  test_session_id: string;
  web_socket_url?: string;
  token?: string;
  expires_at: string;
}

export interface StartOutboundCallInput {
  workspaceId: string;
  agentId: string;
  agentVersionId: string;
  toNumber: string;
  fromNumber?: string;
  metadata?: Record<string, unknown>;
}
export interface StartOutboundCallResult {
  provider_call_id: string;
  status: 'queued' | 'ringing';
}

export interface TransferCallInput {
  callId: string;
  targetNumber: string;
}
export interface EndCallInput {
  callId: string;
  reason?: string;
}
export interface GetTranscriptInput {
  callId: string;
}
export interface TranscriptResult {
  transcript: string;
  turns: Array<{ speaker: 'agent' | 'caller'; text: string; at_ms: number }>;
}
export interface GetRecordingInput {
  callId: string;
}
export interface RecordingResult {
  url: string | null;
  duration_seconds: number | null;
}

export interface VoiceRuntimeProvider {
  readonly name: string;
  createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult>;
  updateAgent(input: UpdateRuntimeAgentInput): Promise<void>;
  createBrowserTestSession(
    input: CreateBrowserTestSessionInput,
  ): Promise<BrowserTestSessionResult>;
  startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult>;
  transferCall(input: TransferCallInput): Promise<void>;
  endCall(input: EndCallInput): Promise<void>;
  getTranscript(input: GetTranscriptInput): Promise<TranscriptResult>;
  getRecording(input: GetRecordingInput): Promise<RecordingResult>;
}
