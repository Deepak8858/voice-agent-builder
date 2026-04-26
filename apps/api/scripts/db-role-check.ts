import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const me = await prisma.$queryRaw<Array<{ current_user: string; session_user: string }>>`
    SELECT current_user, session_user
  `;
  console.log('[db-role-check] connection:', me[0]);

  const role = await prisma.$queryRaw<
    Array<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean }>
  >`
    SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
    FROM pg_roles
    WHERE rolname = current_user
  `;
  console.log('[db-role-check] role attributes:', role[0]);

  const memberships = await prisma.$queryRaw<Array<{ role: string }>>`
    SELECT b.rolname AS role
    FROM pg_auth_members m
    JOIN pg_roles a ON a.oid = m.member
    JOIN pg_roles b ON b.oid = m.roleid
    WHERE a.rolname = current_user
  `;
  console.log('[db-role-check] member of:', memberships.map((m) => m.role));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[db-role-check] error:', err);
  process.exit(1);
});
