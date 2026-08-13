import { describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  VOICE_PROVIDER: 'retell' as const,
}));

vi.mock('../config/env', () => ({ env: envState }));

import { VoiceProviderRegistry } from './voice-provider.registry';

const providers = {
  vapi: { name: 'vapi' },
  twilio: { name: 'twilio' },
  openai: { name: 'openai-realtime' },
  retell: { name: 'retell' },
  mock: { name: 'mock' },
};

describe('VoiceProviderRegistry', () => {
  const registry = new VoiceProviderRegistry(
    providers.vapi as never,
    providers.twilio as never,
    providers.openai as never,
    providers.retell as never,
    providers.mock as never,
  );

  it('uses the configured provider for every plan', () => {
    expect(registry.forPlan('free').name).toBe('retell');
    expect(registry.forPlan('enterprise').name).toBe('retell');
  });

  it('resolves a provider recorded on an existing agent version', () => {
    expect(registry.byName('mock').name).toBe('mock');
    expect(registry.byName('vapi').name).toBe('vapi');
  });
});
