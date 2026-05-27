import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readSupabaseMigrations(): string {
  const migrationsDir = path.join(repoRoot, 'supabase/migrations');
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    .join('\n');
}

describe('audit_reports RLS coverage', () => {
  it('keeps the signed audit report table in the RLS enforcement and verification paths', () => {
    const prismaSchema = readRepoFile('apps/api/prisma/schema.prisma');
    const enableRlsScript = readRepoFile('apps/api/scripts/db-enable-rls.ts');
    const verifyScript = readRepoFile('apps/api/scripts/db-verify.ts');
    const supabasePolicies = readSupabaseMigrations();

    expect(prismaSchema).toContain('@@map("audit_reports")');
    expect(enableRlsScript).toContain("'audit_reports'");
    expect(verifyScript).toContain("'audit_reports'");
    expect(verifyScript).toContain('if (rlsOff.length)');
    expect(supabasePolicies.toLowerCase()).toMatch(
      /alter table (if exists )?public\.audit_reports enable row level security/,
    );
    expect(supabasePolicies).toContain('audit_reports_service_role_all');
  });
});
