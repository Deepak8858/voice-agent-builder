import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhiteLabelService } from './white-label.service';
import { AppError, ValidationError } from '../common/errors';

interface WorkspaceRow {
  id: string;
  organizationId: string;
  parentWorkspaceId: string | null;
  type: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
}

interface MembershipRow {
  userId: string;
  workspaceId: string;
  role: string;
}

interface SettingsRow {
  id: string;
  workspaceId: string;
  brandName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  supportEmail: string | null;
  hidePlatformBranding: boolean;
  updatedAt: Date;
}

interface InviteRow {
  id: string;
  agencyWorkspaceId: string;
  clientWorkspaceId: string | null;
  email: string;
  role: string;
  token: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  invitedBy: string | null;
  createdAt: Date;
}

interface CallRow {
  workspaceId: string;
  durationSeconds: number | null;
  agentId: string;
  outcome: string | null;
  createdAt: Date;
}

interface ComplianceRow {
  workspaceId: string;
  status: string;
  checkedAt: Date;
}

function inRange(d: Date, gte?: Date, lte?: Date): boolean {
  if (gte && d < gte) return false;
  if (lte && d > lte) return false;
  return true;
}

function makePrisma(state: {
  workspaces: WorkspaceRow[];
  memberships: MembershipRow[];
  settings: SettingsRow[];
  invites: InviteRow[];
  calls: CallRow[];
  compliance: ComplianceRow[];
  users?: { id: string; email: string }[];
}) {
  let nextId = 1;
  const id = () => `id-${nextId++}`;

  const tx = {
    workspace: {
      update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const ws = state.workspaces.find((w) => w.id === where.id);
        if (!ws) throw new Error('not found');
        Object.assign(ws, data);
        return ws;
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const row: WorkspaceRow = {
          id: id(),
          organizationId: data.organizationId,
          parentWorkspaceId: data.parentWorkspaceId ?? null,
          type: data.type ?? 'direct',
          name: data.name,
          slug: data.slug,
          status: data.status ?? 'active',
          createdAt: new Date(),
        };
        state.workspaces.push(row);
        return row;
      }),
    },
    membership: {
      create: vi.fn(async ({ data }: { data: any }) => {
        const row: MembershipRow = {
          userId: data.userId,
          workspaceId: data.workspaceId,
          role: data.role,
        };
        state.memberships.push(row);
        return row;
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: any; create: any; update: any }) => {
        const existing = state.memberships.find(
          (m) =>
            m.userId === where.userId_workspaceId.userId &&
            m.workspaceId === where.userId_workspaceId.workspaceId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: MembershipRow = {
          userId: create.userId,
          workspaceId: create.workspaceId,
          role: create.role,
        };
        state.memberships.push(row);
        return row;
      }),
    },
    clientInvite: {
      update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const inv = state.invites.find((i) => i.id === where.id);
        if (!inv) throw new Error('not found');
        Object.assign(inv, data);
        return inv;
      }),
    },
  };

  return {
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.id) return state.workspaces.find((w) => w.id === where.id) ?? null;
        if (where.organizationId_slug) {
          return (
            state.workspaces.find(
              (w) =>
                w.organizationId === where.organizationId_slug.organizationId &&
                w.slug === where.organizationId_slug.slug,
            ) ?? null
          );
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: any }) => {
        const ws = state.workspaces.find((w) => w.id === where.id);
        if (!ws) throw new Error(`workspace ${where.id} not found`);
        return ws;
      }),
      findMany: vi.fn(async ({ where, orderBy }: { where: any; orderBy?: any }) => {
        let rows = state.workspaces.filter((w) => {
          if (where.parentWorkspaceId && w.parentWorkspaceId !== where.parentWorkspaceId) return false;
          if (where.type && w.type !== where.type) return false;
          return true;
        });
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return rows;
      }),
      update: tx.workspace.update,
      create: tx.workspace.create,
    },
    membership: tx.membership,
    whiteLabelSettings: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.workspaceId) {
          return state.settings.find((s) => s.workspaceId === where.workspaceId) ?? null;
        }
        if (where.customDomain) {
          return state.settings.find((s) => s.customDomain === where.customDomain) ?? null;
        }
        return null;
      }),
      upsert: vi.fn(
        async ({ where, create, update }: { where: any; create: any; update: any }) => {
          const existing = state.settings.find((s) => s.workspaceId === where.workspaceId);
          if (existing) {
            Object.assign(existing, update);
            existing.updatedAt = new Date();
            return existing;
          }
          const row: SettingsRow = {
            id: id(),
            workspaceId: create.workspaceId,
            brandName: create.brandName ?? null,
            logoUrl: create.logoUrl ?? null,
            primaryColor: create.primaryColor ?? null,
            customDomain: create.customDomain ?? null,
            supportEmail: create.supportEmail ?? null,
            hidePlatformBranding: create.hidePlatformBranding ?? false,
            updatedAt: new Date(),
          };
          state.settings.push(row);
          return row;
        },
      ),
    },
    clientInvite: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.id) return state.invites.find((i) => i.id === where.id) ?? null;
        if (where.token) return state.invites.find((i) => i.token === where.token) ?? null;
        return null;
      }),
      findMany: vi.fn(async ({ where, orderBy }: { where: any; orderBy?: any }) => {
        let rows = state.invites.filter(
          (i) => !where.agencyWorkspaceId || i.agencyWorkspaceId === where.agencyWorkspaceId,
        );
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return rows;
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const row: InviteRow = {
          id: id(),
          agencyWorkspaceId: data.agencyWorkspaceId,
          clientWorkspaceId: data.clientWorkspaceId ?? null,
          email: data.email,
          role: data.role,
          token: data.token,
          status: data.status ?? 'pending',
          expiresAt: data.expiresAt,
          acceptedAt: null,
          invitedBy: data.invitedBy ?? null,
          createdAt: new Date(),
        };
        state.invites.push(row);
        return row;
      }),
      update: tx.clientInvite.update,
    },
    call: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        return state.calls.filter(
          (c) =>
            c.workspaceId === where.workspaceId &&
            inRange(c.createdAt, where.createdAt?.gte, where.createdAt?.lte),
        );
      }),
    },
    complianceCheck: {
      count: vi.fn(async ({ where }: { where: any }) => {
        return state.compliance.filter(
          (c) =>
            c.workspaceId === where.workspaceId &&
            c.status === where.status &&
            inRange(c.checkedAt, where.checkedAt?.gte, where.checkedAt?.lte),
        ).length;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.id) {
          return state.users?.find((u) => u.id === where.id) ?? null;
        }
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
}

const audit = { log: vi.fn(async () => undefined) } as any;
const ACTOR = '00000000-0000-0000-0000-000000000001';
const AGENCY = 'aa000000-0000-0000-0000-000000000001';
const ORG = 'or000000-0000-0000-0000-000000000001';

function freshState() {
  return {
    workspaces: [
      {
        id: AGENCY,
        organizationId: ORG,
        parentWorkspaceId: null,
        type: 'direct',
        name: 'Agency',
        slug: 'agency',
        status: 'active',
        createdAt: new Date(2026, 0, 1),
      },
    ] as WorkspaceRow[],
    memberships: [] as MembershipRow[],
    settings: [] as SettingsRow[],
    invites: [] as InviteRow[],
    calls: [] as CallRow[],
    compliance: [] as ComplianceRow[],
    users: [] as { id: string; email: string }[],
  };
}

describe('WhiteLabelService.getSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty defaults when no row exists', async () => {
    const state = freshState();
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const s = await svc.getSettings(AGENCY);
    expect(s.workspace_id).toBe(AGENCY);
    expect(s.brand_name).toBeNull();
    expect(s.hide_platform_branding).toBe(false);
  });

  it('returns persisted row', async () => {
    const state = freshState();
    state.settings.push({
      id: 's1',
      workspaceId: AGENCY,
      brandName: 'Foo',
      logoUrl: null,
      primaryColor: '#112233',
      customDomain: null,
      supportEmail: null,
      hidePlatformBranding: true,
      updatedAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const s = await svc.getSettings(AGENCY);
    expect(s.brand_name).toBe('Foo');
    expect(s.primary_color).toBe('#112233');
    expect(s.hide_platform_branding).toBe(true);
  });
});

describe('WhiteLabelService.updateSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts a new settings row', async () => {
    const state = freshState();
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const s = await svc.updateSettings(AGENCY, ACTOR, {
      brand_name: 'My Agency',
      primary_color: '#abcdef',
      hide_platform_branding: true,
    });
    expect(s.brand_name).toBe('My Agency');
    expect(state.settings).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'white_label.update' }),
    );
  });

  it('rejects custom_domain already used by another workspace', async () => {
    const state = freshState();
    state.settings.push({
      id: 'other',
      workspaceId: 'ws-other',
      brandName: null,
      logoUrl: null,
      primaryColor: null,
      customDomain: 'voice.agency.com',
      supportEmail: null,
      hidePlatformBranding: false,
      updatedAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(
      svc.updateSettings(AGENCY, ACTOR, { custom_domain: 'voice.agency.com' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('allows same workspace to keep its own domain', async () => {
    const state = freshState();
    state.settings.push({
      id: 'mine',
      workspaceId: AGENCY,
      brandName: null,
      logoUrl: null,
      primaryColor: null,
      customDomain: 'voice.agency.com',
      supportEmail: null,
      hidePlatformBranding: false,
      updatedAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const s = await svc.updateSettings(AGENCY, ACTOR, {
      custom_domain: 'voice.agency.com',
      brand_name: 'New brand',
    });
    expect(s.custom_domain).toBe('voice.agency.com');
    expect(s.brand_name).toBe('New brand');
  });
});

describe('WhiteLabelService.createClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a child workspace and promotes parent direct → agency', async () => {
    const state = freshState();
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const c = await svc.createClient(AGENCY, ACTOR, { name: 'Acme', slug: 'acme' });
    expect(c.parent_workspace_id).toBe(AGENCY);
    expect(c.slug).toBe('acme');
    const parent = state.workspaces.find((w) => w.id === AGENCY)!;
    expect(parent.type).toBe('agency');
    const child = state.workspaces.find((w) => w.id === c.id)!;
    expect(child.type).toBe('client');
    expect(state.memberships.find((m) => m.workspaceId === c.id)?.role).toBe('owner');
  });

  it('rejects duplicate slug within the same organization', async () => {
    const state = freshState();
    state.workspaces.push({
      id: 'existing',
      organizationId: ORG,
      parentWorkspaceId: AGENCY,
      type: 'client',
      name: 'Old',
      slug: 'acme',
      status: 'active',
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(
      svc.createClient(AGENCY, ACTOR, { name: 'New', slug: 'acme' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('WhiteLabelService.listClients', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only direct children of type=client', async () => {
    const state = freshState();
    state.workspaces.push(
      {
        id: 'c1',
        organizationId: ORG,
        parentWorkspaceId: AGENCY,
        type: 'client',
        name: 'Client 1',
        slug: 'c1',
        status: 'active',
        createdAt: new Date(2026, 0, 2),
      },
      {
        id: 'c2',
        organizationId: ORG,
        parentWorkspaceId: AGENCY,
        type: 'client',
        name: 'Client 2',
        slug: 'c2',
        status: 'active',
        createdAt: new Date(2026, 0, 3),
      },
      {
        // unrelated workspace, not under this agency
        id: 'other',
        organizationId: ORG,
        parentWorkspaceId: null,
        type: 'direct',
        name: 'Other',
        slug: 'other',
        status: 'active',
        createdAt: new Date(),
      },
    );
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const items = await svc.listClients(AGENCY);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('c2'); // newest first
  });
});

describe('WhiteLabelService.clientUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls up calls + minutes + blocks for the child workspace', async () => {
    const state = freshState();
    state.workspaces.push({
      id: 'child',
      organizationId: ORG,
      parentWorkspaceId: AGENCY,
      type: 'client',
      name: 'C',
      slug: 'c',
      status: 'active',
      createdAt: new Date(),
    });
    const now = new Date();
    state.calls = [
      { workspaceId: 'child', durationSeconds: 60, agentId: 'a1', outcome: 'message_taken', createdAt: now },
      { workspaceId: 'child', durationSeconds: 120, agentId: 'a1', outcome: 'message_taken', createdAt: now },
      { workspaceId: 'child', durationSeconds: 30, agentId: 'a2', outcome: 'message_taken', createdAt: now },
    ];
    state.compliance = [
      { workspaceId: 'child', status: 'blocked', checkedAt: now },
    ];
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const u = await svc.clientUsage(AGENCY, 'child');
    expect(u.total_calls).toBe(3);
    expect(u.total_minutes).toBe(3.5);
    expect(u.blocked_calls).toBe(1);
    expect(u.active_agents).toBe(2);
  });

  it('rejects when child belongs to a different agency', async () => {
    const state = freshState();
    state.workspaces.push({
      id: 'child',
      organizationId: ORG,
      parentWorkspaceId: 'other-agency',
      type: 'client',
      name: 'C',
      slug: 'c',
      status: 'active',
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(svc.clientUsage(AGENCY, 'child')).rejects.toBeInstanceOf(AppError);
  });
});

describe('WhiteLabelService invites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an invite with hex token + future expiry', async () => {
    const state = freshState();
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const inv = await svc.createInvite(AGENCY, ACTOR, {
      email: 'client@example.com',
      role: 'admin',
      expires_in_days: 7,
    });
    expect(inv.email).toBe('client@example.com');
    expect(inv.status).toBe('pending');
    expect(inv.token).toMatch(/^[0-9a-f]{48}$/);
    expect(new Date(inv.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects invite with client_workspace_id not under this agency', async () => {
    const state = freshState();
    state.workspaces.push({
      id: 'rogue',
      organizationId: ORG,
      parentWorkspaceId: 'other',
      type: 'client',
      name: 'Rogue',
      slug: 'rogue',
      status: 'active',
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(
      svc.createInvite(AGENCY, ACTOR, {
        email: 'a@b.com',
        role: 'admin',
        client_workspace_id: 'rogue',
        expires_in_days: 14,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('revokes a pending invite', async () => {
    const state = freshState();
    state.invites.push({
      id: 'inv1',
      agencyWorkspaceId: AGENCY,
      clientWorkspaceId: null,
      email: 'a@b.com',
      role: 'admin',
      token: 'abc',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: null,
      invitedBy: ACTOR,
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const r = await svc.revokeInvite(AGENCY, ACTOR, 'inv1');
    expect(r.status).toBe('revoked');
  });

  it('refuses to revoke an already-accepted invite', async () => {
    const state = freshState();
    state.invites.push({
      id: 'inv1',
      agencyWorkspaceId: AGENCY,
      clientWorkspaceId: null,
      email: 'a@b.com',
      role: 'admin',
      token: 'abc',
      status: 'accepted',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: new Date(),
      invitedBy: ACTOR,
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(svc.revokeInvite(AGENCY, ACTOR, 'inv1')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('accepts a pending invite, creates membership, marks accepted', async () => {
    const state = freshState();
    state.workspaces.push({
      id: 'child',
      organizationId: ORG,
      parentWorkspaceId: AGENCY,
      type: 'client',
      name: 'C',
      slug: 'c',
      status: 'active',
      createdAt: new Date(),
    });
    state.invites.push({
      id: 'inv1',
      agencyWorkspaceId: AGENCY,
      clientWorkspaceId: 'child',
      email: 'a@b.com',
      role: 'admin',
      token: 'tok-123',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: null,
      invitedBy: ACTOR,
      createdAt: new Date(),
    });
    state.users.push({ id: 'user-2', email: 'a@b.com' });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    const r = await svc.acceptInvite('user-2', 'tok-123');
    expect(r.status).toBe('accepted');
    expect(r.accepted_at).not.toBeNull();
    const mem = state.memberships.find(
      (m) => m.userId === 'user-2' && m.workspaceId === 'child',
    );
    expect(mem?.role).toBe('admin');
  });

  it('rejects an expired invite + flips it to expired', async () => {
    const state = freshState();
    state.invites.push({
      id: 'inv1',
      agencyWorkspaceId: AGENCY,
      clientWorkspaceId: 'child',
      email: 'a@b.com',
      role: 'admin',
      token: 'tok-x',
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
      acceptedAt: null,
      invitedBy: ACTOR,
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(svc.acceptInvite('user-2', 'tok-x')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(state.invites[0].status).toBe('expired');
  });

  it('rejects an unknown token', async () => {
    const state = freshState();
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(svc.acceptInvite('user-2', 'nope')).rejects.toBeInstanceOf(AppError);
  });

  it('rejects accept when invite has no client_workspace_id bound', async () => {
    const state = freshState();
    state.invites.push({
      id: 'inv1',
      agencyWorkspaceId: AGENCY,
      clientWorkspaceId: null,
      email: 'a@b.com',
      role: 'admin',
      token: 'tok-y',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: null,
      invitedBy: ACTOR,
      createdAt: new Date(),
    });
    const svc = new WhiteLabelService(makePrisma(state) as never, audit);
    await expect(svc.acceptInvite('user-2', 'tok-y')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
