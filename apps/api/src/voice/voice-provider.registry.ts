import { Injectable } from '@nestjs/common';
import type { PlanType } from '@voiceforge/shared';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { OpenAIRealtimeVoiceAdapter } from './adapters/openai-realtime.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';
import type { VoiceRuntimeProvider } from './adapters/voice.provider.interface';
import { env } from '../config/env';

export type VoiceProviderName = 'vapi' | 'twilio' | 'openai-realtime';

@Injectable()
export class VoiceProviderRegistry {
  constructor(
    private readonly vapi: VapiVoiceAdapter,
    private readonly twilio: TwilioVoiceAdapter,
    private readonly openaiRealtime: OpenAIRealtimeVoiceAdapter,
  ) {}

  forPlan(plan: PlanType): VoiceRuntimeProvider {
    if (plan === 'free') return this.vapi;
    return this.openaiRealtime;
  }

  byName(name: string | null | undefined): VoiceRuntimeProvider {
    switch (name) {
      case 'vapi':
        return this.vapi;
      case 'openai-realtime':
        return this.openaiRealtime;
      case 'twilio':
        return this.twilio;
      default:
        return this.defaultProvider();
    }
  }

  defaultProvider(): VoiceRuntimeProvider {
    return this.byConfiguredName(env.VOICE_PROVIDER);
  }

  private byConfiguredName(name: VoiceProviderName | undefined): VoiceRuntimeProvider {
    switch (name) {
      case 'vapi':
        return this.vapi;
      case 'openai-realtime':
        return this.openaiRealtime;
      case 'twilio':
      default:
        return this.twilio;
    }
  }
}
