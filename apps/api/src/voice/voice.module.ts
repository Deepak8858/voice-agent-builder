import { Global, Logger, Module } from '@nestjs/common';
import { env } from '../config/env';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { MockVoiceAdapter } from './adapters/mock.adapter';
import { OpenAIRealtimeVoiceAdapter } from './adapters/openai-realtime.adapter';
import { RetellVoiceAdapter } from './adapters/retell.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';
import { VoiceProviderRegistry } from './voice-provider.registry';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

function resolveVoiceProvider(
  vapi: VapiVoiceAdapter,
  twilio: TwilioVoiceAdapter,
  openaiRealtime: OpenAIRealtimeVoiceAdapter,
  retell: RetellVoiceAdapter,
  mock: MockVoiceAdapter,
) {
  const logger = new Logger('VoiceModule');
  switch (env.VOICE_PROVIDER) {
    case 'mock':
      return mock;
    case 'vapi':
      if (!env.VAPI_API_KEY) {
        throw new Error('VOICE_PROVIDER=vapi but VAPI_API_KEY is not set.');
      }
      return vapi;
    case 'twilio':
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error('VOICE_PROVIDER=twilio but TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set.');
      }
      return twilio;
    case 'openai-realtime':
      if (!env.OPENAI_API_KEY) {
        logger.warn('VOICE_PROVIDER=openai-realtime but OPENAI_API_KEY is not set. Using mock Realtime sessions.');
      }
      return openaiRealtime;
    case 'retell':
      if (!env.RETELL_API_KEY) {
        throw new Error('VOICE_PROVIDER=retell but RETELL_API_KEY is not set.');
      }
      return retell;
    default:
      if (env.NODE_ENV === 'production') {
        throw new Error(
          'VOICE_PROVIDER must be set in production. Choose `vapi`, `twilio`, `openai-realtime`, or `retell` and provide the matching credentials.',
        );
      }
      logger.warn(
        `No VOICE_PROVIDER configured (NODE_ENV=${env.NODE_ENV}). Using the development mock provider.`,
      );
      return mock;
  }
}

export const resolveVoiceProviderForTest = resolveVoiceProvider;

@Global()
@Module({
  providers: [
    VapiVoiceAdapter,
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
    RetellVoiceAdapter,
    MockVoiceAdapter,
    VoiceProviderRegistry,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [
        VapiVoiceAdapter,
        TwilioVoiceAdapter,
        OpenAIRealtimeVoiceAdapter,
        RetellVoiceAdapter,
        MockVoiceAdapter,
      ],
      useFactory: resolveVoiceProvider,
    },
  ],
  exports: [
    VOICE_PROVIDER_TOKEN,
    VoiceProviderRegistry,
    VapiVoiceAdapter,
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
    RetellVoiceAdapter,
    MockVoiceAdapter,
  ],
})
export class VoiceModule {}
