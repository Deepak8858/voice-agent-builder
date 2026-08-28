import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';
import {
  PostHogService,
  type PostHogClientLike,
} from '../posthog/posthog.service';
import type { PostHogConfig } from '../posthog/posthog.config';

/**
 * End-to-end privacy tests for the `recordEventInternal` dual-write. A real
 * `PostHogService` is wired to a fake SDK client so the whole pipeline —
 * adapter, shared contract, identity and group resolution — is exercised, and
 * assertions run against exactly what would go on the wire.
 */

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const ORGANIZATION_ID = '22222222-2222-2222-2222-222222222222';
const CALL_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '44444444-4444-4444-4444-444444444444';
const CHECK_ID = '66666666-6666-6666-6666-666666666666';
const TO_NUMBER = '+14155550123';

const CONFIG: PostHogConfig = {
  projectToken: 'phc_test_token',
  host: 'https://us.i.posthog.com',
  environment: 'test',
  release: 'test',
};

type CaptureMessage = Parameters<PostHogClientLike['capture']>[0];

function makeHarness(clientOverrides: Partial<PostHogClientLike> = {}) {
  const captures: CaptureMessage[] = [];
  const client: PostHogClientLike = {
    capture: (message) => {
      captures.push(message);
    },
    captureException: () => {},
    register: () => {},
    shutdown: () => {},
    ...clientOverrides,
  };
  const posthog = new PostHogService(CONFIG, () => client);

  const create = vi.fn(async () => ({
    id: 'evt-1',
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    callId: CALL_ID,
    eventType: 'call.started',
    payload: null,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  const organizationIdFor = vi.fn<() => Promise<string | null>>(async () => ORGANIZATION_ID);
  // recordEvent re-reads the client-supplied agent/call under the workspace
  // predicate before writing; both are owned here.
  const prisma = {
    organizationIdFor,
    analyticsEvent: { create },
    agent: { findFirst: vi.fn(async () => ({ id: AGENT_ID })) },
    call: { findFirst: vi.fn(async () => ({ id: CALL_ID })) },
  };

  const service = new AnalyticsService(prisma as never, undefined, posthog);
  return { service, captures, create, organizationIdFor };
}

/** What the SDK would actually serialize onto the wire. */
function wire(captures: CaptureMessage[]): string {
  return JSON.stringify(captures);
}

describe('recordEventInternal → PostHog mirror', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never forwards the raw to_number on call.started', async () => {
    const { service, captures } = makeHarness();

    // Payload shape emitted by calls.service.ts on outbound start.
    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      callId: CALL_ID,
      eventType: 'call.started',
      payload: { direction: 'outbound', to_number: TO_NUMBER },
    });

    expect(captures).toHaveLength(1);
    const serialized = wire(captures);
    expect(serialized).not.toContain(TO_NUMBER);
    expect(serialized).not.toContain('to_number');
    expect(captures[0]!.event).toBe('call_started');
    expect(captures[0]!.properties).toMatchObject({
      call_id: CALL_ID,
      agent_id: AGENT_ID,
      direction: 'outbound',
    });
  });

  it('never forwards the to_number or reason messages on call.blocked', async () => {
    const { service, captures } = makeHarness();

    // Payload shape emitted by calls.service.ts on a pre-call compliance block.
    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      eventType: 'call.blocked',
      payload: {
        reasons: [
          {
            code: 'dnc_listed',
            message: `Number ${TO_NUMBER} is on the do-not-call list`,
            severity: 'blocking',
          },
        ],
        to_number: TO_NUMBER,
        compliance_check_id: CHECK_ID,
      },
    });

    expect(captures).toHaveLength(1);
    const serialized = wire(captures);
    expect(serialized).not.toContain(TO_NUMBER);
    expect(serialized).not.toContain('do-not-call');
    expect(captures[0]!.properties).toMatchObject({
      agent_id: AGENT_ID,
      reason_codes: ['dnc_listed'],
    });
    // No call row exists yet, so the compliance check ID scopes the event.
    expect(captures[0]!.distinctId).toBe(`call:${CHECK_ID}`);
  });

  it('forwards call.ended outcome and duration only', async () => {
    const { service, captures } = makeHarness();

    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      callId: CALL_ID,
      eventType: 'call.ended',
      payload: {
        outcome: 'appointment_booked',
        duration_seconds: 42,
        direction: 'outbound',
      },
    });

    expect(captures[0]!.event).toBe('call_ended');
    expect(captures[0]!.properties).toMatchObject({
      outcome: 'appointment_booked',
      duration_seconds: 42,
    });
  });

  it('drops the dynamic outcome.* events', async () => {
    const { service, captures } = makeHarness();

    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      callId: CALL_ID,
      eventType: 'outcome.appointment_booked',
      payload: { direction: 'outbound' },
    });

    expect(captures).toHaveLength(0);
  });

  it('drops unknown internal event types', async () => {
    const { service, captures } = makeHarness();

    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      eventType: 'tool.failed',
      payload: { tool: 'book_appointment' },
    });

    expect(captures).toHaveLength(0);
  });

  it('drops a blocked event whose reasons are malformed', async () => {
    const { service, captures } = makeHarness();

    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      eventType: 'call.blocked',
      payload: { reasons: 'blocked because of stuff', compliance_check_id: CHECK_ID },
    });

    expect(captures).toHaveLength(0);
  });

  it('attributes events to the server-resolved organization', async () => {
    const { service, captures, organizationIdFor } = makeHarness();

    await service.recordEventInternal({
      workspaceId: WORKSPACE_ID,
      callId: CALL_ID,
      eventType: 'call.started',
      payload: { direction: 'outbound' },
    });

    expect(organizationIdFor).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(captures[0]!.groups).toEqual({
      workspace: WORKSPACE_ID,
      organization: ORGANIZATION_ID,
    });
  });

  it('still writes to Postgres and does not throw when the SDK throws', async () => {
    const { service, create } = makeHarness({
      capture() {
        throw new Error('posthog exploded');
      },
    });

    await expect(
      service.recordEventInternal({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        callId: CALL_ID,
        eventType: 'call.started',
        payload: { direction: 'outbound', to_number: TO_NUMBER },
      }),
    ).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not mirror an event Postgres failed to store', async () => {
    const { service, captures, create } = makeHarness();
    create.mockRejectedValueOnce(new Error('unique constraint violation'));

    await expect(
      service.recordEventInternal({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        callId: CALL_ID,
        eventType: 'call.started',
        payload: { direction: 'outbound' },
      }),
    ).resolves.toBeUndefined();

    // Postgres is the system of record: PostHog must not report an event that
    // never landed there.
    expect(captures).toHaveLength(0);
  });

  it('drops the mirror when the organization resolves to null after persistence', async () => {
    const { service, captures, organizationIdFor, create } = makeHarness();
    organizationIdFor.mockResolvedValueOnce(null);

    await expect(
      service.recordEventInternal({
        workspaceId: WORKSPACE_ID,
        callId: CALL_ID,
        eventType: 'call.started',
        payload: { direction: 'outbound' },
      }),
    ).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(0);
  });

  it('drops the mirror rather than sending partial tenant attribution', async () => {
    const { service, captures, organizationIdFor, create } = makeHarness();
    organizationIdFor.mockRejectedValueOnce(new Error('lookup failed'));

    await expect(
      service.recordEventInternal({
        workspaceId: WORKSPACE_ID,
        callId: CALL_ID,
        eventType: 'call.started',
        payload: { direction: 'outbound' },
      }),
    ).resolves.toBeUndefined();

    // The lookup throws before the insert, so nothing is persisted and nothing
    // is mirrored with a workspace-only group.
    expect(create).not.toHaveBeenCalled();
    expect(captures).toHaveLength(0);
  });

  it('does not capture when no PostHog service is injected', async () => {
    const create = vi.fn(async () => ({}));
    const prisma = {
      organizationIdFor: vi.fn(async () => ORGANIZATION_ID),
      analyticsEvent: { create },
    };
    const service = new AnalyticsService(prisma as never);

    await expect(
      service.recordEventInternal({
        workspaceId: WORKSPACE_ID,
        callId: CALL_ID,
        eventType: 'call.started',
        payload: { direction: 'outbound' },
      }),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('public recordEvent ingestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never mirrors user-supplied events to PostHog', async () => {
    const { service, captures } = makeHarness();

    await service.recordEvent(WORKSPACE_ID, {
      event_type: 'call.started',
      agent_id: AGENT_ID,
      call_id: CALL_ID,
      payload: { direction: 'outbound', to_number: TO_NUMBER },
    });

    expect(captures).toHaveLength(0);
  });
});
