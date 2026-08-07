import { describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  NODE_ENV: 'test',
} as {
  VOICE_PROVIDER?: 'mock' | 'vapi' | 'twilio' | 'openai-realtime' | 'retell';
  NODE_ENV: 'development' | 'test' | 'production';
  VAPI_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  RETELL_API_KEY?: string;
}));

vi.mock('../config/env', () => ({ env: envState }));

import { resolveVoiceProviderForTest } from './voice.module';

describe('VoiceModule provider selection', () => {
  it('selects the OpenAI realtime adapter when VOICE_PROVIDER=openai-realtime', () => {
    envState.VOICE_PROVIDER = 'openai-realtime';

    const provider = resolveVoiceProviderForTest(
      { name: 'vapi' } as never,
      { name: 'twilio' } as never,
      { name: 'openai-realtime' } as never,
      { name: 'retell' } as never,
      { name: 'mock' } as never,
    );

    expect(provider.name).toBe('openai-realtime');
  });

  it('selects the Retell adapter when credentials are configured', () => {
    envState.VOICE_PROVIDER = 'retell';
    envState.RETELL_API_KEY = 'retell-key';

    const provider = resolveVoiceProviderForTest(
      { name: 'vapi' } as never,
      { name: 'twilio' } as never,
      { name: 'openai-realtime' } as never,
      { name: 'retell' } as never,
      { name: 'mock' } as never,
    );

    expect(provider.name).toBe('retell');
  });
});
