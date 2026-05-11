import { Global, Logger, Module } from '@nestjs/common';
import { env } from '../config/env';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

function resolveVoiceProvider(vapi: VapiVoiceAdapter, twilio: TwilioVoiceAdapter) {
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
    default:
      if (env.NODE_ENV === 'production') {
        throw new Error(
          'VOICE_PROVIDER must be set in production. Choose `vapi` or `twilio` and provide the matching credentials.',
        );
      }
      logger.warn(
        `No VOICE_PROVIDER configured (NODE_ENV=${env.NODE_ENV}). Voice calls will throw until a provider is set.`,
      );
      return twilio;
  }
}

@Global()
@Module({
  providers: [
    VapiVoiceAdapter,
    TwilioVoiceAdapter,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [VapiVoiceAdapter, TwilioVoiceAdapter],
      useFactory: resolveVoiceProvider,
    },
  ],
  exports: [VOICE_PROVIDER_TOKEN, TwilioVoiceAdapter],
})
export class VoiceModule {}
