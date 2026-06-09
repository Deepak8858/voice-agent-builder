import { describe, expect, it } from 'vitest';
import {
  getConnectionPreset,
  getConnectionPresets,
  recommendedOauthProviders,
} from './integration-presets';

describe('integration presets', () => {
  it('marks Google Calendar and multi-tenant CRMs as OAuth-first connections', () => {
    expect(recommendedOauthProviders()).toEqual([
      'google_calendar',
      'hubspot',
      'salesforce',
      'pipedrive',
    ]);
  });

  it('keeps Google Calendar scopes narrow for availability and booking', () => {
    const preset = getConnectionPreset('google_calendar');

    expect(preset.auth.recommended).toBe('oauth');
    expect(preset.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
    ]);
    expect(preset.manualFallback.fields).toEqual(['refresh_token', 'calendar_id']);
  });

  it('describes CRM manual fallbacks without exposing generic API-key wording for HubSpot', () => {
    const hubspot = getConnectionPreset('hubspot');
    const generic = getConnectionPreset('generic_webhook');

    expect(hubspot.manualFallback.fields).toEqual(['private_app_access_token']);
    expect(hubspot.manualFallback.summary.toLowerCase()).not.toContain('api key');
    expect(generic.auth.recommended).toBe('webhook');
    expect(generic.manualFallback.fields).toEqual(['webhook_url']);
  });

  it('returns only supported providers', () => {
    expect(getConnectionPresets().map((p) => p.id)).toEqual([
      'google_calendar',
      'hubspot',
      'salesforce',
      'pipedrive',
      'generic_webhook',
    ]);
  });
});
