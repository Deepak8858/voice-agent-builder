import { describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  NODE_ENV: 'test',
} as {
  VOICE_PROVIDER?: 'vapi' | 'twilio' | 'openai-realtime';
  NODE_ENV: 'development' | 'test' | 'production';
  VAPI_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
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
    );

    expect(provider.name).toBe('openai-realtime');
  });
});
