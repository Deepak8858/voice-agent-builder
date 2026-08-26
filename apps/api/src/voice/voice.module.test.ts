import { describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  NODE_ENV: 'test',
} as {
  VOICE_PROVIDER?: 'mock' | 'twilio' | 'openai-realtime';
  NODE_ENV: 'development' | 'test' | 'production';
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  OPENAI_API_KEY?: string;
}));

vi.mock('../config/env', () => ({ env: envState }));

import { resolveVoiceProviderForTest } from './voice.module';

describe('VoiceModule provider selection', () => {
  it('selects the OpenAI realtime adapter when VOICE_PROVIDER=openai-realtime', () => {
    envState.VOICE_PROVIDER = 'openai-realtime';

    const provider = resolveVoiceProviderForTest(
      { name: 'twilio' } as never,
      { name: 'openai-realtime' } as never,
      { name: 'mock' } as never,
    );

    expect(provider.name).toBe('openai-realtime');
  });

  it('selects the Twilio adapter when credentials are configured', () => {
    envState.VOICE_PROVIDER = 'twilio';
    envState.TWILIO_ACCOUNT_SID = 'AC_test';
    envState.TWILIO_AUTH_TOKEN = 'token';

    const provider = resolveVoiceProviderForTest(
      { name: 'twilio' } as never,
      { name: 'openai-realtime' } as never,
      { name: 'mock' } as never,
    );

    expect(provider.name).toBe('twilio');
  });

  it('falls back to the mock adapter outside production when nothing is configured', () => {
    envState.VOICE_PROVIDER = undefined;
    envState.NODE_ENV = 'test';

    const provider = resolveVoiceProviderForTest(
      { name: 'twilio' } as never,
      { name: 'openai-realtime' } as never,
      { name: 'mock' } as never,
    );

    expect(provider.name).toBe('mock');
  });
});
