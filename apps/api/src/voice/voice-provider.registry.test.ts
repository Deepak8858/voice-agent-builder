import { describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  VOICE_PROVIDER: 'openai-realtime' as const,
}));

vi.mock('../config/env', () => ({ env: envState }));

import { VoiceProviderRegistry } from './voice-provider.registry';

const providers = {
  twilio: { name: 'twilio' },
  openai: { name: 'openai-realtime' },
  mock: { name: 'mock' },
};

describe('VoiceProviderRegistry', () => {
  const registry = new VoiceProviderRegistry(
    providers.twilio as never,
    providers.openai as never,
    providers.mock as never,
  );

  it('uses the configured provider for every plan', () => {
    expect(registry.forPlan('free').name).toBe('openai-realtime');
    expect(registry.forPlan('enterprise').name).toBe('openai-realtime');
  });

  it('resolves a provider recorded on an existing agent version', () => {
    expect(registry.byName('mock').name).toBe('mock');
    expect(registry.byName('twilio').name).toBe('twilio');
  });

  it('falls back to the configured provider for retired provider names', () => {
    // Historical Call/AgentVersion rows may still carry `vapi`/`retell`; those
    // adapters are gone, so resolution must fall back instead of throwing.
    expect(registry.byName('vapi').name).toBe('openai-realtime');
    expect(registry.byName('retell').name).toBe('openai-realtime');
  });
});
