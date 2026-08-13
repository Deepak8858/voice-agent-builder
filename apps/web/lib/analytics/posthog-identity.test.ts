import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Identity-lifecycle tests for the browser analytics helpers.
 *
 * `posthog-js` is mocked so the real SDK never loads: the assertions are about
 * which SDK calls this module decides to make, which is where the person-profile
 * correctness rules actually live.
 */

const posthogMock = vi.hoisted(() => ({
  __loaded: true,
  properties: new Map<string, unknown>(),
  reset: vi.fn(),
  resetGroups: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  get_distinct_id: vi.fn(() => ''),
  get_property: vi.fn((name: string) => posthogMock.properties.get(name)),
}));

vi.mock('posthog-js', () => ({ default: posthogMock }));

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';

// The helpers are browser-only; the suite runs under the node environment.
const hadWindow = 'window' in globalThis;

beforeEach(() => {
  if (!hadWindow) {
    (globalThis as { window?: unknown }).window = globalThis;
  }
  posthogMock.__loaded = true;
  posthogMock.properties.clear();
  posthogMock.get_distinct_id.mockReturnValue('');
  vi.clearAllMocks();
});

afterEach(() => {
  if (!hadWindow) {
    delete (globalThis as { window?: unknown }).window;
  }
});

async function load() {
  return import('./posthog');
}

describe('resetIdentityIfIdentified', () => {
  it('clears an identity left behind by a server-detected auth loss', async () => {
    const { resetIdentityIfIdentified } = await load();
    // What `identify()` leaves in persistence for a signed-in user.
    posthogMock.properties.set('$user_id', USER_A);

    resetIdentityIfIdentified();

    expect(posthogMock.reset).toHaveBeenCalledTimes(1);
  });

  it('leaves an anonymous visitor alone so the signup funnel stays intact', async () => {
    const { resetIdentityIfIdentified } = await load();

    resetIdentityIfIdentified();

    // Resetting here would mint a new anonymous ID on every sign-in page view
    // and break the attribution chain into signup.
    expect(posthogMock.reset).not.toHaveBeenCalled();
  });

  it('is a no-op when the SDK never loaded', async () => {
    const { resetIdentityIfIdentified } = await load();
    posthogMock.properties.set('$user_id', USER_A);
    posthogMock.__loaded = false;

    resetIdentityIfIdentified();

    expect(posthogMock.reset).not.toHaveBeenCalled();
  });

  it('never propagates an SDK failure', async () => {
    const { resetIdentityIfIdentified } = await load();
    posthogMock.properties.set('$user_id', USER_A);
    posthogMock.reset.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    expect(() => resetIdentityIfIdentified()).not.toThrow();
  });
});

describe('identifyUser', () => {
  it('resets before claiming a different user on the same device', async () => {
    const { identifyUser } = await load();
    posthogMock.get_distinct_id.mockReturnValue(USER_A);

    identifyUser({ userId: USER_B, workspaceId: WORKSPACE_ID });

    expect(posthogMock.reset).toHaveBeenCalledTimes(1);
    expect(posthogMock.identify).toHaveBeenCalledWith(USER_B);
    expect(posthogMock.group).toHaveBeenCalledWith('workspace', WORKSPACE_ID);
  });

  it('does not reset when re-identifying the same user', async () => {
    const { identifyUser } = await load();
    posthogMock.get_distinct_id.mockReturnValue(USER_A);

    identifyUser({ userId: USER_A, workspaceId: WORKSPACE_ID });

    expect(posthogMock.reset).not.toHaveBeenCalled();
    expect(posthogMock.identify).toHaveBeenCalledWith(USER_A);
  });

  it('never sends person properties and clears a stale workspace group', async () => {
    const { identifyUser } = await load();

    identifyUser({ userId: USER_A, workspaceId: null });

    expect(posthogMock.identify).toHaveBeenCalledWith(USER_A);
    expect(posthogMock.identify.mock.calls[0]).toHaveLength(1);
    expect(posthogMock.group).not.toHaveBeenCalled();
    expect(posthogMock.resetGroups).toHaveBeenCalledTimes(1);
  });

  it('accepts a non-UUID auth-provider ID', async () => {
    const { identifyUser } = await load();

    // App user IDs are not guaranteed to be UUIDs; the policy is shape-based.
    identifyUser({ userId: 'auth0|abc123', workspaceId: null });

    expect(posthogMock.identify).toHaveBeenCalledWith('auth0|abc123');
  });

  it('refuses to make a PII-shaped value a person distinct ID', async () => {
    const { identifyUser } = await load();

    identifyUser({ userId: 'someone@example.com', workspaceId: WORKSPACE_ID });

    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.group).not.toHaveBeenCalled();
  });

  it('drops a malformed workspace ID rather than grouping on it', async () => {
    const { identifyUser } = await load();

    identifyUser({ userId: USER_A, workspaceId: 'not-a-uuid' });

    // The user is still identified; only the untrusted group is withheld.
    expect(posthogMock.identify).toHaveBeenCalledWith(USER_A);
    expect(posthogMock.group).not.toHaveBeenCalled();
  });
});
