import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  findMutatingWorkspaceRoutesWithoutRole,
  findUnguardedRoutes,
  routeKey,
} from './route-guard-analyzer';

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

/**
 * Role ratchet. WorkspaceGuard proves membership, not seat, so a mutating
 * workspace route without @RequiredRole is writable by any viewer. Every
 * mutating route under `workspaces/:workspaceId` must either declare
 * @RequiredRole (handler or controller) or sit here with its reason.
 *
 * ponytail: the literal key list and the pinned length ARE the control —
 * growing this set must show up as a reviewed diff on both, never as an
 * incidentally green build.
 */
const ROLE_EXEMPT: Record<string, string> = {
  // Deliberately open to every member: POST only for the payload shape.
  'analytics/analytics.controller.ts:AnalyticsController.record':
    'telemetry append from any member session; not tenant configuration',
  'compliance/compliance.controller.ts:ComplianceController.check':
    'read-shaped pre-call compliance evaluation; writes nothing a role protects',
  'knowledge/knowledge.controller.ts:KnowledgeController.search':
    'read-shaped retrieval query',

  // @SessionScoped mutations authorized by something other than a seat.
  'white-label/white-label.controller.ts:InviteAcceptController.accept':
    'the invite token is the authorization, verified against the caller email in acceptInvite',
  'referral/referral.controller.ts:ReferralController.createReferral':
    'per-user action on own session workspace; credit tier decision pending before any gate',
  'referral/referral.controller.ts:ReferralController.acceptReferral':
    'per-user action on own session workspace; credit tier decision pending before any gate',

  // Internal runtime caller holds no membership row; a role gate breaks it.
  'calendar/calendar.controller.ts:CalendarController.connect':
    'called by the voice runtime with the internal key, no user session to hold a role',
  'calendar/calendar.controller.ts:CalendarController.disconnect':
    'called by the voice runtime with the internal key, no user session to hold a role',

  // Hand-rolled owner/admin(/editor) checks still in the handlers; the
  // decorator conversion for these controllers has not landed yet.

  // Not yet gated — outside the 2026-08-28 retrofit wave. No hand-rolled
  // check either: today any member can call these.
  'agent-gen/agent-gen.controller.ts:AgentGenController.create':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'agent-gen/agent-gen.controller.ts:AgentGenController.sendMessage':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'agent-gen/agent-gen.controller.ts:AgentGenController.retry':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'agent-gen/agent-gen.controller.ts:AgentGenController.finalize':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'agent-gen/agent-gen.controller.ts:AgentGenController.remove':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.create':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.upload':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.update':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.remove':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.reindex':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'knowledge/knowledge.controller.ts:KnowledgeController.backfill':
    'not yet gated; content authoring (owner/admin/editor when gated)',
  'compliance/contacts.controller.ts:ContactsController.upsert':
    'not yet gated; consent/contact capture needs a tier decision before gating',
  'compliance/contacts.controller.ts:ContactsController.update':
    'not yet gated; consent/contact capture needs a tier decision before gating',
  'compliance/contacts.controller.ts:ContactsController.grantConsent':
    'not yet gated; consent/contact capture needs a tier decision before gating',
  'compliance/contacts.controller.ts:ContactsController.revokeConsent':
    'not yet gated; consent/contact capture needs a tier decision before gating',
  'compliance/contacts.controller.ts:ContactsController.optOut':
    'not yet gated; consent/contact capture needs a tier decision before gating',

  // Dead module still mounted in app.module.ts; unmounting is its own plan
  // item and the ground rules forbid touching it meanwhile.
  'phone-numbers/phone-numbers.controller.ts:PhoneNumbersController.provision':
    'dead code, do-not-touch until unmounted',
  'phone-numbers/phone-numbers.controller.ts:PhoneNumbersController.addByo':
    'dead code, do-not-touch until unmounted',
  'phone-numbers/phone-numbers.controller.ts:PhoneNumbersController.assign':
    'dead code, do-not-touch until unmounted',
  'phone-numbers/phone-numbers.controller.ts:PhoneNumbersController.release':
    'dead code, do-not-touch until unmounted',
};

describe('role coverage baseline', () => {
  it('requires a role on every mutating workspace route not deliberately exempted', () => {
    const findings = findMutatingWorkspaceRoutesWithoutRole(SRC_DIR).filter(
      (r) => !(routeKey(r) in ROLE_EXEMPT),
    );

    expect(
      findings.map((r) => `${r.file}:${r.line} ${r.method} ${r.route} — no @RequiredRole`),
    ).toEqual([]);
  });

  it('pins the exemption count and rejects stale entries', () => {
    expect(Object.keys(ROLE_EXEMPT)).toHaveLength(28);

    // An exemption whose route was since gated or deleted must be removed, or
    // the list rots into cover for the next ungated route.
    const current = new Set(
      findMutatingWorkspaceRoutesWithoutRole(SRC_DIR).map(routeKey),
    );
    expect(Object.keys(ROLE_EXEMPT).filter((k) => !current.has(k))).toEqual([]);
  });

  it('does not count @RequiredRole as coverage unless RoleGuard is bound', () => {
    // The fail-open half: RoleGuard is never an APP_GUARD, so the decorator
    // with no binding is an open route that reviews as gated. Run the analyzer
    // over a fixture pair so this rule is pinned without mutating real source.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-ratchet-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fixture.controller.ts'),
        `
        @Controller('workspaces/:workspaceId/fixture')
        @UseGuards(WorkspaceGuard)
        export class DecoratorOnlyController {
          @Post()
          @RequiredRole('owner', 'admin')
          create() {}
        }
        @Controller('workspaces/:workspaceId/fixture2')
        @UseGuards(WorkspaceGuard)
        export class BoundController {
          @Post()
          @UseGuards(RoleGuard)
          @RequiredRole('owner', 'admin')
          create() {}
        }
        `,
      );
      const keys = findMutatingWorkspaceRoutesWithoutRole(dir).map(routeKey);
      expect(keys).toContain('fixture.controller.ts:DecoratorOnlyController.create');
      expect(keys).not.toContain('fixture.controller.ts:BoundController.create');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a converted route when @RequiredRole stops counting', () => {
    // Mutation check on the analyzer itself, mirroring the guardCoverage one:
    // pretend no decorator satisfies the requirement and the wave's converted
    // routes must all reappear.
    const findings = findMutatingWorkspaceRoutesWithoutRole(SRC_DIR, {
      requiredRoleDecorator: 'NoSuchDecorator',
    });

    const keys = findings.map(routeKey);
    expect(keys).toContain('agents/agents.controller.ts:AgentsController.create');
    expect(keys).toContain('telephony/telephony.controller.ts:TelephonyController.createConnection');
    expect(findings.length).toBeGreaterThan(Object.keys(ROLE_EXEMPT).length);
  });
});
