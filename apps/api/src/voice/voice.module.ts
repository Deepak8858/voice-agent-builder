import { Global, Module } from '@nestjs/common';
import { env } from '../config/env';
import { MockVoiceAdapter } from './adapters/mock.adapter';
import { RetellVoiceAdapter } from './adapters/retell.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

@Global()
@Module({
  providers: [
    MockVoiceAdapter,
    VapiVoiceAdapter,
    RetellVoiceAdapter,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [MockVoiceAdapter, VapiVoiceAdapter, RetellVoiceAdapter],
      useFactory: (mock: MockVoiceAdapter, vapi: VapiVoiceAdapter, retell: RetellVoiceAdapter) => {
        switch (env.VOICE_PROVIDER) {
          case 'vapi':
            return vapi;
          case 'retell':
            return retell;
          case 'mock':
          default:
            return mock;
        }
      },
    },
  ],
  exports: [VOICE_PROVIDER_TOKEN],
})
export class VoiceModule {}
