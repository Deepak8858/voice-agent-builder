import { describe, expect, it } from 'vitest';
import {
  getConnectionPreset,
  getConnectionPresets,
  recommendedOauthProviders,
} from './integration-presets';

describe('integration presets', () => {
  it('marks Google Workspace tools and multi-tenant CRMs as OAuth-first connections', () => {
    expect(recommendedOauthProviders()).toEqual([
      'gmail',
      'google_sheets',
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
      'gmail',
      'google_sheets',
      'google_calendar',
      'hubspot',
      'salesforce',
      'pipedrive',
      'generic_webhook',
    ]);
  });

  it('falls back to Google Calendar for unknown preset ids', () => {
    const preset = getConnectionPreset('unknown' as never);
    expect(preset.id).toBe('google_calendar');
  });
});
