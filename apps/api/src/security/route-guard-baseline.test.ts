import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { findUnguardedRoutes, routeKey } from './route-guard-analyzer';

/**
 * Ratchet for route-level tenant authorization.
 *
 * `tenant-scope-baseline.test.ts` guards the service layer: no Prisma query on a
 * tenant-scoped model without a tenant predicate. This test guards the layer
 * above it, which that analyzer is blind to. A query scoped by
 * `where: { workspaceId }` is still a cross-tenant hole when `workspaceId` is a
 * path param that no guard verified, and the service-layer analyzer sees a
 * correctly-scoped query in exactly that case.
 *
 * Unlike the tenant-scope baseline, this one is empty and must stay empty.
 * Every route naming a tenant in its path has a guard that can check that
 * specific param. There is no legitimate reason to accept a tenant id from the
 * URL without authorizing it, so a finding here is a defect rather than
 * something to review and accept.
 *
 * If you need a route whose tenant comes from the session rather than the path,
 * do not add a tenant param to the path: read `active_workspace_id` from the
 * verified session and mark the route @SessionScoped(). That is what the
 * erasure and retention endpoints do.
 */

const SRC_DIR = path.resolve(__dirname, '..');

describe('route guard baseline', () => {
  it('parses the controller surface rather than passing vacuously', () => {
    // A silent parse failure would make the assertion below meaningless. The
    // API has well over a hundred workspace-scoped routes; assert the analyzer
    // is actually seeing routes and guards.
    const routes = findUnguardedRoutes(SRC_DIR, { guardCoverage: {} });
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.guards.includes('WorkspaceGuard'))).toBe(true);
    expect(routes.some((r) => r.tenantParam === 'orgId')).toBe(true);
  });

  it('authorizes every route that names a tenant in its path', () => {
    const findings = findUnguardedRoutes(SRC_DIR);

    expect(
      findings.map(
        (r) =>
          `${r.file}:${r.line} ${r.method} ${r.route} — :${r.tenantParam} not covered by ` +
          `${r.guards.length > 0 ? r.guards.join(', ') : 'no guard'}`,
      ),
    ).toEqual([]);
  });

  it('detects a route whose guard cannot check its tenant param', () => {
    // Mutation check on the analyzer itself: if OrganizationGuard stopped
    // counting for :orgId, the org audit-log route must be reported again.
    // Without this, a broken analyzer would report zero findings and the test
    // above would pass for the wrong reason.
    const findings = findUnguardedRoutes(SRC_DIR, {
      guardCoverage: { WorkspaceGuard: ['workspaceId'], InternalAuthGuard: ['workspaceId'] },
    });

    const keys = findings.map(routeKey);
    expect(keys).toContain('audit/audit-export.controller.ts:AuditExportController.getOrgAuditLogs');
    expect(keys).toContain('compliance/erasure.controller.ts:ErasureController.eraseOrganization');
  });
});
