import { Global, Logger, Module } from '@nestjs/common';
import { env } from '../config/env';
import { RetellVoiceAdapter } from './adapters/retell.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

function resolveVoiceProvider(vapi: VapiVoiceAdapter, retell: RetellVoiceAdapter) {
  const logger = new Logger('VoiceModule');
  switch (env.VOICE_PROVIDER) {
    case 'vapi':
      if (!env.VAPI_API_KEY) {
        throw new Error('VOICE_PROVIDER=vapi but VAPI_API_KEY is not set. Provide the key or choose retell.');
      }
      return vapi;
    case 'retell':
      if (!env.RETELL_API_KEY) {
        throw new Error('VOICE_PROVIDER=retell but RETELL_API_KEY is not set. Provide the key or choose vapi.');
      }
      return retell;
    default:
      // Production must fail-fast: silently booting with no voice provider
      // hides config bugs until first call placement.
      if (env.NODE_ENV === 'production') {
        throw new Error(
          'VOICE_PROVIDER must be set in production. Choose `vapi` or `retell` and provide the matching API key.',
        );
      }
      logger.warn(
        `No VOICE_PROVIDER configured (NODE_ENV=${env.NODE_ENV}). Voice calls will throw until a provider is set.`,
      );
      // Non-prod: return vapi shell so the module boots; it errors on first use.
      return vapi;
  }
}

@Global()
@Module({
  providers: [
    VapiVoiceAdapter,
    RetellVoiceAdapter,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [VapiVoiceAdapter, RetellVoiceAdapter],
      useFactory: resolveVoiceProvider,
    },
  ],
  exports: [VOICE_PROVIDER_TOKEN],
})
export class VoiceModule {}
