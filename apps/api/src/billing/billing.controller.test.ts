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
      findUnique: vi.fn(async () => ({ organizationId: 'org-1' })),
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
      select: { organizationId: true },
    });
    expect(billing.createCheckoutSession).toHaveBeenCalledWith('org-1', checkoutDto);
  });

  it('keeps billing summary readable by viewers', async () => {
    const { controller, billing } = makeController();

    await expect(controller.getSummary('ws-1')).resolves.toEqual({ organizationId: 'org-1' });
    expect(billing.getBillingSummary).toHaveBeenCalledWith('org-1');
  });
});
