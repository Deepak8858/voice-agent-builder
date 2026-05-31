import { describe, expect, it } from 'vitest';
import {
  ImportProviderPhoneNumberSchema,
  SyncedProviderPhoneNumberSchema,
} from './telephony';

describe('telephony schemas', () => {
  it('allows trunk-only synced inventory while keeping imports E.164-only', () => {
    expect(
      SyncedProviderPhoneNumberSchema.parse({
        provider_number_id: 'trunk-console-1',
        phone_number: null,
        friendly_name: 'Console trunk',
        requires_phone_number: true,
        capabilities: { voice: true },
        metadata: { sipTrunkId: 'trunk-console-1' },
      }),
    ).toEqual({
      provider_number_id: 'trunk-console-1',
      phone_number: null,
      friendly_name: 'Console trunk',
      requires_phone_number: true,
      capabilities: { voice: true },
      metadata: { sipTrunkId: 'trunk-console-1' },
    });

    expect(() =>
      ImportProviderPhoneNumberSchema.parse({
        provider_number_id: 'trunk-console-1',
        phone_number: 'trunk-console-1',
      }),
    ).toThrow(/E.164/);
  });

  it('accepts a per-number webhook secret when importing provider inventory', () => {
    expect(
      ImportProviderPhoneNumberSchema.parse({
        provider_number_id: 'trunk-console-1',
        phone_number: '+912271264217',
        webhook_secret: 'vobiz-webhook-secret',
      }),
    ).toEqual({
      provider_number_id: 'trunk-console-1',
      phone_number: '+912271264217',
      webhook_secret: 'vobiz-webhook-secret',
    });
  });
});
