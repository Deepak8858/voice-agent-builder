import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { BillingController } from './billing.controller';

function makeController() {
  const billing = {
    createCheckoutSession: vi.fn(async () => ({ url: 'https://checkout.test' })),
    createTopUpCheckoutSession: vi.fn(async () => ({ url: 'https://topup.test' })),
    createPortalSession: vi.fn(async () => ({ url: 'https://portal.test' })),
    getSubscription: vi.fn(async () => ({ stripeCustomerId: 'cus_123' })),
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

function request(
  role: SessionUser['active_workspace_role'],
  activeWorkspaceId = 'ws-1',
): Request {
  return {
    user: { active_workspace_role: role, active_workspace_id: activeWorkspaceId },
    query: {},
  } as unknown as Request;
}

/** A request the guard never populated, e.g. because it was bypassed. */
function requestWithoutSessionUser(): Request {
  return { query: {} } as unknown as Request;
}

const checkoutDto = {
  plan: 'starter' as const,
  idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
  successPath: '/dashboard/billing?checkout=success',
  cancelPath: '/dashboard/billing?checkout=cancel',
};

const topUpDto = {
  idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
  successPath: '/dashboard/billing?topup=success',
  cancelPath: '/dashboard/billing?topup=cancel',
};

const portalDto = { returnPath: '/dashboard/billing' };

describe('BillingController authorization', () => {
  it.each([
    ['checkout', (controller: BillingController) =>
      controller.createCheckout('ws-1', request('viewer'), checkoutDto)],
    ['top-up checkout', (controller: BillingController) =>
      controller.createTopUpCheckout('ws-1', request('viewer'), topUpDto)],
    ['portal', (controller: BillingController) =>
      controller.createPortal('ws-1', request('viewer'), portalDto)],
    ['invoices', (controller: BillingController) =>
      controller.getInvoices('ws-1', request('viewer'))],
  ])('denies viewers access to %s', async (_name, invoke) => {
    const { controller, billing, prisma } = makeController();

    await expect(invoke(controller)).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createTopUpCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createPortalSession).not.toHaveBeenCalled();
    expect(billing.getInvoices).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('allows %s to start checkout', async (role) => {
    const { controller, billing } = makeController();

    await expect(controller.createCheckout('ws-1', request(role), checkoutDto)).resolves.toEqual({
      url: 'https://checkout.test',
    });
    expect(billing.createCheckoutSession).toHaveBeenCalledWith('org-1', checkoutDto);
  });

  /**
   * If a guard does not populate the session, the role is `undefined`. That
   * must deny rather than fall through to a paid action.
   */
  it.each([
    ['checkout', (controller: BillingController) =>
      controller.createCheckout('ws-1', requestWithoutSessionUser(), checkoutDto)],
    ['top-up checkout', (controller: BillingController) =>
      controller.createTopUpCheckout('ws-1', requestWithoutSessionUser(), topUpDto)],
    ['portal', (controller: BillingController) =>
      controller.createPortal('ws-1', requestWithoutSessionUser(), portalDto)],
    ['invoices', (controller: BillingController) =>
      controller.getInvoices('ws-1', requestWithoutSessionUser())],
  ])('denies %s to a request with no session user', async (_name, invoke) => {
    const { controller, billing, prisma } = makeController();

    await expect(invoke(controller)).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createTopUpCheckoutSession).not.toHaveBeenCalled();
    expect(billing.createPortalSession).not.toHaveBeenCalled();
    expect(billing.getInvoices).not.toHaveBeenCalled();
  });

  /**
   * The role on the session belongs to the caller's active workspace. These
   * endpoints therefore depend on `WorkspaceGuard` having already established
   * that the path workspace *is* that active workspace; the role alone is not
   * a cross-tenant grant. This documents that contract: an owner of one
   * workspace reaches organization billing only for the workspace the guard
   * admitted, which is why the guard runs before the role check.
   */
  it('resolves the organization from the path workspace, not the session workspace', async () => {
    const { controller, billing, prisma } = makeController();

    await controller.createCheckout('ws-1', request('owner', 'ws-other'), checkoutDto);

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { organizationId: true, parentWorkspaceId: true, type: true },
    });
    expect(billing.createCheckoutSession).toHaveBeenCalledWith('org-1', checkoutDto);
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
    ['checkout', (c: BillingController) => c.createCheckout('ws-client', request('owner'), checkoutDto)],
    ['top-up checkout', (c: BillingController) =>
      c.createTopUpCheckout('ws-client', request('owner'), topUpDto)],
    ['portal', (c: BillingController) => c.createPortal('ws-client', request('owner'), portalDto)],
    ['invoices', (c: BillingController) => c.getInvoices('ws-client', request('owner'))],
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
      stripeCustomerId: 'cus_123',
    });
    expect(billing.getSubscription).toHaveBeenCalledWith('org-agency');
  });
});
