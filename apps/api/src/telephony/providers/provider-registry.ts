import { Injectable } from '@nestjs/common';
import type { PhoneProvider } from '@voiceforge/shared';
import { AppError } from '../../common/errors';
import type { PhoneNumberProviderAdapter } from './provider.types';
import { TwilioProviderAdapter } from './twilio.provider';
import { VobizProviderAdapter } from './vobiz.provider';

@Injectable()
export class ProviderRegistry {
  private readonly adapters: Record<PhoneProvider, PhoneNumberProviderAdapter>;

  constructor() {
    this.adapters = {
      twilio: new TwilioProviderAdapter(),
      vobiz: new VobizProviderAdapter(),
    };
  }

  adapterFor(provider: PhoneProvider): PhoneNumberProviderAdapter {
    const adapter = this.adapters[provider];
    if (!adapter) {
      throw new AppError('TELEPHONY_NOT_FOUND', `Unsupported phone provider: ${provider}`, 404);
    }
    return adapter;
  }
}
