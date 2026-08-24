import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Static detector for Prisma queries on workspace/organization-scoped models
 * that carry no tenant predicate.
 *
 * The runtime cross-tenant suite proves specific services are safe. It cannot
 * prove anything about a service written next week. This analyzer covers the
 * complement: it walks every non-test file under `src/` and reports each query
 * on a tenant-scoped model whose `where` clause has no tenant predicate and is
 * not otherwise guarded. The accompanying test pins the result against a
 * reviewed baseline, so adding a new unscoped query fails CI.
 */

export interface UnscopedQuery {
  file: string;
  line: number;
  model: string;
  operation: string;
  /** Name of the enclosing function/method, for readability in failures. */
  fn: string;
  /** True when the enclosing function already has a tenant id in scope. */
  tenantIdInScope: boolean;
}

const QUERY_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'count',
  'aggregate',
  'groupBy',
]);

const TENANT_PREDICATE =
  /workspaceId|workspace_id|organizationId|organization_id|\bworkspace\s*:|\borganization\s*:/;

/**
 * Reads the Prisma schema and returns the set of models that carry a tenant
 * column, keyed by the camelCase name used on the Prisma client. Derived from
 * the schema rather than hardcoded so that a new tenant-scoped model is picked
 * up automatically.
 */
export function tenantScopedModels(schemaPath: string): Set<string> {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const models = new Set<string>();
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelBlock.exec(schema)) !== null) {
    const name = match[1];
    const body = match[2];
    if (!name || !body) continue;
    const hasTenantColumn = /^\s*workspaceId\s/m.test(body) || /^\s*organizationId\s/m.test(body);
    if (!hasTenantColumn) continue;
    models.add(name.charAt(0).toLowerCase() + name.slice(1));
  }
  return models;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Nearest enclosing method or function declaration. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  let fallback: ts.SignatureDeclaration | null = null;
  while (current) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current)) && !fallback) {
      fallback = current;
    }
    current = current.parent;
  }
  return fallback;
}

interface CallSite {
  model: string;
  operation: string;
  line: number;
  pos: number;
  whereText: string;
  scoped: boolean;
  boundTo: string | null;
  referencedNames: Set<string>;
  fnKey: string;
  fnName: string;
  tenantIdInScope: boolean;
}

/**
 * Scans one source file. A call site is reported only when all of the
 * following hold, which keeps the signal high enough to be worth pinning:
 *  - the model carries a tenant column
 *  - the literal `where` has no tenant predicate, even after substituting the
 *    initializers of local variables it references
 *  - no earlier query in the same function on the same model was tenant-scoped
 *    (the common "scoped findFirst, then update by id" pattern)
 *  - the `where` does not consume a value produced by an earlier scoped query
 */
function analyzeFile(filePath: string, relativeTo: string, models: Set<string>): UnscopedQuery[] {
  const text = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const relative = path.relative(relativeTo, filePath).split(path.sep).join('/');

  // Local variable initializers, used to see through `const where = {...}`.
  const initializers = new Map<string, { pos: number; text: string }[]>();
  const collectInitializers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = initializers.get(node.name.text) ?? [];
      list.push({ pos: node.getStart(source), text: node.initializer.getText(source) });
      initializers.set(node.name.text, list);
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(source);

  const expand = (whereText: string, atPos: number): string => {
    let expanded = whereText;
    for (let depth = 0; depth < 2; depth += 1) {
      expanded = expanded.replace(/\b([A-Za-z_$][\w$]*)\b/g, (name) => {
        const declarations = initializers.get(name);
        if (!declarations) return name;
        const visible = declarations.filter((d) => d.pos < atPos);
        const chosen = visible.length > 0 ? visible[visible.length - 1] : declarations[0];
        return chosen ? `${name} /*${chosen.text}*/` : name;
      });
    }
    return expanded;
  };

  const callSites: CallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const operation = node.expression.name.text;
      const receiver = node.expression.expression;
      if (QUERY_OPERATIONS.has(operation) && ts.isPropertyAccessExpression(receiver)) {
        const model = receiver.name.text;
        if (models.has(model)) {
          const arg = node.arguments[0];
          let whereText = '';
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop) && prop.name.getText(source) === 'where') {
                whereText = prop.initializer.getText(source);
              }
            }
          } else if (arg) {
            whereText = arg.getText(source);
          }

          const pos = node.getStart(source);
          const fn = enclosingFunction(node);
          const params = fn?.parameters?.map((p) => p.name.getText(source)) ?? [];

          let boundTo: string | null = null;
          let parent: ts.Node | undefined = node.parent;
          while (
            parent &&
            (ts.isAwaitExpression(parent) ||
              ts.isParenthesizedExpression(parent) ||
              ts.isPropertyAccessExpression(parent))
          ) {
            parent = parent.parent;
          }
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            boundTo = parent.name.text;
          }

          callSites.push({
            model,
            operation,
            line: source.getLineAndCharacterOfPosition(pos).line + 1,
            pos,
            whereText,
            scoped: TENANT_PREDICATE.test(expand(whereText, pos)),
            boundTo,
            referencedNames: new Set(whereText.match(/\b([A-Za-z_$][\w$]*)\b/g) ?? []),
            fnKey: fn ? String(fn.getStart(source)) : 'module',
            fnName: fn && 'name' in fn && fn.name ? fn.name.getText(source) : '(anonymous)',
            tenantIdInScope: params.some((p) => /workspaceId|organizationId/.test(p)),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const byFunction = new Map<string, CallSite[]>();
  for (const site of callSites) {
    const list = byFunction.get(site.fnKey) ?? [];
    list.push(site);
    byFunction.set(site.fnKey, list);
  }

  const findings: UnscopedQuery[] = [];
  for (const site of callSites) {
    if (site.scoped) continue;
    const siblings = byFunction.get(site.fnKey) ?? [];
    const guarded = siblings.some(
      (other) =>
        other.scoped &&
        other.pos < site.pos &&
        (other.model === site.model ||
          (other.boundTo !== null && site.referencedNames.has(other.boundTo))),
    );
    if (guarded) continue;
    findings.push({
      file: relative,
      line: site.line,
      model: site.model,
      operation: site.operation,
      fn: site.fnName,
      tenantIdInScope: site.tenantIdInScope,
    });
  }
  return findings;
}

/** Runs the analysis across `srcDir`, sorted for stable comparison. */
export function findUnscopedQueries(srcDir: string, schemaPath: string): UnscopedQuery[] {
  const models = tenantScopedModels(schemaPath);
  const findings: UnscopedQuery[] = [];
  for (const file of listSourceFiles(srcDir)) {
    findings.push(...analyzeFile(file, srcDir, models));
  }
  return findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Stable `file:line model.operation` key used by the baseline. */
export function queryKey(q: UnscopedQuery): string {
  return `${q.file}:${q.model}.${q.operation}`;
}
