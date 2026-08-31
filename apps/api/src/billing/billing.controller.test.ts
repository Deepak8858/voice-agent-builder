import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@voiceforge/shared';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { BillingController } from './billing.controller';

const handler = (name: string) =>
  (BillingController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];

function makeController() {
  const billing = {
    createCheckoutSession: vi.fn(async () => ({ url: 'https://checkout.test' })),
    createTopUpCheckoutSession: vi.fn(async () => ({ url: 'https://topup.test' })),
    createPortalSession: vi.fn(async () => ({ url: 'https://portal.test' })),
    getSubscription: vi.fn(async () => ({ dodoCustomerId: 'cus_123' })),
    getInvoices: vi.fn(async () => ({ items: [] })),
    getBillingSummary: vi.fn(async () => ({ organizationId: 'org-1' })),
  };
  const prisma = {
    workspace: {
      findUnique: vi.fn(async () => ({
        organizationId: 'org-1',
        parentWorkspaceId: null,
        type: 'direct',
      })),
    },
  };
  return {
    billing,
    prisma,
    controller: new BillingController(billing as never, prisma as never),
  };
}

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class), so these tests fail if someone removes
 * a decorator or widens a role set. The membership role comes from the stubbed
 * database row, exactly where the guard is required to read it from.
 */
function roleGuard(
  handlerName: string,
  membershipRole: string | null,
  user: Record<string, unknown> | null | undefined = { id: 'user-1' },
) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({
        params: { workspaceId: 'ws-1' },
        ...(user === null ? {} : { user }),
      }),
    }),
    getHandler: () => handler(handlerName),
    getClass: () => BillingController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

const checkoutDto = {
  plan: 'starter' as const,
  idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
  successPath: '/dashboard/billing?checkout=success',
  cancelPath: '/dashboard/billing?checkout=cancel',
};

/** The signed-in caller the money routes must audit, from the session only. */
const USER = { id: 'user-1' } as unknown as SessionUser;

const MONEY_ROUTES = ['createCheckout', 'createTopUpCheckout', 'createPortal', 'getInvoices'] as const;

describe('BillingController authorization', () => {
  it.each(MONEY_ROUTES)('gates %s to owner/admin', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin'],
      fresh: false,
    });
  });

  it.each(['getSubscription', 'getBillingStatus', 'getSummary', 'getUsage'] as const)(
    'leaves %s open to every member',
    (name) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RoleGuard);
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toBeUndefined();
    },
  );

  it.each(
    MONEY_ROUTES.flatMap((name) => (['viewer', 'editor'] as const).map((role) => [role, name] as const)),
  )('denies a %s on %s', async (role, name) => {
    const { guard, ctx } = roleGuard(name, role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s to start checkout', async (role) => {
    const { guard, ctx } = roleGuard('createCheckout', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /** A request no auth guard populated must deny, not fall through to a paid action. */
  it('denies a request with no session user', async () => {
    const { guard, ctx } = roleGuard('createCheckout', 'owner', null);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  /**
   * The old inline assertBillingAdmin trusted `active_workspace_role` off the
   * session; RoleGuard resolves the seat from the membership row for the
   * workspace in the URL. A caller whose session says owner-of-somewhere-else
   * but who holds no membership here is denied.
   */
  it('denies a caller with no membership in the path workspace', async () => {
    const { guard, ctx } = roleGuard('createCheckout', null, {
      id: 'user-1',
      active_workspace_id: 'ws-other',
      active_workspace_role: 'owner',
    });

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it.each(MONEY_ROUTES)('%s cannot be reached as a viewer through the bound guards', async (name) => {
    const { controller, billing, prisma } = makeController();
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, BillingController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard(name, 'viewer');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return (controller[name as 'createCheckout'] as (...args: unknown[]) => unknown)(
        'ws-1',
        checkoutDto,
        USER,
      );
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createTopUpCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createPortalSession).not.toHaveBeenCalled();
    expect(billing.getInvoices).not.toHaveBeenCalled();
  });

  it('resolves the organization from the path workspace', async () => {
    const { controller, billing, prisma } = makeController();

    await controller.createCheckout('ws-1', checkoutDto, USER);

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { organizationId: true, parentWorkspaceId: true, type: true },
    });
    // The actor is threaded from the session, so the audit row names who paid.
    expect(billing.createCheckoutSession).toHaveBeenCalledWith('org-1', checkoutDto, 'user-1');
  });

  it('keeps billing summary readable by viewers', async () => {
    const { controller, billing } = makeController();

    await expect(controller.getSummary('ws-1')).resolves.toEqual({ organizationId: 'org-1' });
    expect(billing.getBillingSummary).toHaveBeenCalledWith('org-1');
  });
});

/**
 * A white-label client workspace carries its parent agency's organizationId
 * (`white-label.service.ts:179`), so being `owner` of the client workspace used
 * to be enough to reach the agency's organization billing. `owner` is the role
 * the client's own creator gets, and the Stripe portal it unlocked can cancel
 * the agency's plan for every client on it — so this is checked for every route
 * that resolves an organization, not only the mutating ones.
 */
describe('BillingController client-workspace escalation', () => {
  function clientWorkspaceController(
    overrides: { parentWorkspaceId?: string | null; type?: string } = {},
  ) {
    const made = makeController();
    made.prisma.workspace.findUnique = vi.fn(async () => ({
      organizationId: 'org-agency',
      parentWorkspaceId: 'ws-agency',
      type: 'client',
      ...overrides,
    }));
    return made;
  }

  it.each([
    ['subscription', (c: BillingController) => c.getSubscription('ws-client')],
    ['summary', (c: BillingController) => c.getSummary('ws-client')],
    ['checkout', (c: BillingController) => c.createCheckout('ws-client', checkoutDto, USER)],
    ['top-up checkout', (c: BillingController) =>
      c.createTopUpCheckout('ws-client', {
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing?topup=success',
        cancelPath: '/dashboard/billing?topup=cancel',
      }, USER)],
    ['portal', (c: BillingController) =>
      c.createPortal('ws-client', { returnPath: '/dashboard/billing' }, USER)],
    ['invoices', (c: BillingController) => c.getInvoices('ws-client')],
  ])("denies a client workspace owner the agency's %s", async (_name, invoke) => {
    const { controller, billing } = clientWorkspaceController();

    await expect(invoke(controller)).rejects.toBeInstanceOf(ForbiddenError);
    expect(billing.getSubscription).not.toHaveBeenCalled();
    expect(billing.getBillingSummary).not.toHaveBeenCalled();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createTopUpCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createPortalSession).not.toHaveBeenCalled();
    expect(billing.getInvoices).not.toHaveBeenCalled();
  });

  // Each half of the predicate has to stand alone: today the two fields are
  // written in the same statement, so a test that set both would pass even if
  // one condition were dropped.
  it.each([
    ['a parent but no client type', { type: 'direct' }],
    ['a client type but no parent', { parentWorkspaceId: null }],
  ])('denies a workspace with %s', async (_name, overrides) => {
    const { controller } = clientWorkspaceController(overrides);

    await expect(controller.getSubscription('ws-client')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('still serves the agency workspace that owns the organization', async () => {
    const { controller, billing } = clientWorkspaceController({
      parentWorkspaceId: null,
      type: 'agency',
    });

    await expect(controller.getSubscription('ws-agency')).resolves.toEqual({
      dodoCustomerId: 'cus_123',
    });
    expect(billing.getSubscription).toHaveBeenCalledWith('org-agency');
  });
});
