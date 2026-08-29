import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { env } from '../config/env';
import { AuditExportController } from '../audit/audit-export.controller';
import { BillingAdminController } from '../billing/billing-admin.controller';
import { ComplianceManifestController } from '../compliance/compliance-manifest.controller';
import { ErasureController } from '../compliance/erasure.controller';
import { RetentionController } from '../compliance/retention.controller';

/**
 * Pins @InternalOnly() onto every operator-admin route. Unlike the guard's
 * own unit tests, this uses the real Reflector against the real controller
 * classes, so it fails if the decorator is removed from — or never reached —
 * any of these handlers, not just if the guard logic regresses. The threat is
 * the Next.js proxy: it attaches the internal key to any path a signed-in user
 * requests, so an admin route that merely authenticates is reachable by every
 * tenant user.
 */

const ADMIN_ROUTES: ReadonlyArray<[string, new (...args: never[]) => unknown, string]> = [
  ['GET admin/audit/export', AuditExportController, 'adminExport'],
  ['POST admin/audit/report', AuditExportController, 'generateReport'],
  ['POST admin/retention/sweep', RetentionController, 'sweep'],
  ['DELETE admin/orgs/:orgId', ErasureController, 'eraseOrganization'],
  ['GET admin/compliance/manifest', ComplianceManifestController, 'getManifest'],
  [
    'POST admin/billing/orgs/:orgId/clear-balance-review',
    BillingAdminController,
    'clearBalanceReview',
  ],
];

function contextFor(
  cls: new (...args: never[]) => unknown,
  handler: string,
  headers: Record<string, string>,
) {
  const req = { headers, method: 'POST', path: '/admin/test' };
  return {
    req,
    ctx: {
      getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
}

describe('admin routes are internal-only', () => {
  beforeEach(() => {
    Object.assign(env, { INTERNAL_API_KEY: 'test-internal-api-key-with-32-chars' });
  });

  it.each(ADMIN_ROUTES)('%s refuses a user-bearer request', async (_route, cls, handler) => {
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(new Reflector(), authService as never);
    // Exactly what the web proxy sends on behalf of a signed-in user.
    const { ctx } = contextFor(cls, handler, {
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      authorization: 'Bearer verified-token',
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect(authService.getSessionUser).not.toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)('%s admits a bare internal-key request', async (_route, cls, handler) => {
    const guard = new InternalAuthGuard(new Reflector(), { getSessionUser: vi.fn() } as never);
    const { ctx, req } = contextFor(cls, handler, {
      'x-internal-key': 'test-internal-api-key-with-32-chars',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req).not.toHaveProperty('user');
  });

  // Negative control: the erasure controller also serves tenant self-service
  // routes, so its @InternalOnly() must be method-level. If it ever drifted to
  // the class, this session request would start failing.
  it('leaves ErasureController.eraseContact reachable by a user session', async () => {
    const authService = {
      getSessionUser: vi.fn(async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.com',
        name: null,
        active_workspace_id: '22222222-2222-4222-8222-222222222222',
        active_workspace_name: 'Own Workspace',
        active_workspace_role: 'owner',
      })),
    };
    const guard = new InternalAuthGuard(new Reflector(), authService as never);
    const { ctx } = contextFor(ErasureController, 'eraseContact', {
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      authorization: 'Bearer verified-token',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
