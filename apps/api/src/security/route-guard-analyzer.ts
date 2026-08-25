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
 *   - `PATCH v1/workspaces/me/retention` and three referral routes carried
 *     `WorkspaceGuard` on a path it could not check, so the decoration hid
 *     whether a check was intended.
 *
 * This analyzer reports every route whose effective path contains a recognised
 * tenant param but whose guards cannot check that param. `WorkspaceGuard`
 * counts only for `:workspaceId`, `OrganizationGuard` only for `:orgId`, and
 * `InternalAuthGuard` counts for either because it restricts the route to the
 * platform operator rather than a tenant user.
 */

export type GuardCoverage = Record<string, readonly string[]>;

/** Guards that authorize a caller against a specific tenant param. */
export const GUARD_COVERAGE: GuardCoverage = {
  WorkspaceGuard: ['workspaceId'],
  OrganizationGuard: ['orgId'],
  // Restricts the route to the internal admin key, so no tenant param is
  // reachable by a tenant user.
  InternalAuthGuard: ['workspaceId', 'orgId'],
};

export interface AnalyzerOptions {
  /**
   * Overrides which guards count as covering which params. Exists so the
   * accompanying test can shrink coverage and confirm the analyzer still
   * reports the routes it should — an analyzer that silently parsed nothing
   * would otherwise look identical to a clean tree.
   */
  guardCoverage?: GuardCoverage;
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
export function routeKey(r: UnguardedRoute): string {
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

export function findUnguardedRoutes(
  srcDir: string,
  options: AnalyzerOptions = {},
): UnguardedRoute[] {
  const coverage = options.guardCoverage ?? GUARD_COVERAGE;
  const findings: UnguardedRoute[] = [];

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

        const route = joinRoute(prefix, decoratorStringArg(methodDec) ?? '');
        const guards = [...classGuards, ...guardsFrom(memberDecorators)];
        const tenantParam = uncoveredTenantParam(route, guards, coverage);
        if (!tenantParam) continue;

        findings.push({
          file: relative,
          line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
          controller: controllerName,
          handler: member.name.getText(source),
          method: decoratorName(methodDec) ?? '?',
          route,
          tenantParam,
          guards,
        });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) visitClass(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return findings.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}
