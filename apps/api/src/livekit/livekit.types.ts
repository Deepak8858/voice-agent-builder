import type { PhoneProvider } from '@voiceforge/shared';

export interface LiveKitRoomResult {
  roomName: string;
}

export interface LiveKitSipTrunkResult {
  trunkId: string;
}

export interface LiveKitDispatchRuleResult {
  dispatchRuleId: string;
}

export interface LiveKitOutboundCallResult {
  providerCallId: string;
  roomName: string;
  status: 'queued' | 'ringing';
}

export interface CreateInboundSipTrunkParams {
  workspaceId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  provider: PhoneProvider;
  authUsername?: string;
  authPassword?: string;
}

export interface CreateOutboundSipTrunkParams {
  workspaceId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  provider: PhoneProvider;
  sipAddress?: string | null;
  authUsername?: string | null;
  authPassword?: string | null;
}

export interface CreateDispatchRuleParams {
  workspaceId: string;
  phoneNumberId: string;
  agentId: string;
  trunkId: string;
  roomPrefix: string;
  agentName: string;
  metadata?: Record<string, unknown>;
}

export interface CreateOutboundCallParams {
  phoneNumberId: string;
  agentId: string;
  outboundTrunkId: string;
  toNumber: string;
  fromNumber: string;
  roomName: string;
}
