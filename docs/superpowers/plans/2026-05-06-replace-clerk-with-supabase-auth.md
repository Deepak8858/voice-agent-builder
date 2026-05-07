# Replace Clerk with Supabase Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clerk authentication with Supabase Auth across the entire monorepo. Remove @clerk/backend, update API auth to verify Supabase JWTs, update Prisma schema fields from `clerk*` to `supabase*`, and wire native Supabase auth on the web side.

**Architecture:** Supabase GoTrue handles sign-up/sign-in. The API verifies Supabase JWTs from the `Authorization: Bearer` header. User/organization provisioning uses Supabase webhook events (`user.created`, `user.updated`, `organization_membership.created`) via the GoTrue webhook endpoint. All `clerkOrgId`/`clerkUserId` fields renamed to `supabaseOrgId`/`supabaseUserId`.

**Tech Stack:** NestJS API, Next.js 14 web, Prisma/Postgres, Supabase Auth (GoTrue), RLS on Supabase side.

---

## File Map

| File | Action |
|------|--------|
| `apps/api/src/auth/supabase-auth.service.ts` | Create — replaces `clerk-auth.service.ts` |
| `apps/api/src/auth/supabase-webhook.controller.ts` | Create — replaces `clerk-webhook.controller.ts` |
| `apps/api/src/auth/auth.module.ts` | Modify — remove Clerk imports, wire Supabase |
| `apps/api/src/auth/user-provisioning.service.ts` | Modify — `clerkUserId` → `supabaseUserId` |
| `apps/api/src/auth/workspace-provisioning.service.ts` | Modify — `clerkOrgId` → `supabaseOrgId`, rename `orgSlug()` |
| `apps/api/src/auth/clerk-auth.service.ts` | Delete |
| `apps/api/src/auth/clerk-webhook.controller.ts` | Delete |
| `apps/api/src/config/env.ts` | Modify — `AUTH_PROVIDER: 'clerk'` → `'supabase'`, replace Clerk env vars with Supabase JWT secret |
| `apps/api/package.json` | Modify — remove `@clerk/backend`, add `@supabase/supabase-js` |
| `apps/api/prisma/schema.prisma` | Modify — `clerkOrgId` → `supabaseOrgId`, `clerkUserId` → `supabaseUserId` in AppOrgMembership and WorkspaceMembership |
| `apps/api/prisma/migrations/` | Create — migration to rename columns and drop Clerk-specific constraints |
| `apps/web/lib/supabase/server.ts` | Modify — remove Clerk `auth()` import, use `createServerClient` |
| `apps/web/lib/supabase/client.ts` | Modify — remove Clerk `useSession()`, use `useSupabaseClient()` with anon key |
| `.env.example` | Modify — remove CLERK_* vars, add `SUPABASE_JWT_SECRET` |
| `apps/web/next.config.ts` | Modify — remove Clerk Next.js plugin if present |
| `apps/web/.gitignore` | Check — ensure no Clerk artifacts |

---

## Task 1: Prisma Schema — Rename Clerk Fields

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `supabase/migrations/005_rename_clerk_to_supabase.sql`

- [ ] **Step 1: Update schema.prisma — AppOrgMembership**

Rename fields and indexes. Search for `clerkOrgId` and `clerkUserId` in AppOrgMembership and WorkspaceMembership.

```prisma
// AppOrgMembership — before:
clerkUserId    String    @map("clerk_user_id")
clerkOrgId     String    @map("clerk_org_id")

// After:
supabaseUserId String    @map("supabase_user_id")
supabaseOrgId  String    @map("supabase_org_id")
```

Update indexes: `@@index([clerkUserId])` → `@@index([supabaseUserId])`, `@@index([clerkOrgId])` → `@@index([supabaseOrgId])`.

Add index on `supabaseUserId` if not present.

- [ ] **Step 2: Update schema.prisma — WorkspaceMembership**

```prisma
// WorkspaceMembership — before:
clerkUserId    String    @map("clerk_user_id")

// After:
supabaseUserId String    @map("supabase_user_id")
```

Update index: `@@index([clerkUserId])` → `@@index([supabaseUserId])`.

- [ ] **Step 3: Update schema.prisma — Organization**

Remove `clerkOrgId` field entirely. Add `supabaseOrgId` if the migration will handle renaming:

```prisma
// Organization — before:
clerkOrgId    String?  @unique @map("clerk_org_id")

// After: (drop entirely, replaced by slug-based lookup or supabaseOrgId in AppOrgMembership)
// No direct clerkOrgId needed on Organization — join via AppOrgMembership.supabaseOrgId
```

- [ ] **Step 4: Write migration SQL**

```sql
-- supabase/migrations/005_rename_clerk_to_supabase.sql

-- Rename clerk_user_id → supabase_user_id in app_org_memberships
ALTER TABLE app_org_memberships
  RENAME COLUMN clerk_user_id TO supabase_user_id;
ALTER TABLE app_org_memberships
  RENAME COLUMN clerk_org_id TO supabase_org_id;

-- Rename clerk_user_id → supabase_user_id in workspace_memberships
ALTER TABLE workspace_memberships
  RENAME COLUMN clerk_user_id TO supabase_user_id;

-- Rename clerk_org_id → supabase_org_id in organizations
ALTER TABLE organizations
  RENAME COLUMN clerk_org_id TO supabase_org_id;

-- Rebuild indexes
DROP INDEX IF EXISTS app_org_memberships_clerk_user_id_idx;
CREATE INDEX app_org_memberships_supabase_user_id_idx ON app_org_memberships(supabase_user_id);

DROP INDEX IF EXISTS app_org_memberships_clerk_org_id_idx;
CREATE INDEX app_org_memberships_supabase_org_id_idx ON app_org_memberships(supabase_org_id);

DROP INDEX IF EXISTS workspace_memberships_clerk_user_id_idx;
CREATE INDEX workspace_memberships_supabase_user_id_idx ON workspace_memberships(supabase_user_id);

DROP INDEX IF EXISTS organizations_clerk_org_id_idx;
CREATE INDEX organizations_supabase_org_id_idx ON organizations(supabase_org_id);
```

- [ ] **Step 5: Run migration**

Run: `cd apps/api && npx prisma migrate dev --name 005_rename_clerk_to_supabase`
Expected: Migration applies, new fields match schema.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma supabase/migrations/005_rename_clerk_to_supabase.sql
git commit -m "refactor(schema): rename clerk fields to supabase (clerkOrgId → supabaseOrgId)"
```

---

## Task 2: env.ts — Replace Clerk Env Vars with Supabase

**Files:**
- Modify: `apps/api/src/config/env.ts:20` and `apps/api/src/config/env.ts:38-40`

- [ ] **Step 1: Change AUTH_PROVIDER enum**

```typescript
// Before:
AUTH_PROVIDER: z.enum(['clerk']).default('clerk'),

// After:
AUTH_PROVIDER: z.enum(['supabase']).default('supabase'),
```

- [ ] **Step 2: Replace Clerk env vars with Supabase JWT secret**

```typescript
// Remove:
CLERK_SECRET_KEY: z.string().optional(),
CLERK_PUBLISHABLE_KEY: z.string().optional(),
CLERK_WEBHOOK_SECRET: z.string().optional(),

// Add:
SUPABASE_JWT_SECRET: z.string().min(1, 'SUPABASE_JWT_SECRET is required'),
SUPABASE_URL: z.string().url(),
SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),  // server-only, for webhook verification
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config/env.ts
git commit -m "refactor(config): replace CLERK_* env vars with SUPABASE_* vars"
```

---

## Task 3: package.json — Remove @clerk/backend, Add @supabase/supabase-js

**Files:**
- Modify: `apps/api/package.json:19`

- [ ] **Step 1: Remove @clerk/backend from dependencies**

```json
// Remove this line:
"@clerk/backend": "^1.21.0",

// Add this (if not already present):
"@supabase/supabase-js": "^2.47.0",
```

Also remove `svix` if it's only used for Clerk webhook verification — verify first with `grep "svix" apps/api/src/auth/clerk-webhook.controller.ts` (it's only used there).

If svix is not used elsewhere, remove `"svix": "^1.92.2"` from package.json as well.

- [ ] **Step 2: Run npm install**

Run: `cd apps/api && npm install`
Expected: `@clerk/backend` removed, `@supabase/supabase-js` installed.

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json
git commit -m "refactor(deps): remove @clerk/backend, add @supabase/supabase-js"
```

---

## Task 4: auth.module.ts — Wire Supabase Instead of Clerk

**Files:**
- Modify: `apps/api/src/auth/auth.module.ts`

- [ ] **Step 1: Replace imports and wiring**

```typescript
// Before:
import { ClerkWebhookController } from './clerk-webhook.controller';
import { ClerkAuthService } from './clerk-auth.service';
// ...
controllers: [AuthController, ClerkWebhookController, MeController],
providers: [
  ClerkAuthService,
  { provide: AuthService, useExisting: ClerkAuthService },
  { provide: 'AUTH_SERVICE', useExisting: ClerkAuthService },
],
exports: [ClerkAuthService, AuthService, 'AUTH_SERVICE', ...],

// After:
import { SupabaseWebhookController } from './supabase-webhook.controller';
import { SupabaseAuthService } from './supabase-auth.service';
// ...
controllers: [AuthController, SupabaseWebhookController, MeController],
providers: [
  SupabaseAuthService,
  { provide: AuthService, useExisting: SupabaseAuthService },
  { provide: 'AUTH_SERVICE', useExisting: SupabaseAuthService },
],
exports: [SupabaseAuthService, AuthService, 'AUTH_SERVICE', ...],
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/auth/auth.module.ts
git commit -m "refactor(auth): wire SupabaseAuthService instead of ClerkAuthService"
```

---

## Task 5: Create SupabaseAuthService

**Files:**
- Create: `apps/api/src/auth/supabase-auth.service.ts`

- [ ] **Step 1: Write SupabaseAuthService**

Replaces `clerk-auth.service.ts`. Verify Supabase JWT using `SUPABASE_JWT_SECRET`. Build `SessionUser` from the decoded JWT claims. Cache session data.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError } from '../common/errors';
import { AuthService, type LoginInput, type SignupInput } from './auth.service';
import { CacheService } from '../cache/cache.service';
import { UserProvisioningService } from './user-provisioning.service';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';
import jwt from 'jsonwebtoken';

const SESSION_USER_TTL = 300;
const SESSION_WORKSPACE_TTL = 300;

@Injectable()
export class SupabaseAuthService extends AuthService {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly supabase: SupabaseClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly userProvisioning: UserProvisioningService,
    private readonly workspaceProvisioning: WorkspaceProvisioningService,
  ) {
    super();
    this.supabase = (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
  }

  async signup(_input: SignupInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-up happens via Supabase. Use the Sign-up page in the app.',
    );
  }

  async login(_input: LoginInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-in happens via Supabase. Use the Sign-in page in the app.',
    );
  }

  async logout(req: Request, _res: Response): Promise<void> {
    // Supabase handles token invalidation via JWT expiration.
    // Optional: call supabase.auth.signOut() via the client's refresh token.
    void req;
  }

  async getSessionUser(req: Request): Promise<SessionUser | null> {
    if (!env.SUPABASE_JWT_SECRET) return null;
    const token = this.extractBearerToken(req);
    if (!token) return null;

    let claims: SupabaseJWTPayload;
    try {
      claims = jwt.verify(token, env.SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
      }) as SupabaseJWTPayload;
    } catch (err) {
      this.logger.debug(`[supabase] token verify failed: ${(err as Error).message}`);
      return null;
    }

    const supabaseUserId = claims.sub;
    if (!supabaseUserId) return null;

    const userKey = `session:user:${supabaseUserId}`;
    const cached = await this.cache.get<SessionUser>(userKey);
    if (cached) {
      req.res?.setHeader('X-Cache-Hit', 'true');
      return cached;
    }
    req.res?.setHeader('X-Cache-Hit', 'false');

    try {
      const sessionUser = await this.buildSessionUser(supabaseUserId, claims);
      if (sessionUser) {
        await this.cache.set(userKey, sessionUser, SESSION_USER_TTL);
      }
      return sessionUser;
    } catch (err) {
      this.logger.warn(`[supabase] session build failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async buildSessionUser(
    supabaseUserId: string,
    claims: SupabaseJWTPayload,
  ): Promise<SessionUser | null> {
    const externalAuthId = supabaseUserId;
    const user = await this.findOrProvisionUser(externalAuthId, supabaseUserId, claims);

    const workspaceKey = `session:workspace:${user.id}`;
    const cachedWorkspace = await this.cache.get<SessionUser>(workspaceKey);
    if (cachedWorkspace) return cachedWorkspace;

    // Supabase doesn't have org concept — use first membership or provision personal workspace
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    const activeMembership = membership
      ?? await this.provisionPersonalWorkspace(user.id, supabaseUserId);

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      active_workspace_id: activeMembership.workspace.id,
      active_workspace_name: activeMembership.workspace.name,
      active_workspace_role: activeMembership.role as SessionUser['active_workspace_role'],
    };

    await this.cache.set(workspaceKey, sessionUser, SESSION_WORKSPACE_TTL);
    return sessionUser;
  }

  private async findOrProvisionUser(
    externalAuthId: string,
    supabaseUserId: string,
    claims: SupabaseJWTPayload,
  ) {
    const existing = await this.prisma.user.findUnique({ where: { externalAuthId } });
    if (existing) return existing;

    const email = claims.email ?? `${supabaseUserId}@supabase.invalid`;
    const name = claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null;

    // Check if user already exists by email (webhook may have created it first)
    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (!byEmail.externalAuthId || byEmail.externalAuthId === externalAuthId) {
        const user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: { externalAuthId, name },
        });
        await this.provisionPersonalWorkspace(user.id, supabaseUserId);
        return user;
      }
      return byEmail;
    }

    try {
      const user = await this.prisma.user.upsert({
        where: { externalAuthId },
        create: { externalAuthId, email, name },
        update: { email, name },
      });
      await this.provisionPersonalWorkspace(user.id, supabaseUserId);
      return user;
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        const raced = await this.prisma.user.findUnique({ where: { externalAuthId } })
          ?? await this.prisma.user.findUnique({ where: { email } });
        if (raced) {
          if (!raced.externalAuthId || raced.externalAuthId === externalAuthId) {
            const updated = await this.prisma.user.update({
              where: { id: raced.id },
              data: { externalAuthId, name: name ?? raced.name },
            });
            await this.provisionPersonalWorkspace(updated.id, supabaseUserId);
            return updated;
          }
          await this.provisionPersonalWorkspace(raced.id, supabaseUserId);
          return raced;
        }
      }
      throw err;
    }
  }

  private async provisionPersonalWorkspace(userId: string, supabaseUserId: string) {
    const orgSlug = `user-${supabaseUserId.slice(0, 8)}`;
    const organization = await this.prisma.organization.upsert({
      where: { slug: orgSlug },
      create: {
        slug: orgSlug,
        name: 'Personal',
        ownerUserId: userId,
        supabaseOrgId: null,
      },
      update: {},
    });

    let workspace = await this.prisma.workspace.findFirst({
      where: { organizationId: organization.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!workspace) {
      workspace = await this.prisma.workspace.create({
        data: {
          organizationId: organization.id,
          name: 'Demo Workspace',
          slug: 'demo',
          type: 'direct',
        },
      });
    }

    return this.prisma.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      create: { userId, workspaceId: workspace.id, role: 'owner' },
      update: {},
      include: { workspace: true },
    });
  }

  private extractBearerToken(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}

interface SupabaseJWTPayload {
  sub: string;
  email?: string;
  aud: string;
  role?: string;
  exp: number;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
  };
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
}
```

Also add `jwt` dependency: `npm install jsonwebtoken && npm install -D @types/jsonwebtoken`

- [ ] **Step 2: Run typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/auth/supabase-auth.service.ts apps/api/package.json
git commit -m "feat(auth): add SupabaseAuthService for JWT verification"
```

---

## Task 6: Create SupabaseWebhookController

**Files:**
- Create: `apps/api/src/auth/supabase-webhook.controller.ts`

- [ ] **Step 1: Write SupabaseWebhookController**

Listens on `POST /webhooks/supabase`. Receives GoTrue events. Handles `user.created`, `user.updated`, `user.deleted`. Syncs to local User table.

Supabase sends webhooks via the `pg-logical-replication` extension or GoTrue's built-in webhook system. Events come as JSON with `type` and `record` fields.

```typescript
import { BadRequestException, Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

interface SupabaseUserRecord {
  id: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
  };
  email_confirmed_at?: string | null;
  banned_at?: string | null;
}

interface SupabaseWebhookEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record?: SupabaseUserRecord;
  old_record?: SupabaseUserRecord;
  schema: string;
}

@Controller('webhooks/supabase')
export class SupabaseWebhookController {
  private readonly logger = new Logger(SupabaseWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  @Post()
  @HttpCode(204)
  async receive(@Req() req: Request): Promise<void> {
    const payload = req.body as SupabaseWebhookEvent | SupabaseWebhookEvent[];

    if (Array.isArray(payload)) {
      await Promise.allSettled(payload.map((event) => this.handleEvent(event)));
      return;
    }

    await this.handleEvent(payload);
  }

  private async handleEvent(event: SupabaseWebhookEvent): Promise<void> {
    if (event.table !== 'users' || !['INSERT', 'UPDATE', 'DELETE'].includes(event.type)) {
      this.logger.debug(`Ignoring supabase event: ${event.table}.${event.type}`);
      return;
    }

    if (event.type === 'DELETE') {
      await this.handleDelete(event.old_record as SupabaseUserRecord);
      return;
    }

    await this.handleUpsert(event.record as SupabaseUserRecord);
  }

  private async handleUpsert(record: SupabaseUserRecord): Promise<void> {
    if (!record.id) return;

    const externalAuthId = record.id;
    const email = record.email ?? `${record.id}@supabase.invalid`;
    const name = record.user_metadata?.full_name ?? record.user_metadata?.name ?? null;

    try {
      await this.prisma.user.upsert({
        where: { externalAuthId },
        create: { externalAuthId, email, name },
        update: { email, name },
      });
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        const raced = await this.prisma.user.findUnique({ where: { email } });
        if (raced) {
          await this.prisma.user.update({
            where: { id: raced.id },
            data: { externalAuthId, name },
          });
        }
      } else {
        throw err;
      }
    }

    await this.cache.del(`session:user:${externalAuthId}`);
  }

  private async handleDelete(record: SupabaseUserRecord): Promise<void> {
    if (!record.id) return;
    const user = await this.prisma.user.findUnique({ where: { externalAuthId: record.id } });
    if (!user) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { email: `deleted-${user.id}@voiceforge.local`, name: 'Deleted User', externalAuthId: null },
    });
    await this.cache.del(`session:user:${record.id}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/auth/supabase-webhook.controller.ts
git commit -m "feat(auth): add SupabaseWebhookController for user sync"
```

---

## Task 7: Update Provisioning Services

**Files:**
- Modify: `apps/api/src/auth/user-provisioning.service.ts`
- Modify: `apps/api/src/auth/workspace-provisioning.service.ts`

- [ ] **Step 1: Update user-provisioning.service.ts**

Check all usages of `clerkUserId`. Update field names and doc comments. The service should reference `externalAuthId` (which is now the Supabase user ID) rather than a separate `clerkUserId`.

Run: `grep -n "clerkUserId" apps/api/src/auth/user-provisioning.service.ts` to find exact lines.

```typescript
// In user-provisioning.service.ts, replace all references:
// clerkUserId → supabaseUserId or externalAuthId (the User.externalAuthId is the supabase ID)
```

- [ ] **Step 2: Update workspace-provisioning.service.ts**

Check all usages of `clerkOrgId`. Replace with `supabaseOrgId` or derive from organization slug.

Run: `grep -n "clerkOrgId\|clerk-" apps/api/src/auth/workspace-provisioning.service.ts`

Key changes:
- `orgSlug(clerkOrgId)` → `orgSlug(supabaseOrgId)` — derive slug from supabase org ID or user ID
- `resolveOrgName(clerkOrgId, ...)` → remove entirely (Supabase doesn't have org name in JWT, use fallback)

```typescript
// Replace orgSlug method:
orgSlug(supabaseId: string): string {
  return `org-${supabaseId.slice(0, 8)}`;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/auth/user-provisioning.service.ts apps/api/src/auth/workspace-provisioning.service.ts
git commit -m "refactor(auth): replace clerkOrgId/clerkUserId refs with supabase equivalents"
```

---

## Task 8: Update Web Supabase Clients — Remove Clerk Dependency

**Files:**
- Modify: `apps/web/lib/supabase/server.ts`
- Modify: `apps/web/lib/supabase/client.ts`
- Check: `apps/web/next.config.ts` for Clerk plugin
- Check: `apps/web/package.json` for @clerk/nextjs

- [ ] **Step 1: server.ts — Replace Clerk auth with Supabase session**

```typescript
// Before:
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

// ...
const { getToken } = await auth();
return createClient(url, key, {
  async accessToken() {
    return getToken();  // Clerk token
  },
});

// After:
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export async function createServerSupabaseClient() {
  const { url, key } = getEnv();
  const cookieStore = await cookies();

  return createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
    global: {
      headers: {
        cookie: cookieStore.toString(),
      },
    },
  });
}
```

- [ ] **Step 2: client.ts — Remove Clerk dependency, use native Supabase**

```typescript
// Before:
'use client';
import { createClient } from '@supabase/supabase-js';
import { useSession } from '@clerk/nextjs';

// ...
return createClient(url, key, {
  async accessToken() {
    return session?.getToken() ?? null;
  },
});

// After:
'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { useRef, useCallback } from 'react';

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase client environment variables. ' +
        'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env',
    );
  }
  return { url, key };
}

export function useSupabaseBrowserClient(): SupabaseClient {
  const clientRef = useRef<SupabaseClient | null>(null);

  if (!clientRef.current) {
    const { url, key } = getEnv();
    clientRef.current = createClient(url, key, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
  }

  return clientRef.current;
}
```

Note: The web app needs a sign-in page. Supabase Auth UI can be embedded or use Supabase's pre-built components. Create `apps/web/app/(auth)/sign-in/page.tsx` and `apps/web/app/(auth)/sign-up/page.tsx` using `@supabase/ssr` and `@supabase/auth-ui-react` (or the newer `@supabase/ui`).

- [ ] **Step 3: Check next.config.ts for Clerk plugin**

Run: `grep -n "Clerk\|clerk" apps/web/next.config.ts`

If found, remove:
```typescript
// Remove:
const { withClerkEyeOpen } = require('clerk');

// Or if using Next.js Clerk plugin, remove the plugin configuration
```

- [ ] **Step 4: Check web package.json**

Run: `grep "@clerk" apps/web/package.json`

If `@clerk/nextjs` is present, remove it. Add Supabase packages:
```bash
npm install @supabase/supabase-js @supabase/ssr @supabase/auth-ui-react @supabase/ui
npm uninstall @clerk/nextjs
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/supabase/server.ts apps/web/lib/supabase/client.ts apps/web/package.json
git commit -m "refactor(web): remove Clerk, wire native Supabase auth on client and server"
```

---

## Task 9: .env.example — Update Environment Variables

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Remove Clerk vars, add Supabase vars**

```bash
# Remove:
# CLERK_SECRET_KEY=sk_...
# CLERK_PUBLISHABLE_KEY=pk_...
# CLERK_WEBHOOK_SECRET=whsec_...

# Add:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_JWT_SECRET=your-jwt-secret-from-supabase-dashboard
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): replace CLERK_* with SUPABASE_* env vars"
```

---

## Task 10: Delete Clerk Files

**Files:**
- Delete: `apps/api/src/auth/clerk-auth.service.ts`
- Delete: `apps/api/src/auth/clerk-webhook.controller.ts`
- Delete: `CLERK_SUPABASE_SYSTEM_FOR_VOICE_AGENT_PLATFORM.md` (migrated doc, no longer needed)

- [ ] **Step 1: Delete files**

```bash
rm apps/api/src/auth/clerk-auth.service.ts
rm apps/api/src/auth/clerk-webhook.controller.ts
rm CLERK_SUPABASE_SYSTEM_FOR_VOICE_AGENT_PLATFORM.md
```

- [ ] **Step 2: Verify no remaining Clerk imports in main codebase**

Run: `grep -r "@clerk\|clerk-" apps/api/src apps/web/src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".playwright-mcp\|worktrees"`

Expected: No matches in `apps/api/src` or `apps/web/` (only worktree artifacts should remain).

- [ ] **Step 3: Commit**

```bash
git add -A apps/api/src/auth/clerk-auth.service.ts apps/api/src/auth/clerk-webhook.controller.ts CLERK_SUPABASE_SYSTEM_FOR_VOICE_AGENT_PLATFORM.md
git commit -m "chore: delete Clerk auth files — superseded by Supabase"
```

---

## Task 11: Final Integration Test

**Files:**
- Run: Existing API tests
- Run: Smoke test script

- [ ] **Step 1: Run API typecheck and tests**

Run: `cd apps/api && npm run typecheck`
Expected: Clean compile.

Run: `cd apps/api && npm test`
Expected: All tests pass (may need test fixtures updated if they mock Clerk).

- [ ] **Step 2: Run smoke test**

Run: `node scripts/smoke-test.js`
Expected: API responds, auth flow works with Supabase JWT.

- [ ] **Step 3: Verify web builds**

Run: `cd apps/web && npm run build`
Expected: Clean Next.js build.

---

## Self-Review Checklist

- [ ] All `@clerk/backend` imports removed from API code
- [ ] All `@clerk/nextjs` imports removed from web code
- [ ] `AUTH_PROVIDER: 'supabase'` in env.ts
- [ ] Prisma schema columns renamed (`clerkOrgId` → `supabaseOrgId`, `clerkUserId` → `supabaseUserId`)
- [ ] Migration SQL matches schema changes
- [ ] `SupabaseAuthService` verifies JWT using `SUPABASE_JWT_SECRET`
- [ ] `SupabaseWebhookController` handles user sync
- [ ] Web clients use native Supabase (not Clerk token exchange)
- [ ] `.env.example` has no CLERK_* vars
- [ ] `svix` removed from package.json (only used for Clerk webhooks)
- [ ] `@supabase/supabase-js` added to API dependencies

---

**Plan complete.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?