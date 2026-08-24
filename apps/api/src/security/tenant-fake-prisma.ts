/**
 * A minimal in-memory stand-in for PrismaClient used by the cross-tenant
 * authorization suite.
 *
 * Why this exists rather than plain `vi.fn()` stubs: a mock that returns a
 * canned row regardless of the `where` it was handed cannot tell a scoped query
 * from an unscoped one. Both shapes "pass". This fake actually *evaluates* the
 * `where` clause against a seeded two-workspace dataset, so a query that omits
 * `workspaceId` genuinely returns the other tenant's row and the assertion
 * genuinely fails. That is what makes these tests regression detectors instead
 * of restatements of the implementation.
 *
 * Supported subset of the Prisma query API (enough for the services under test):
 *   findFirst / findUnique / findMany / count
 *   update / updateMany / delete / deleteMany / create / upsert
 *   where operators: equality, `in`, `not`, `gt`, `lt`, `contains`,
 *                    `AND` / `OR`, and compound-unique keys such as
 *                    `workspaceId_phone: { workspaceId, phone }`.
 */

export type Row = Record<string, unknown>;

export interface RecordedCall {
  model: string;
  operation: string;
  where: Row | undefined;
}

const COMPOUND_KEY_SEPARATOR = '_';

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Returns true when `value` is an operator object like `{ in: [...] }`. */
function isOperatorObject(value: unknown): value is Row {
  if (!isPlainObject(value)) return false;
  const operators = ['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'contains', 'equals', 'startsWith'];
  return Object.keys(value).some((key) => operators.includes(key));
}

function matchesOperator(actual: unknown, operator: Row): boolean {
  for (const [op, expected] of Object.entries(operator)) {
    switch (op) {
      case 'equals':
        if (actual !== expected) return false;
        break;
      case 'not':
        if (isPlainObject(expected) ? matchesOperator(actual, expected) : actual === expected) return false;
        break;
      case 'in':
        if (!Array.isArray(expected) || !expected.includes(actual)) return false;
        break;
      case 'notIn':
        if (Array.isArray(expected) && expected.includes(actual)) return false;
        break;
      case 'gt':
        if (!(compare(actual, expected) > 0)) return false;
        break;
      case 'gte':
        if (!(compare(actual, expected) >= 0)) return false;
        break;
      case 'lt':
        if (!(compare(actual, expected) < 0)) return false;
        break;
      case 'lte':
        if (!(compare(actual, expected) <= 0)) return false;
        break;
      case 'contains':
        if (typeof actual !== 'string' || typeof expected !== 'string') return false;
        if (!actual.toLowerCase().includes(expected.toLowerCase())) return false;
        break;
      case 'startsWith':
        if (typeof actual !== 'string' || typeof expected !== 'string') return false;
        if (!actual.startsWith(expected)) return false;
        break;
      case 'mode':
        break; // case-insensitivity is already applied in `contains`
      default:
        throw new Error(`tenant-fake-prisma: unsupported where operator "${op}"`);
    }
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return 0;
}

/**
 * Evaluates a Prisma-style `where` object against a single row.
 * An empty or absent `where` matches everything - which is exactly how an
 * unscoped query behaves against a privileged connection, and exactly the
 * behavior these tests are designed to catch.
 */
export function matchesWhere(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (!isPlainObject(where)) return true;

  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;

    if (key === 'AND') {
      const clauses = Array.isArray(expected) ? expected : [expected];
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === 'OR') {
      const clauses = Array.isArray(expected) ? expected : [expected];
      if (clauses.length > 0 && !clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === 'NOT') {
      const clauses = Array.isArray(expected) ? expected : [expected];
      if (clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }

    // Compound unique selector, e.g. `workspaceId_phone: { workspaceId, phone }`.
    if (key.includes(COMPOUND_KEY_SEPARATOR) && isPlainObject(expected) && !(key in row)) {
      if (!matchesWhere(row, expected)) return false;
      continue;
    }

    const actual = row[key];
    if (isOperatorObject(expected)) {
      if (!matchesOperator(actual, expected)) return false;
      continue;
    }
    if (isPlainObject(expected)) {
      // Relation filter such as `agent: { workspaceId }` is not modelled;
      // treating it as a match keeps the fake honest about what it verifies
      // rather than silently passing a scope check it did not perform.
      throw new Error(
        `tenant-fake-prisma: relation filters are not supported (key "${key}"). ` +
          'Model the related row explicitly instead.',
      );
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): Row {
  const next: Row = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && 'increment' in value) {
      const current = typeof next[key] === 'number' ? (next[key] as number) : 0;
      next[key] = current + Number(value['increment']);
      continue;
    }
    next[key] = value;
  }
  return next;
}

export interface FakePrisma {
  /** Every Prisma call made during the test, in order. */
  calls: RecordedCall[];
  /** Direct access to the seeded tables, for post-hoc assertions. */
  tables: Map<string, Row[]>;
  rowsOf(model: string): Row[];
  [model: string]: unknown;
}

/**
 * Column defaults applied on `create`, standing in for Prisma/Postgres
 * `@default(now())` columns that the service layer reads back off the created
 * row. Without these the service would blow up on `undefined`, which would
 * obscure the tenant assertion the test is actually making.
 */
const CREATE_DEFAULTS: Record<string, () => unknown> = {
  createdAt: () => new Date(),
  updatedAt: () => new Date(),
  checkedAt: () => new Date(),
  consentedAt: () => new Date(),
  occurredAt: () => new Date(),
};

/**
 * Builds the fake from a seed of `{ modelName: rows }`.
 * Every model referenced by a test must be seeded (even with `[]`) so that a
 * typo in a model name fails loudly instead of silently returning `null`.
 */
export function createFakePrisma(seed: Record<string, Row[]>): FakePrisma {
  const tables = new Map<string, Row[]>();
  for (const [model, rows] of Object.entries(seed)) {
    tables.set(model, rows.map((row) => ({ ...row })));
  }

  const calls: RecordedCall[] = [];

  const tableFor = (model: string): Row[] => {
    const rows = tables.get(model);
    if (!rows) {
      throw new Error(
        `tenant-fake-prisma: model "${model}" was queried but not seeded. ` +
          'Add it to the seed (an empty array is fine) so the test covers it deliberately.',
      );
    }
    return rows;
  };

  const record = (model: string, operation: string, args: unknown): Row | undefined => {
    const where = isPlainObject(args) && isPlainObject(args['where']) ? (args['where'] as Row) : undefined;
    calls.push({ model, operation, where });
    return where;
  };

  const modelDelegate = (model: string) => ({
    findFirst: async (args?: Row) => {
      const where = record(model, 'findFirst', args);
      return tableFor(model).find((row) => matchesWhere(row, where)) ?? null;
    },
    findUnique: async (args?: Row) => {
      const where = record(model, 'findUnique', args);
      return tableFor(model).find((row) => matchesWhere(row, where)) ?? null;
    },
    findUniqueOrThrow: async (args?: Row) => {
      const where = record(model, 'findUniqueOrThrow', args);
      const found = tableFor(model).find((row) => matchesWhere(row, where));
      if (!found) throw new Error(`tenant-fake-prisma: no ${model} row matched`);
      return found;
    },
    findMany: async (args?: Row) => {
      const where = record(model, 'findMany', args);
      return tableFor(model).filter((row) => matchesWhere(row, where));
    },
    count: async (args?: Row) => {
      const where = record(model, 'count', args);
      return tableFor(model).filter((row) => matchesWhere(row, where)).length;
    },
    create: async (args?: Row) => {
      calls.push({ model, operation: 'create', where: undefined });
      const data = isPlainObject(args?.['data']) ? (args['data'] as Row) : {};
      const created: Row = { id: `${model}-${tableFor(model).length + 1}`, ...data };
      for (const [column, makeDefault] of Object.entries(CREATE_DEFAULTS)) {
        if (created[column] === undefined) created[column] = makeDefault();
      }
      tableFor(model).push(created);
      return created;
    },
    update: async (args?: Row) => {
      const where = record(model, 'update', args);
      const rows = tableFor(model);
      const index = rows.findIndex((row) => matchesWhere(row, where));
      if (index === -1) throw new Error(`tenant-fake-prisma: no ${model} row matched update`);
      const data = isPlainObject(args?.['data']) ? (args['data'] as Row) : {};
      const existing = rows[index];
      if (!existing) throw new Error(`tenant-fake-prisma: no ${model} row matched update`);
      const updated = applyData(existing, data);
      rows[index] = updated;
      return updated;
    },
    updateMany: async (args?: Row) => {
      const where = record(model, 'updateMany', args);
      const rows = tableFor(model);
      const data = isPlainObject(args?.['data']) ? (args['data'] as Row) : {};
      let count = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const existing = rows[i];
        if (existing && matchesWhere(existing, where)) {
          rows[i] = applyData(existing, data);
          count += 1;
        }
      }
      return { count };
    },
    delete: async (args?: Row) => {
      const where = record(model, 'delete', args);
      const rows = tableFor(model);
      const index = rows.findIndex((row) => matchesWhere(row, where));
      if (index === -1) throw new Error(`tenant-fake-prisma: no ${model} row matched delete`);
      const [removed] = rows.splice(index, 1);
      return removed;
    },
    deleteMany: async (args?: Row) => {
      const where = record(model, 'deleteMany', args);
      const rows = tableFor(model);
      const keep = rows.filter((row) => !matchesWhere(row, where));
      const count = rows.length - keep.length;
      tables.set(model, keep);
      return { count };
    },
    upsert: async (args?: Row) => {
      const where = record(model, 'upsert', args);
      const rows = tableFor(model);
      const index = rows.findIndex((row) => matchesWhere(row, where));
      if (index >= 0) {
        const existing = rows[index];
        if (!existing) throw new Error(`tenant-fake-prisma: no ${model} row matched upsert`);
        const update = isPlainObject(args?.['update']) ? (args['update'] as Row) : {};
        const updated = applyData(existing, update);
        rows[index] = updated;
        return updated;
      }
      const create = isPlainObject(args?.['create']) ? (args['create'] as Row) : {};
      const created: Row = { id: `${model}-${rows.length + 1}`, ...create };
      rows.push(created);
      return created;
    },
  });

  const fake: Record<string, unknown> = {
    calls,
    tables,
    rowsOf: (model: string) => tableFor(model),
    $transaction: async (operations: unknown) => {
      if (Array.isArray(operations)) return Promise.all(operations);
      if (typeof operations === 'function') {
        return (operations as (tx: unknown) => unknown)(fake);
      }
      return undefined;
    },
  };

  for (const model of tables.keys()) {
    fake[model] = modelDelegate(model);
  }

  return fake as FakePrisma;
}
