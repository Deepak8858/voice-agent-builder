-- Prisma's @default(uuid()) and @updatedAt are client-side: the Prisma client
-- fills them in, the columns themselves have no database default. Any writer
-- that is not the Prisma client therefore hits NOT NULL violations — the web
-- onboarding route inserts organizations/workspaces/memberships through the
-- Supabase admin client (PostgREST), and the first real Google signup failed
-- with `null value in column "id" of relation "organizations"`. users already
-- carries these defaults from the Supabase-auth migration era; this brings the
-- other three tables the onboarding route writes to in line.
--
-- Prisma behavior is unchanged: it still supplies id/updated_at explicitly,
-- and the defaults only apply when a writer omits the column.
-- (Applied to production by hand on 2026-09-01 to unblock onboarding; every
-- statement is safe to re-run.)
ALTER TABLE "organizations" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "workspaces" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "memberships" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "organizations" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "workspaces" ALTER COLUMN "updated_at" SET DEFAULT now();
