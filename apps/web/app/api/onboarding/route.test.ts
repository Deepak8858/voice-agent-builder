import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// `after()` needs a Next request context that vitest does not provide. Run the
// callback inline instead so the analytics assertions stay meaningful.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (fn: () => unknown) => void fn() };
});

const authUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'farmer@example.com',
  app_metadata: { provider: 'email' },
  user_metadata: { full_name: 'A Farmer' },
};

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser } }) },
  }),
}));

const updateUserById = vi.fn(
  async (_userId: string, _attrs: { app_metadata: Record<string, unknown> }) => ({
    error: null,
  }),
);

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => adminClient,
}));

const captureServerEvent = vi.fn(
  async (_event: string, _properties: Record<string, unknown>, _context: unknown) => undefined,
);
vi.mock('@/lib/analytics/posthog-server', () => ({
  captureServerEvent: (
    event: string,
    properties: Record<string, unknown>,
    context: unknown,
  ) => captureServerEvent(event, properties, context),
}));

import { POST } from './route';

// ---------------------------------------------------------------------------
// Minimal in-memory stand-in for the Supabase REST client. It models the one
// thing this route now depends on for correctness: the unique index on
// `organizations.slug`.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let db: Record<string, Row[]>;
let sequence = 0;

class Query implements PromiseLike<{ data: Row | null; error: { message: string } | null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: Row = {};
  private conflict: string[] = [];
  private filters: Array<[string, unknown]> = [];
  private orderKey: string | null = null;

  constructor(private readonly table: string) {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = payload;
    this.conflict = (opts?.onConflict ?? '').split(',').filter(Boolean);
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  order(column: string) {
    this.orderKey = column;
    return this;
  }
  limit(_n: number) {
    return this;
  }
  maybeSingle() {
    return Promise.resolve(this.run(true));
  }
  single() {
    return Promise.resolve(this.run(false));
  }
  then<TResult1 = { data: Row | null; error: { message: string } | null }, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: Row | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run(true)).then(onFulfilled, onRejected);
  }

  private rows(): Row[] {
    const matched = (db[this.table] ?? []).filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
    if (this.orderKey) {
      matched.sort((a, b) => Number(a[this.orderKey!]) - Number(b[this.orderKey!]));
    }
    return matched;
  }

  private run(allowEmpty: boolean): { data: Row | null; error: { message: string } | null } {
    db[this.table] ??= [];

    if (this.op === 'insert' || this.op === 'upsert') {
      const existing =
        this.op === 'upsert'
          ? db[this.table]!.find((row) =>
              this.conflict.every((column) => row[column] === this.payload[column]),
            )
          : undefined;
      if (existing) {
        Object.assign(existing, this.payload);
        return { data: existing, error: null };
      }
      // The unique index the cap relies on.
      if (
        this.table === 'organizations' &&
        db.organizations!.some((row) => row.slug === this.payload.slug)
      ) {
        return {
          data: null,
          error: { message: 'duplicate key value violates unique constraint' },
        };
      }
      sequence += 1;
      const inserted: Row = {
        id: `${this.table}-${sequence}`,
        created_at: sequence,
        ...this.payload,
      };
      db[this.table]!.push(inserted);
      return { data: inserted, error: null };
    }

    if (this.op === 'update') {
      const matched = this.rows();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched[0] ?? null, error: null };
    }

    const found = this.rows()[0] ?? null;
    if (!found && !allowEmpty) {
      return { data: null, error: { message: 'no rows returned' } };
    }
    return { data: found, error: null };
  }
}

const adminClient = {
  from: (table: string) => new Query(table),
  auth: { admin: { updateUserById } },
};

function onboardingRequest(body: Record<string, unknown>): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** The slug `provisionPersonalWorkspace` in the API derives for this identity. */
const personalSlug = `user-${createHash('sha256').update(authUser.id).digest('hex').slice(0, 24)}`;

beforeEach(() => {
  db = { users: [], organizations: [], workspaces: [], memberships: [] };
  sequence = 0;
  updateUserById.mockClear();
  captureServerEvent.mockClear();
});

describe('POST /api/onboarding organization cap', () => {
  it('creates one organization per identity no matter how many times it is submitted', async () => {
    const first = await POST(onboardingRequest({ orgName: 'Farm One' }));
    const second = await POST(onboardingRequest({ orgName: 'Farm Two' }));
    const third = await POST(onboardingRequest({ orgName: 'Farm Three' }));

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(db.organizations).toHaveLength(1);
    // Each free monthly allowance is granted per organization, so N ids here
    // would be N allowances for one identity.
    const ids = await Promise.all(
      [first, second, third].map(async (res) => (await res.json()).organizationId),
    );
    expect(new Set(ids).size).toBe(1);
    // ...and no extra workspace per submission either.
    expect(db.workspaces).toHaveLength(1);
  });

  it('derives the organization slug from the auth identity, not the submitted name', async () => {
    await POST(onboardingRequest({ orgName: 'Acme Inc' }));

    expect(db.organizations[0]!.slug).toBe(personalSlug);
  });

  it('keeps the name the user supplied on both the organization and the workspace', async () => {
    await POST(onboardingRequest({ orgName: 'Acme Inc', workspaceName: 'Support Team' }));

    expect(db.organizations[0]).toMatchObject({ name: 'Acme Inc' });
    expect(db.workspaces[0]).toMatchObject({ name: 'Support Team' });
  });

  it('adopts the organization the API pre-provisioned and renames it', async () => {
    // What `GET /auth/me` leaves behind for a user who reached the API first.
    db.organizations.push({
      id: 'org-existing',
      slug: personalSlug,
      name: 'Personal',
      created_at: 0,
    });
    db.workspaces.push({
      id: 'ws-existing',
      organization_id: 'org-existing',
      name: 'Demo Workspace',
      created_at: 0,
    });

    const res = await POST(onboardingRequest({ orgName: 'Acme Inc', workspaceName: 'Sales' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      organizationId: 'org-existing',
      workspaceId: 'ws-existing',
    });
    expect(db.organizations).toHaveLength(1);
    expect(db.organizations[0]).toMatchObject({ name: 'Acme Inc' });
    expect(db.workspaces).toHaveLength(1);
    expect(db.workspaces[0]).toMatchObject({ name: 'Sales' });
    // A reused workspace was already counted by whichever path created it.
    expect(captureServerEvent.mock.calls.map((call) => call[0])).not.toContain(
      'workspace_created',
    );
  });

  /**
   * `provisionPersonalWorkspace` in the API still looks up the pre-hash slug
   * shape, so organizations provisioned by an older release live at
   * `user-<first 8 of the uuid>`. Without the same lookup here the cap is not a
   * cap for exactly those users: the hash-slug upsert finds no conflict and
   * mints a second organization, hence a second free monthly allowance.
   */
  it('adopts an organization left at the legacy slug instead of minting a second one', async () => {
    db.organizations.push({
      id: 'org-legacy',
      slug: `user-${authUser.id.slice(0, 8)}`,
      name: 'Personal',
      owner_user_id: 'users-1',
      created_at: 0,
    });

    const res = await POST(onboardingRequest({ orgName: 'Acme Inc' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organizationId: 'org-legacy' });
    expect(db.organizations).toHaveLength(1);
    expect(db.organizations[0]).toMatchObject({ name: 'Acme Inc' });
  });

  /**
   * Eight hex characters collide far more readily than the twenty-four the hash
   * slug uses, so the legacy lookup is owner-verified. A legacy-shaped slug
   * belonging to somebody else must not be adopted.
   */
  it('ignores a legacy-slug organization owned by a different user', async () => {
    db.organizations.push({
      id: 'org-someone-else',
      slug: `user-${authUser.id.slice(0, 8)}`,
      name: 'Not Yours',
      owner_user_id: 'users-999',
      created_at: 0,
    });

    const res = await POST(onboardingRequest({ orgName: 'Acme Inc' }));

    expect(res.status).toBe(200);
    expect(db.organizations).toHaveLength(2);
    expect(db.organizations.find((row) => row.id === 'org-someone-else')).toMatchObject({
      name: 'Not Yours',
      owner_user_id: 'users-999',
    });
    expect((await res.json()).organizationId).not.toBe('org-someone-else');
  });

  it('still writes the session app_metadata the web app reads', async () => {
    await POST(onboardingRequest({ orgName: 'Acme Inc' }));

    expect(updateUserById).toHaveBeenCalledTimes(1);
    const [userId, attrs] = updateUserById.mock.calls[0]!;
    expect(userId).toBe(authUser.id);
    expect(attrs.app_metadata).toMatchObject({
      provider: 'email',
      app_user_id: db.users[0]!.id,
      active_org_id: db.organizations[0]!.id,
      active_org_role: 'owner',
      active_workspace_id: db.workspaces[0]!.id,
    });
  });
});
