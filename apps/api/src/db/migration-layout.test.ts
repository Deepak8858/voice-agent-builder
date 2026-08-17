import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_PUBLIC_TABLES } from './public-table-exposure-policy';

const repoRoot = path.resolve(__dirname, '../../../..');
const migrationsDir = path.join(repoRoot, 'apps/api/prisma/migrations');

/**
 * Bare `<name>.sql` files at the migrations root are NEVER executed by
 * `prisma migrate deploy`: Prisma only applies `<name>/migration.sql`
 * directories. These files predate that discovery and were applied by hand;
 * they are frozen here so a new migration cannot be added in the broken layout
 * and silently skip production (which is exactly how agent_gen_sessions went
 * missing and made the whole feature fail with "Unexpected server error").
 */
const KNOWN_UNAPPLIED_LEGACY_SQL_FILES = [
  '0031_voiceforge_agent_gen.sql',
  '0032_enable_rls_on_new_tables.sql',
  '0033_phase2_indexes.sql',
  '0034_phase2_materialized_views.sql',
  '0035_phase2_partitions.sql',
  '0036_subscription_stripe_price_id.sql',
  '0037_drop_legacy_clerk_columns.sql',
];

function readSchema(): string {
  return fs.readFileSync(path.join(repoRoot, 'apps/api/prisma/schema.prisma'), 'utf8');
}

/**
 * A model without `@@map` is backed by a table named after the model, so the
 * table name has to be derived from the model name in that case. Matching only
 * `@@map` would let an unmapped model slip past the coverage assertion below.
 */
function schemaTableNames(): string[] {
  const schema = readSchema();
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((model) => {
    const [, modelName, body] = model;
    return /@@map\("([^"]+)"\)/.exec(body!)?.[1] ?? modelName!;
  });
}

function migrationSql(): string {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, 'migration.sql'))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

describe('prisma migration layout', () => {
  it('adds no new bare .sql migrations, which prisma migrate deploy would skip', () => {
    const bareSqlFiles = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();

    expect(bareSqlFiles).toEqual([...KNOWN_UNAPPLIED_LEGACY_SQL_FILES].sort());
  });

  it('creates agent_gen_sessions in an applied migration directory', () => {
    const sql = migrationSql();

    expect(sql).toMatch(/create table (if not exists )?"?agent_gen_sessions"?/i);
    expect(sql).toMatch(
      /alter table "?(public\.)?agent_gen_sessions"? enable row level security/i,
    );
  });
});

describe('Data API exposure policy coverage', () => {
  it('classifies every table backing a model in the Prisma schema', () => {
    const known = new Set<string>(EXPECTED_PUBLIC_TABLES);
    const unclassified = schemaTableNames().filter((table) => !known.has(table));

    expect(unclassified).toEqual([]);
  });
});

