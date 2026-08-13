import { describe, expect, it, vi } from 'vitest';
import type { PostHogConfig } from './posthog.config';
import {
  PostHogService,
  type PostHogClientFactory,
  type PostHogClientLike,
} from './posthog.service';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const ORGANIZATION_ID = '22222222-2222-2222-2222-222222222222';
const CALL_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = '55555555-5555-5555-5555-555555555555';

const CONFIG: PostHogConfig = {
  projectToken: 'phc_test_token',
  host: 'https://us.i.posthog.com',
  environment: 'test',
  release: '1.2.3',
};

interface FakeClient extends PostHogClientLike {
  captures: Array<Parameters<PostHogClientLike['capture']>[0]>;
  exceptions: Array<{
    error: unknown;
    distinctId?: string;
    additionalProperties?: Record<string, unknown>;
  }>;
  registered: Array<Record<string, unknown>>;
  shutdownCalls: number;
}

function makeClient(overrides: Partial<PostHogClientLike> = {}): FakeClient {
  const client: FakeClient = {
    captures: [],
    exceptions: [],
    registered: [],
    shutdownCalls: 0,
    capture(message) {
      client.captures.push(message);
    },
    captureException(error, distinctId, additionalProperties) {
      client.exceptions.push({ error, distinctId, additionalProperties });
    },
    register(properties) {
      client.registered.push(properties);
    },
    shutdown() {
      client.shutdownCalls += 1;
    },
    ...overrides,
  };
  return client;
}

function makeService(client: FakeClient, config: PostHogConfig | null = CONFIG) {
  const factory: PostHogClientFactory = vi.fn(() => client);
  return { service: new PostHogService(config, factory), factory };
}

describe('PostHogService when unconfigured', () => {
  it('constructs no client and never calls the factory', () => {
    const factory = vi.fn(() => makeClient());
    const service = new PostHogService(null, factory);
    expect(service.enabled).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('capture and shutdown are inert no-ops', async () => {
    const factory = vi.fn(() => makeClient());
    const service = new PostHogService(null, factory);
    expect(() =>
      service.capture(
        { event: 'agent_created', properties: { agent_id: AGENT_ID } },
        { workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID, userId: USER_ID },
      ),
    ).not.toThrow();
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('posthogConfigFromEnv is null without POSTHOG_ENABLED', async () => {
    // Pin the precondition: an ambient POSTHOG_ENABLED in a developer shell or
    // CI job must not be able to flip this assertion. The validated `env`
    // object is parsed at module load, so the module graph must be re-imported
    // under the stubbed environment for the stub to take effect.
    vi.stubEnv('POSTHOG_ENABLED', '');
    vi.resetModules();
    try {
      const { posthogConfigFromEnv: fromEnv } = await import('./posthog.config');
      expect(fromEnv()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('stays inert when the client factory throws', () => {
    const service = new PostHogService(CONFIG, () => {
      throw new Error('bad token');
    });
    expect(service.enabled).toBe(false);
  });
});

describe('PostHogService.capture', () => {
  it('registers release metadata only as super properties', () => {
    const client = makeClient();
    makeService(client);
    expect(client.registered).toEqual([{ environment: 'test', release: '1.2.3' }]);
  });

  it('sends user-action events with the app user ID and both groups', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.capture(
      { event: 'agent_created', properties: { agent_id: AGENT_ID } },
      { workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID, userId: USER_ID },
    );

    expect(client.captures).toHaveLength(1);
    const sent = client.captures[0]!;
    expect(sent.event).toBe('agent_created');
    expect(sent.distinctId).toBe(USER_ID);
    expect(sent.groups).toEqual({
      workspace: WORKSPACE_ID,
      organization: ORGANIZATION_ID,
    });
    expect(sent.disableGeoip).toBe(true);
    expect(sent.properties?.$process_person_profile).toBeUndefined();
  });

  it('drops a user-action event with no authenticated user', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.capture(
      { event: 'agent_created', properties: { agent_id: AGENT_ID } },
      { workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID },
    );

    expect(client.captures).toHaveLength(0);
  });

  it('sends autonomous call events without a person profile', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.capture(
      {
        event: 'call_started',
        properties: { call_id: CALL_ID, agent_id: AGENT_ID, direction: 'outbound' },
      },
      {
        workspaceId: WORKSPACE_ID,
        organizationId: ORGANIZATION_ID,
        eventScopeId: CALL_ID,
      },
    );

    const sent = client.captures[0]!;
    expect(sent.distinctId).toBe(`call:${CALL_ID}`);
    expect(sent.properties?.$process_person_profile).toBe(false);
  });

  it('drops an autonomous event with no event scope ID', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.capture(
      { event: 'call_started', properties: { direction: 'outbound' } },
      { workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID },
    );

    expect(client.captures).toHaveLength(0);
  });

  it('drops an event whose workspace ID is not a trusted opaque ID', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.capture(
      { event: 'agent_created', properties: { agent_id: AGENT_ID } },
      { workspaceId: 'not-a-uuid', userId: USER_ID },
    );

    expect(client.captures).toHaveLength(0);
  });

  it('never propagates an SDK failure to the caller', () => {
    const client = makeClient({
      capture() {
        throw new Error('posthog exploded');
      },
    });
    const { service } = makeService(client);

    expect(() =>
      service.capture(
        { event: 'agent_created', properties: { agent_id: AGENT_ID } },
        { workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID, userId: USER_ID },
      ),
    ).not.toThrow();
  });

  it('never propagates a failing super-property registration', async () => {
    const client = makeClient({
      register() {
        return Promise.reject(new Error('register failed'));
      },
    });
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() => makeService(client)).not.toThrow();
    // Let the rejected registration promise settle before asserting: the
    // constructor must have attached its own catch handler.
    await new Promise((resolve) => setImmediate(resolve));

    process.removeListener('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('PostHogService.captureException', () => {
  it('is an inert no-op when unconfigured', () => {
    const service = new PostHogService(null, vi.fn());
    expect(() => service.captureException(new Error('boom'))).not.toThrow();
  });

  it('forwards the error without a person profile', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.captureException(new Error('boom'), 'corr-1');

    expect(client.exceptions).toHaveLength(1);
    const sent = client.exceptions[0]!;
    expect((sent.error as Error).message).toBe('boom');
    expect(sent.distinctId).toBe('corr-1');
    expect(sent.additionalProperties).toEqual({ $process_person_profile: false });
  });

  it('falls back to a server identity when no correlation ID exists', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.captureException(new Error('boom'));

    expect(client.exceptions[0]!.distinctId).toBe('api-server');
  });

  it('wraps non-Error values so the SDK always receives an Error', () => {
    const client = makeClient();
    const { service } = makeService(client);

    service.captureException('string failure');

    const sent = client.exceptions[0]!.error;
    expect(sent).toBeInstanceOf(Error);
    expect((sent as Error).message).toBe('string failure');
  });

  it('never propagates an SDK failure to the caller', () => {
    const client = makeClient({
      captureException() {
        throw new Error('posthog exploded');
      },
    });
    const { service } = makeService(client);

    expect(() => service.captureException(new Error('boom'))).not.toThrow();
  });
});

describe('PostHogService.shutdown', () => {
  it('flushes exactly once across repeated calls', async () => {
    const client = makeClient();
    const { service } = makeService(client);

    await Promise.all([service.shutdown(), service.shutdown()]);
    await service.shutdown();

    expect(client.shutdownCalls).toBe(1);
  });

  it('resolves even when the SDK rejects', async () => {
    const client = makeClient({
      shutdown() {
        return Promise.reject(new Error('flush failed'));
      },
    });
    const { service } = makeService(client);

    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it('passes its own bound to the SDK', async () => {
    const shutdown = vi.fn();
    const client = makeClient({ shutdown });
    const { service } = makeService(client);

    await service.shutdown();

    expect(shutdown).toHaveBeenCalledWith(expect.any(Number));
    expect(shutdown.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('gives up on a flush that never settles instead of stalling shutdown', async () => {
    vi.useFakeTimers();
    try {
      // A hung socket during a network partition: the SDK promise never
      // settles, so only the local guard timer can release the shutdown hook.
      const client = makeClient({
        shutdown: () => new Promise<void>(() => {}),
      });
      const { service } = makeService(client);

      let settled = false;
      const pending = service.shutdown().then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
