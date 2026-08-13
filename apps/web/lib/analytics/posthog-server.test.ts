import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the server-side capture path used by route handlers.
 *
 * `server-only` is stubbed because it throws outside a React Server Component
 * bundle; its purpose is a build-time guard, not runtime behaviour.
 */
vi.mock('server-only', () => ({}));

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const ORGANIZATION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

const CONTEXT = {
  workspaceId: WORKSPACE_ID,
  organizationId: ORGANIZATION_ID,
  userId: USER_ID,
};

const ORIGINAL_ENV = { ...process.env };

function enable() {
  process.env.POSTHOG_ENABLED = 'true';
  process.env.POSTHOG_PROJECT_TOKEN = 'phc_test_token';
  process.env.POSTHOG_HOST = 'https://eu.i.posthog.com';
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.POSTHOG_ENABLED;
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete process.env.POSTHOG_HOST;

  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load() {
  return import('./posthog-server');
}

function sentBody() {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('captureServerEvent when disabled', () => {
  it('makes no request without the kill switch', async () => {
    const { captureServerEvent } = await load();
    process.env.POSTHOG_PROJECT_TOKEN = 'phc_test_token';

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no request without a project token', async () => {
    const { captureServerEvent } = await load();
    process.env.POSTHOG_ENABLED = 'true';

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('captureServerEvent', () => {
  beforeEach(enable);

  it('posts to the configured region host', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://eu.i.posthog.com/i/v0/e/');
  });

  it('binds the app user and both tenant groups', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent('user_signed_up', { workspace_id: WORKSPACE_ID }, CONTEXT);
    const body = sentBody();

    expect(body.event).toBe('user_signed_up');
    expect(body.distinct_id).toBe(USER_ID);
    expect((body.properties as Record<string, unknown>).$groups).toEqual({
      workspace: WORKSPACE_ID,
      organization: ORGANIZATION_ID,
    });
  });

  it('never lets PostHog infer location from the server egress IP', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect((sentBody().properties as Record<string, unknown>).$geoip_disable).toBe(true);
  });

  it('drops a user event with no authenticated user', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, {
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an event outside the closed contract', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent('onboarding_completed', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips properties the contract does not declare', async () => {
    const { captureServerEvent } = await load();

    await captureServerEvent(
      'workspace_created',
      { workspace_id: WORKSPACE_ID, email: 'someone@example.com', name: 'Acme Inc' },
      CONTEXT,
    );

    const serialized = JSON.stringify(sentBody());
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('Acme Inc');
  });

  it('resolves rather than throwing when the request fails', async () => {
    const { captureServerEvent } = await load();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(
      captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('falls back to the default host when the configured one is malformed', async () => {
    const { captureServerEvent } = await load();
    process.env.POSTHOG_HOST = 'http://evil.example/path';

    await captureServerEvent('workspace_created', { workspace_id: WORKSPACE_ID }, CONTEXT);

    expect(fetchMock.mock.calls[0]![0]).toBe('https://us.i.posthog.com/i/v0/e/');
  });
});

describe('captureServerException', () => {
  it('makes no request when analytics is disabled', async () => {
    const { captureServerException } = await load();

    await captureServerException(new Error('boom'));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('when enabled', () => {
    beforeEach(enable);

    it('sends an $exception event with the error type and message', async () => {
      const { captureServerException } = await load();

      await captureServerException(new TypeError('cannot read property'));
      const body = sentBody();
      const properties = body.properties as Record<string, unknown>;
      const list = properties.$exception_list as Array<Record<string, unknown>>;

      expect(body.event).toBe('$exception');
      expect(list[0]!.type).toBe('TypeError');
      expect(list[0]!.value).toBe('cannot read property');
    });

    it('coerces a thrown non-Error value', async () => {
      const { captureServerException } = await load();

      await captureServerException('string failure');
      const list = (sentBody().properties as Record<string, unknown>)
        .$exception_list as Array<Record<string, unknown>>;

      expect(list[0]!.value).toBe('string failure');
    });

    it('never creates a person profile or infers location', async () => {
      const { captureServerException } = await load();

      await captureServerException(new Error('boom'));
      const properties = sentBody().properties as Record<string, unknown>;

      expect(properties.$process_person_profile).toBe(false);
      expect(properties.$geoip_disable).toBe(true);
    });

    it('correlates with the browser report via the digest', async () => {
      const { captureServerException } = await load();

      await captureServerException(new Error('boom'), {
        digest: 'abc123',
        routePath: '/agents/[id]',
      });
      const body = sentBody();
      const properties = body.properties as Record<string, unknown>;

      expect(body.distinct_id).toBe('abc123');
      expect(properties.error_digest).toBe('abc123');
      expect(properties.route_path).toBe('/agents/[id]');
    });

    it('uses a non-person fallback ID when there is no digest', async () => {
      const { captureServerException } = await load();

      await captureServerException(new Error('boom'));

      expect(sentBody().distinct_id).toBe('web-server');
    });

    it('resolves rather than throwing when the request fails', async () => {
      const { captureServerException } = await load();
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      await expect(captureServerException(new Error('boom'))).resolves.toBeUndefined();
    });
  });
});
