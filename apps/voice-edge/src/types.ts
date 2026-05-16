import type { AgentSpec } from '@voiceforge/shared';

export interface VoiceSession {
  sessionId: string;
  agentId: string;
  agentVersionId: string;
  workspaceId: string;
  spec: AgentSpec;
  startedAt: string;
  history: ConversationTurn[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface TwilioMediaStream {
  event: 'media' | 'mark' | 'start' | 'stop';
  sequenceNumber?: string;
  timestamp?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // μ-law bytes as base64
  };
  start?: {
    callSid: string;
    accountSid: string;
    trunk?: boolean;
  };
  stop?: Record<string, unknown>;
}

export interface DeepgramTranscript {
  channel: { alternatives: Array<{ transcript: string; words?: unknown[] }> };
  is_final: boolean;
  speech_final?: boolean;
  channel_idx?: { channel: number; speaker?: number };
}

export interface Env {
  REDIS_URL: string;
  DEEPGRAM_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  CARTESIA_API_KEY: string;
  LOG_LEVEL?: string;
}
