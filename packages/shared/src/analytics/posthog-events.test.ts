import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  buildPostHogCapture,
  buildPostHogEvent,
  containsUnsafeValue,
  EVENT_IDENTITY_KIND,
  isPostHogEventName,
  mapInternalEventName,
  nonPersonIdentity,
  POSTHOG_EVENT_NAMES,
  userIdentity,
} from './posthog-events';

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

describe('event vocabulary', () => {
  it('maps only the known internal dotted names', () => {
    expect(mapInternalEventName('call.started')).toBe('call_started');
    expect(mapInternalEventName('call.ended')).toBe('call_ended');
    expect(mapInternalEventName('call.blocked')).toBe('call_blocked');
    expect(mapInternalEventName('outcome.appointment_booked')).toBeNull();
    expect(mapInternalEventName('tool.failed')).toBeNull();
  });

  it('does not resolve inherited object keys as events', () => {
    expect(mapInternalEventName('constructor')).toBeNull();
    expect(mapInternalEventName('toString')).toBeNull();
    expect(mapInternalEventName('__proto__')).toBeNull();
  });

  it('recognises every declared PostHog event name', () => {
    for (const name of POSTHOG_EVENT_NAMES) {
      expect(isPostHogEventName(name)).toBe(true);
    }
    expect(isPostHogEventName('call.started')).toBe(false);
  });
});

describe('buildPostHogEvent — PII stripping', () => {
  it('strips to_number from the existing call.started payload', () => {
    const result = buildPostHogEvent({
      event: 'call.started',
      properties: { direction: 'outbound', to_number: '+12125551234' },
    });

    expect(result).not.toBeNull();
    expect(result?.event).toBe('call_started');
    expect(result?.properties).toEqual({ direction: 'outbound' });
    expect(JSON.stringify(result?.properties)).not.toContain('2125551234');
  });

  it('lifts compliance codes from call.blocked while discarding free-text messages', () => {
    const result = buildPostHogEvent({
      event: 'call.blocked',
      properties: {
        to_number: '+12125551234',
        reasons: [
          { code: 'dnc_listed', message: 'Number +12125551234 is on the DNC list' },
          { code: 'opted_out', message: 'Contact opted out', severity: 'blocking' },
        ],
      },
    });

    expect(result?.properties).toEqual({
      direction: 'outbound',
      reason_codes: ['dnc_listed', 'opted_out'],
    });
    expect(JSON.stringify(result?.properties)).not.toContain('2125551234');
    expect(JSON.stringify(result?.properties)).not.toContain('DNC list');
  });

  it('drops a blocked event with malformed reasons rather than reporting zero', () => {
    expect(
      buildPostHogEvent({ event: 'call.blocked', properties: { reasons: 'dnc_listed' } }),
    ).toBeNull();
    expect(
      buildPostHogEvent({
        event: 'call.blocked',
        properties: { reasons: [{ code: 'not_a_real_code' }] },
      }),
    ).toBeNull();
  });

  it('strips transcripts, recordings, names and nested metadata', () => {
    const result = buildPostHogEvent({
      event: 'call.ended',
      properties: {
        direction: 'inbound',
        outcome: 'appointment_booked',
        duration_seconds: 42,
        transcript_text: 'Caller: my number is 212 555 1234',
        recording_url: 'https://provider.example/recordings/abc?token=secret',
        contact_name: 'Jane Doe',
        metadata: { caller: { phone: '+12125551234' } },
      },
    });

    expect(result?.properties).toEqual({
      direction: 'inbound',
      outcome: 'appointment_booked',
      duration_seconds: 42,
    });
  });

  it('drops null-valued columns instead of failing validation', () => {
    const result = buildPostHogEvent({
      event: 'call.ended',
      properties: { direction: 'outbound', outcome: null, duration_seconds: 10 },
    });

    expect(result?.properties).toEqual({ direction: 'outbound', duration_seconds: 10 });
  });

  it('never mutates the input properties object', () => {
    const properties = { direction: 'outbound', to_number: '+12125551234' };
    const snapshot = JSON.stringify(properties);

    buildPostHogEvent({ event: 'call.started', properties });

    expect(JSON.stringify(properties)).toBe(snapshot);
  });
});

describe('buildPostHogEvent — rejection', () => {
  it('drops unknown and dynamically named events', () => {
    expect(buildPostHogEvent({ event: 'outcome.appointment_booked' })).toBeNull();
    expect(buildPostHogEvent({ event: 'attacker.controlled', properties: {} })).toBeNull();
    expect(buildPostHogEvent({ event: '' })).toBeNull();
  });

  it('drops events whose required properties are missing or malformed', () => {
    expect(buildPostHogEvent({ event: 'call.started', properties: {} })).toBeNull();
    expect(
      buildPostHogEvent({ event: 'call.started', properties: { direction: 'sideways' } }),
    ).toBeNull();
    expect(
      buildPostHogEvent({ event: 'agent_created', properties: { agent_id: 'not-a-uuid' } }),
    ).toBeNull();
  });

  it('drops out-of-range numeric values rather than clamping them', () => {
    expect(
      buildPostHogEvent({
        event: 'call.ended',
        properties: { direction: 'inbound', duration_seconds: 999_999 },
      }),
    ).toBeNull();
  });

  it('never throws on hostile payloads that execute or refuse code', () => {
    const throwingGetter = {
      direction: 'outbound',
      get boom(): string {
        throw new Error('getter boom');
      },
    };
    expect(buildPostHogEvent({ event: 'call.started', properties: throwingGetter })).toEqual({
      event: 'call_started',
      properties: { direction: 'outbound' },
    });

    const cyclic: Record<string, unknown> = { direction: 'outbound' };
    cyclic.self = cyclic;
    expect(() => buildPostHogEvent({ event: 'call.started', properties: cyclic })).not.toThrow();

    const hostileProxy = new Proxy(
      { direction: 'outbound' },
      {
        ownKeys() {
          throw new Error('proxy boom');
        },
      },
    );
    expect(() =>
      buildPostHogEvent({ event: 'call.started', properties: hostileProxy }),
    ).not.toThrow();
  });

  it('does not read getters that would leak PII', () => {
    let read = false;
    const properties = {
      direction: 'outbound',
      get call_id(): string {
        read = true;
        return CALL_ID;
      },
    };

    const result = buildPostHogEvent({ event: 'call.started', properties });

    expect(read).toBe(false);
    expect(result?.properties).toEqual({ direction: 'outbound' });
  });

  it('accepts a well-formed event', () => {
    const result = buildPostHogEvent({
      event: 'agent_published',
      properties: { agent_id: AGENT_ID, version_number: 3 },
    });

    expect(result?.properties).toEqual({ agent_id: AGENT_ID, version_number: 3 });
  });
});

describe('containsUnsafeValue', () => {
  it('flags forbidden keys at any depth', () => {
    expect(containsUnsafeValue({ agent_id: AGENT_ID })).toBe(false);
    expect(containsUnsafeValue({ nested: { deeper: { transcript: 'hi' } } })).toBe(true);
    expect(containsUnsafeValue({ nested: { To_Number: 'x' } })).toBe(true);
  });

  it('flags phone-like values even under a safe-looking key', () => {
    expect(containsUnsafeValue({ reference: '+1 212 555 1234' })).toBe(true);
    expect(containsUnsafeValue({ reference: '2125551234' })).toBe(true);
  });

  it('allows UUIDs and short enums', () => {
    expect(containsUnsafeValue({ call_id: CALL_ID, direction: 'outbound' })).toBe(false);
  });

  it('flags unbounded strings and non-serializable values', () => {
    expect(containsUnsafeValue({ note: 'a'.repeat(201) })).toBe(true);
    expect(containsUnsafeValue({ fn: () => undefined })).toBe(true);
    expect(containsUnsafeValue({ n: Number.NaN })).toBe(true);
  });

  it('flags excessively deep structures', () => {
    let deep: Record<string, unknown> = { ok: true };
    for (let i = 0; i < 10; i += 1) deep = { deep };
    expect(containsUnsafeValue(deep)).toBe(true);
  });
});

describe('identity and group policy', () => {
  it('treats call lifecycle events as non-person', () => {
    expect(EVENT_IDENTITY_KIND.call_started).toBe('non_person');
    expect(EVENT_IDENTITY_KIND.call_ended).toBe('non_person');
    expect(EVENT_IDENTITY_KIND.call_blocked).toBe('non_person');
    expect(EVENT_IDENTITY_KIND.agent_created).toBe('user');
  });

  it('uses an opaque call-scoped distinct ID without person processing', () => {
    expect(nonPersonIdentity({ eventScopeId: CALL_ID })).toEqual({
      distinctId: `call:${CALL_ID}`,
      processPersonProfile: false,
    });
  });

  it('refuses a non-opaque scope ID rather than inventing a shared bucket', () => {
    expect(nonPersonIdentity({ eventScopeId: '' })).toBeNull();
    expect(nonPersonIdentity({ eventScopeId: 'attacker text' })).toBeNull();
  });

  it('identifies user actions with the app user ID', () => {
    expect(userIdentity('user_1')).toEqual({
      distinctId: 'user_1',
      processPersonProfile: true,
    });
  });

  it('refuses PII-shaped values as person distinct IDs', () => {
    expect(userIdentity('jane@example.com')).toBeNull();
    expect(userIdentity('+1 212 555 1234')).toBeNull();
    expect(userIdentity('  ')).toBeNull();
    expect(userIdentity('u'.repeat(129))).toBeNull();
  });

  it('omits the organization group when it is not resolved server-side', () => {
    expect(buildGroups({ workspaceId: WORKSPACE_ID })).toEqual({ workspace: WORKSPACE_ID });
    expect(buildGroups({ workspaceId: WORKSPACE_ID, organizationId: ORG_ID })).toEqual({
      workspace: WORKSPACE_ID,
      organization: ORG_ID,
    });
  });

  it('refuses to attribute an event to a malformed tenant', () => {
    expect(buildGroups({ workspaceId: 'not-a-uuid' })).toBeNull();
    expect(
      buildGroups({ workspaceId: WORKSPACE_ID, organizationId: 'not-a-uuid' }),
    ).toBeNull();
  });

  it('covers every event name in the identity policy', () => {
    expect(Object.keys(EVENT_IDENTITY_KIND).sort()).toEqual([...POSTHOG_EVENT_NAMES].sort());
  });
});

describe('buildPostHogCapture — identity is bound, not chosen', () => {
  it('binds call events to a non-person identity with tenant groups', () => {
    const capture = buildPostHogCapture({
      event: 'call.started',
      properties: { direction: 'outbound', to_number: '+12125551234' },
      context: {
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
        eventScopeId: CALL_ID,
        userId: 'user_1',
      },
    });

    expect(capture).toEqual({
      event: 'call_started',
      distinctId: `call:${CALL_ID}`,
      properties: { direction: 'outbound' },
      groups: { workspace: WORKSPACE_ID, organization: ORG_ID },
      processPersonProfile: false,
    });
  });

  it('ignores a supplied user ID for autonomous events', () => {
    const capture = buildPostHogCapture({
      event: 'call.started',
      properties: { direction: 'outbound' },
      context: { workspaceId: WORKSPACE_ID, eventScopeId: CALL_ID, userId: 'user_1' },
    });

    expect(capture?.distinctId).not.toBe('user_1');
    expect(capture?.processPersonProfile).toBe(false);
  });

  it('drops user-action events with no authenticated user', () => {
    expect(
      buildPostHogCapture({
        event: 'agent_created',
        properties: { agent_id: AGENT_ID },
        context: { workspaceId: WORKSPACE_ID },
      }),
    ).toBeNull();
  });

  it('drops call events with no opaque scope ID instead of bucketing them', () => {
    expect(
      buildPostHogCapture({
        event: 'call.started',
        properties: { direction: 'outbound' },
        context: { workspaceId: WORKSPACE_ID },
      }),
    ).toBeNull();
  });

  it('drops events with an untrusted tenant', () => {
    expect(
      buildPostHogCapture({
        event: 'agent_created',
        properties: { agent_id: AGENT_ID },
        context: { workspaceId: 'not-a-uuid', userId: 'user_1' },
      }),
    ).toBeNull();
  });

  it('never throws', () => {
    expect(() =>
      buildPostHogCapture({
        event: 'call.started',
        properties: {
          direction: 'outbound',
          get boom(): string {
            throw new Error('boom');
          },
        },
        context: { workspaceId: WORKSPACE_ID, eventScopeId: CALL_ID },
      }),
    ).not.toThrow();
  });
});
