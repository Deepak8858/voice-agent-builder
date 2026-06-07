import { Global, Logger, Module } from '@nestjs/common';
import { env } from '../config/env';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { OpenAIRealtimeVoiceAdapter } from './adapters/openai-realtime.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';
import { VoiceProviderRegistry } from './voice-provider.registry';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

function resolveVoiceProvider(
  vapi: VapiVoiceAdapter,
  twilio: TwilioVoiceAdapter,
  openaiRealtime: OpenAIRealtimeVoiceAdapter,
) {
  const logger = new Logger('VoiceModule');
  switch (env.VOICE_PROVIDER) {
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
    default:
      if (env.NODE_ENV === 'production') {
        throw new Error(
          'VOICE_PROVIDER must be set in production. Choose `vapi`, `twilio`, or `openai-realtime` and provide the matching credentials.',
        );
      }
      logger.warn(
        `No VOICE_PROVIDER configured (NODE_ENV=${env.NODE_ENV}). Voice calls will throw until a provider is set.`,
      );
      return twilio;
  }
}

export const resolveVoiceProviderForTest = resolveVoiceProvider;

@Global()
@Module({
  providers: [
    VapiVoiceAdapter,
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
    VoiceProviderRegistry,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [VapiVoiceAdapter, TwilioVoiceAdapter, OpenAIRealtimeVoiceAdapter],
      useFactory: resolveVoiceProvider,
    },
  ],
  exports: [
    VOICE_PROVIDER_TOKEN,
    VoiceProviderRegistry,
    VapiVoiceAdapter,
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
  ],
})
export class VoiceModule {}
