import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Static detector for controller routes that name a tenant in their path but
 * are not authorized against it.
 *
 * The tenant-scope analyzer covers the service layer: it finds Prisma queries
 * with no tenant predicate. That is only half the problem. A query can be
 * perfectly scoped by `where: { workspaceId }` and still be a cross-tenant hole
 * if `workspaceId` came from a path param that nobody checked. Three real
 * defects had exactly that shape:
 *
 *   - `DELETE v1/orgs/:orgId/contacts/:contactId/erasure` carried
 *     `WorkspaceGuard`, which only inspects `:workspaceId`, so it authorized
 *     nothing while looking guarded. The service then treated `:orgId` as a
 *     workspace id and permanently deleted the contact.
 *   - `GET v1/orgs/:orgId/audit-logs` had no guard at all.
 *   - `PATCH workspaces/me/retention` and three referral routes carried
 *     `WorkspaceGuard` on a path it could not check, so the decoration hid
 *     whether a check was intended.
 *
 * This analyzer reports every route whose effective path contains a recognised
 * tenant param but whose guards cannot check that param. `WorkspaceGuard`
 * counts only for `:workspaceId` and `OrganizationGuard` only for `:orgId`.
 *
 * `@InternalOnly()` covers either param, because it restricts the route to the
 * platform operator rather than a tenant user. Listing `InternalAuthGuard` in
 * `@UseGuards` does not: it is the global auth guard, so every authenticated
 * user already passes it and the decoration restricts nothing. Since e7b718a
 * the decorator is the thing that refuses user-carrying requests, so it is the
 * thing that counts here.
 */

export type GuardCoverage = Record<string, readonly string[]>;

/** Guards that authorize a caller against a specific tenant param. */
export const GUARD_COVERAGE: GuardCoverage = {
  WorkspaceGuard: ['workspaceId'],
  OrganizationGuard: ['orgId'],
};

export interface AnalyzerOptions {
  /**
   * Overrides which guards count as covering which params. Exists so the
   * accompanying test can shrink coverage and confirm the analyzer still
   * reports the routes it should — an analyzer that silently parsed nothing
   * would otherwise look identical to a clean tree.
   */
  guardCoverage?: GuardCoverage;
  /**
   * Which decorator name restricts a route to the platform operator, and so
   * covers any tenant param in its path. The accompanying test overrides it
   * with a name no route carries, so the operator-only routes must reappear —
   * otherwise `guardCoverage: {}` would no longer prove anything about them.
   */
  internalOnlyDecorator?: string;
}

export interface RoleAnalyzerOptions {
  /**
   * Which decorator name satisfies the role requirement. The accompanying test
   * overrides it with a name no route carries, so every converted route must
   * reappear — the same anti-vacuity trick as `guardCoverage`.
   */
  requiredRoleDecorator?: string;
}

const TENANT_PARAMS = ['workspaceId', 'orgId'] as const;

const HTTP_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'All']);

export interface UnguardedRoute {
  file: string;
  line: number;
  controller: string;
  handler: string;
  method: string;
  /** Controller prefix joined with the handler path. */
  route: string;
  /** The tenant param present in the path that no guard covers. */
  tenantParam: string;
  /** Guards actually applied, from both the class and the method. */
  guards: readonly string[];
}

/** Stable key for baseline comparison, independent of line numbers. */
export function routeKey(r: Pick<UnguardedRoute, 'file' | 'controller' | 'handler'>): string {
  return `${r.file}:${r.controller}.${r.handler}`;
}

function listControllerFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

/** Decorator name, e.g. `Get` for `@Get('x')` and `UseGuards` for `@UseGuards(A)`. */
function decoratorName(dec: ts.Decorator): string | null {
  const expr = ts.isCallExpression(dec.expression) ? dec.expression.expression : dec.expression;
  return ts.isIdentifier(expr) ? expr.text : null;
}

/** First argument of a decorator call, when it is a string literal. */
function decoratorStringArg(dec: ts.Decorator): string | null {
  if (!ts.isCallExpression(dec.expression)) return null;
  const arg = dec.expression.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Identifier names passed to `@UseGuards(...)`. */
function guardsFrom(decorators: readonly ts.Decorator[]): string[] {
  const guards: string[] = [];
  for (const dec of decorators) {
    if (decoratorName(dec) !== 'UseGuards') continue;
    if (!ts.isCallExpression(dec.expression)) continue;
    for (const arg of dec.expression.arguments) {
      if (ts.isIdentifier(arg)) guards.push(arg.text);
    }
  }
  return guards;
}

function hasDecorator(decorators: readonly ts.Decorator[], name: string): boolean {
  return decorators.some((dec) => decoratorName(dec) === name);
}

function joinRoute(prefix: string, suffix: string): string {
  const parts = [prefix, suffix].filter((p) => p.length > 0).map((p) => p.replace(/^\/+|\/+$/g, ''));
  return `/${parts.filter((p) => p.length > 0).join('/')}`;
}

/**
 * Tenant params in a route path that none of the applied guards can check.
 * Returns at most one param, since one finding per route is enough to act on.
 */
function uncoveredTenantParam(
  route: string,
  guards: readonly string[],
  coverage: GuardCoverage,
): string | null {
  const covered = new Set(guards.flatMap((g) => coverage[g] ?? []));
  for (const param of TENANT_PARAMS) {
    if (route.includes(`:${param}`) && !covered.has(param)) return param;
  }
  return null;
}

interface RouteInfo extends Omit<UnguardedRoute, 'tenantParam'> {
  classDecorators: readonly ts.Decorator[];
  memberDecorators: readonly ts.Decorator[];
}

/** Every authenticated route in the controller surface, with its decorators. */
function collectRoutes(srcDir: string): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const filePath of listControllerFiles(srcDir)) {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
    const relative = path.relative(srcDir, filePath).split(path.sep).join('/');

    const visitClass = (cls: ts.ClassDeclaration): void => {
      const classDecorators = decoratorsOf(cls);
      const controllerDec = classDecorators.find((d) => decoratorName(d) === 'Controller');
      if (!controllerDec) return;

      const prefix = decoratorStringArg(controllerDec) ?? '';
      const classGuards = guardsFrom(classDecorators);
      const controllerName = cls.name?.text ?? '(anonymous)';

      for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const memberDecorators = decoratorsOf(member);

        const methodDec = memberDecorators.find((d) => {
          const name = decoratorName(d);
          return name !== null && HTTP_METHOD_DECORATORS.has(name);
        });
        if (!methodDec) continue;

        // @Public() opts out of authentication entirely; those routes are
        // reviewed separately and never carry a tenant param they trust.
        if (hasDecorator(memberDecorators, 'Public')) continue;

        routes.push({
          file: relative,
          line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
          controller: controllerName,
          handler: member.name.getText(source),
          method: decoratorName(methodDec) ?? '?',
          route: joinRoute(prefix, decoratorStringArg(methodDec) ?? ''),
          guards: [...classGuards, ...guardsFrom(memberDecorators)],
          classDecorators,
          memberDecorators,
        });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) visitClass(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return routes.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}

export function findUnguardedRoutes(
  srcDir: string,
  options: AnalyzerOptions = {},
): UnguardedRoute[] {
  const coverage = options.guardCoverage ?? GUARD_COVERAGE;
  const internalOnly = options.internalOnlyDecorator ?? 'InternalOnly';
  const findings: UnguardedRoute[] = [];

  for (const { classDecorators, memberDecorators, ...r } of collectRoutes(srcDir)) {
    if (hasDecorator(memberDecorators, internalOnly) || hasDecorator(classDecorators, internalOnly)) {
      continue;
    }
    const tenantParam = uncoveredTenantParam(r.route, r.guards, coverage);
    if (tenantParam) findings.push({ ...r, tenantParam });
  }

  return findings;
}

// `All` is here because `@All()` serves POST/PUT/PATCH/DELETE too, so leaving it
// out would let a mutation in through a method this ratchet never looks at.
const MUTATING_METHODS = new Set(['Post', 'Put', 'Patch', 'Delete', 'All']);

export type RolelessRoute = Omit<UnguardedRoute, 'tenantParam'>;

/**
 * Mutating workspace routes without an ENFORCED `@RequiredRole`.
 * `WorkspaceGuard` proves membership, not seat: without a role gate any viewer
 * can call these. Reads stay open to every member by design, so only mutations
 * are reported. Two coverage rules that are easy to get half-right:
 *
 * - The decorator only counts together with a `RoleGuard` binding. RoleGuard
 *   is never an APP_GUARD, so `@RequiredRole` metadata nobody reads is an open
 *   route that reviews as gated — the fail-open half of the misconfiguration.
 *   (The mirror, RoleGuard without the decorator, fails closed at runtime and
 *   is reported here as a dead route.)
 * - `@SessionScoped()` mutations carry no `:workspaceId` — their tenant is the
 *   session workspace — but a viewer seat there writes all the same, so they
 *   are workspace mutations for this ratchet's purposes.
 */
export function findMutatingWorkspaceRoutesWithoutRole(
  srcDir: string,
  options: RoleAnalyzerOptions = {},
): RolelessRoute[] {
  const roleDecorator = options.requiredRoleDecorator ?? 'RequiredRole';

  return collectRoutes(srcDir)
    .filter((r) => {
      if (!MUTATING_METHODS.has(r.method)) return false;
      const workspaceScoped =
        r.route.includes(':workspaceId') ||
        hasDecorator(r.memberDecorators, 'SessionScoped') ||
        hasDecorator(r.classDecorators, 'SessionScoped');
      if (!workspaceScoped) return false;
      const declared =
        hasDecorator(r.memberDecorators, roleDecorator) ||
        hasDecorator(r.classDecorators, roleDecorator);
      return !(declared && r.guards.includes('RoleGuard'));
    })
    .map(({ classDecorators: _c, memberDecorators: _m, ...r }) => r);
}
