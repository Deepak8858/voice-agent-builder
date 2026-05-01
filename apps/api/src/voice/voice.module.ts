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
      logger.warn('No VOICE_PROVIDER configured. Voice calls will fail until a provider is set and its API key is provided.');
      // Return vapi as a placeholder so module boots; it will error on first use if not configured.
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
