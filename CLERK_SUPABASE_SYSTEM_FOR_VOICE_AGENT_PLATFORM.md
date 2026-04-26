# Clerk + Supabase System Architecture for VoiceForge AI

## Purpose

This document defines the best practical architecture for using **Clerk + Supabase** in the AI voice calling agent builder platform.

The product is a Lovable-style platform where agencies and businesses create inbound and outbound AI voice agents using prompts, vertical templates, business data, compliance settings, analytics, and white-label workspaces.

---

# 1. Final Stack Decision

## Recommended Stack

```txt
Frontend:
Next.js + TypeScript + Tailwind CSS + shadcn/ui + React Flow

Authentication:
Clerk Auth

B2B / Multi-Tenant Organizations:
Clerk Organizations

Billing:
Clerk Billing for subscription plans and feature gating
Supabase usage ledger for voice minutes and provider costs
Direct Stripe later for advanced metered billing if needed

Database:
Supabase Postgres

Vector Database:
Supabase pgvector

Authorization:
Clerk session claims + Supabase Row Level Security + backend permission checks

Storage:
Supabase Storage or Cloudflare R2

Voice Runtime:
Vapi / Retell first
OpenAI Realtime + LiveKit later

Analytics:
Supabase tables first
ClickHouse later when call events grow

Compliance:
Custom Supabase tables + backend compliance engine
```

## Why This Stack Is Best for the MVP

Clerk should own:

- Authentication
- User sessions
- Organizations
- Organization roles
- Organization permissions
- Invitations
- Plan/subscription access
- Pricing table UI
- Basic subscription feature gating

Supabase should own:

- Product database
- Agents
- Agent versions
- Calls
- Transcripts
- Usage
- Compliance records
- Knowledge base
- pgvector embeddings
- RLS policies
- Storage if used

Stripe should own:

- Payment processing behind Clerk Billing
- Later direct advanced usage billing if Clerk Billing is not enough

---

# 2. Important Current Platform Facts

## Clerk + Supabase Integration

Clerk now supports Supabase as a native third-party auth provider. This means Supabase can accept Clerk session tokens directly, and you should use the native integration instead of the old Supabase JWT template approach.

The key pattern is:

```txt
Clerk session token
  ↓
Supabase client accessToken()
  ↓
Supabase RLS reads auth.jwt()
  ↓
Database policies allow/deny access
```

## Clerk Billing Status

Clerk Billing is useful for subscriptions and plan-based access control, but it is still Beta. Its APIs may change, so SDK versions should be pinned.

Clerk Billing uses Stripe for payment processing, but Clerk Billing is separate from Stripe Billing. Clerk plan/subscription records are not synced into Stripe as normal Stripe Billing subscriptions.

Clerk Billing currently has limitations that matter for this product:

- Beta APIs
- USD-only billing
- No tax/VAT support yet
- Refunds must be handled in Stripe
- Not supported in some countries, including India
- Usage and full per-seat billing should not be treated as your only source of truth for voice-minute billing yet

## Supabase pgvector

Supabase supports pgvector through the `vector` extension. Use it for knowledge base embeddings, semantic search, and retrieval-augmented generation for each voice agent.

---

# 3. Core Architecture

```txt
User Browser
  ↓
Next.js App
  ↓
Clerk Auth + Active Organization
  ↓
Supabase Client with Clerk Session Token
  ↓
Supabase RLS Policies
  ↓
Supabase Postgres + pgvector
  ↓
Voice Runtime Adapter
  ├── Vapi
  ├── Retell
  ├── OpenAI Realtime later
  └── LiveKit later
  ↓
Calls, transcripts, usage, compliance, analytics
```

## Recommended Runtime Split

### Client-Side Access

Use the Clerk-authenticated Supabase client for safe, user-facing reads/writes where RLS can protect the data.

Examples:

- List agents
- Read templates
- Read call summaries
- Edit draft agent metadata
- View workspace settings

### Server-Side Service Access

Use server-side actions/API routes with Supabase service role for trusted workflows that cannot rely only on client RLS.

Examples:

- Voice provider webhooks
- Stripe/Clerk webhooks
- Agent generation
- Agent publishing
- Tool execution
- Outbound call compliance gate
- Billing usage writes
- Embedding generation
- File processing
- Internal analytics ingestion

---

# 4. Multi-Tenancy Model

## Clerk Organization

A Clerk Organization represents the billable SaaS customer.

For this product, the Clerk Organization should usually represent:

```txt
Agency account
or
Direct SMB business account
```

## Supabase Organization

You also store an internal organization record in Supabase.

```sql
create table app_organizations (
  id uuid primary key default gen_random_uuid(),
  clerk_org_id text unique not null,
  name text not null,
  slug text,
  plan_slug text default 'free',
  billing_status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Workspace

Workspaces are product-level containers.

```txt
Clerk Organization
  ↓
App Organization
  ↓
Workspaces
    ├── Agency workspace
    ├── Client workspace A
    ├── Client workspace B
    └── Internal workspace
```

```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  parent_workspace_id uuid references workspaces(id) on delete set null,
  type text not null check (type in ('agency', 'client', 'internal')),
  name text not null,
  slug text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(organization_id, slug)
);
```

## Why Not Use Clerk Organizations as Client Workspaces?

Do **not** create a separate Clerk Organization for every agency client in the MVP.

Better:

```txt
One Clerk Organization = one paying agency
Multiple Supabase workspaces = agency clients
```

Why:

- Simpler billing
- Easier white-label hierarchy
- Easier agency-level analytics
- Easier usage rollup
- Easier client isolation inside your product

Later, for enterprise, you may allow client-owned Clerk Organizations.

---

# 5. Auth Identity Mapping

## Local Users Table

Clerk stores the real auth user. Supabase stores a synced app user profile.

```sql
create table app_users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text unique not null,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Organization Membership Cache

Clerk is the source of truth for memberships and roles, but your app can cache memberships for analytics, RLS, and internal joins.

```sql
create table app_org_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  clerk_user_id text not null,
  clerk_org_id text not null,
  role text not null,
  permissions text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(organization_id, user_id)
);
```

## Sync Source

Use Clerk webhooks to sync:

- user.created
- user.updated
- organization.created
- organization.updated
- organizationMembership.created
- organizationMembership.updated
- organizationMembership.deleted

---

# 6. Clerk Session Claims Strategy

## Active Organization Claims

Clerk session tokens include user identity and, when an organization is active, organization context.

In newer Clerk session token versions, organization data may appear in compact form under the `o` claim:

```json
{
  "sub": "user_123",
  "o": {
    "id": "org_123",
    "slg": "agency-slug",
    "rol": "admin",
    "per": "read,manage"
  },
  "pla": "o:agency",
  "fea": "o:white_label,o:outbound_calls"
}
```

Older claim formats may expose:

```json
{
  "sub": "user_123",
  "org_id": "org_123",
  "org_role": "org:admin",
  "org_permissions": ["org:admin:agents"]
}
```

## Best Practice

For frontend/backend app logic, use Clerk SDK helpers when possible.

For Supabase RLS, keep policies simple:

- Use `auth.jwt()->>'sub'` for user ID checks.
- Use either compact organization claim extraction or a custom short claim if needed.
- Avoid putting large custom data in Clerk session tokens.

## Optional Custom Session Claim

If RLS becomes too difficult with compact `o` claims, add a small custom claim in Clerk:

```json
{
  "active_org_id": "{{org.id}}"
}
```

Then RLS can use:

```sql
auth.jwt()->>'active_org_id'
```

Keep custom claims small because browser cookies have size limits.

---

# 7. Supabase Client Setup

## Client-Side Supabase Client

```ts
'use client'

import { createClient } from '@supabase/supabase-js'
import { useSession } from '@clerk/nextjs'

export function useClerkSupabaseClient() {
  const { session } = useSession()

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      async accessToken() {
        return session?.getToken() ?? null
      },
    }
  )
}
```

## Server-Side Supabase Client With Clerk Token

```ts
import { auth } from '@clerk/nextjs/server'
import { createClient } from '@supabase/supabase-js'

export async function createServerSupabaseClient() {
  const { getToken } = await auth()

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      async accessToken() {
        return getToken()
      },
    }
  )
}
```

## Admin Service Role Client

Use this only on the server.

```ts
import { createClient } from '@supabase/supabase-js'

export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  )
}
```

Use service role for:

- Webhooks
- Billing sync
- Voice provider callbacks
- Agent publishing
- Embedding jobs
- Tool execution
- Internal workers

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

---

# 8. Row Level Security Design

## Rule

Every customer-owned table must have:

```txt
organization_id
workspace_id where needed
created_by_clerk_user_id where needed
```

## Helper Function: Current Clerk User ID

```sql
create or replace function current_clerk_user_id()
returns text
language sql
stable
as $$
  select auth.jwt()->>'sub'
$$;
```

## Helper Function: Current Clerk Organization ID

Use this version if you add a custom `active_org_id` claim:

```sql
create or replace function current_clerk_org_id()
returns text
language sql
stable
as $$
  select auth.jwt()->>'active_org_id'
$$;
```

If you do not add a custom claim and are using Clerk v2 compact organization claim, adapt this carefully:

```sql
create or replace function current_clerk_org_id()
returns text
language sql
stable
as $$
  select auth.jwt()->'o'->>'id'
$$;
```

## Organization Table RLS

```sql
alter table app_organizations enable row level security;

create policy "Users can read their active organization"
on app_organizations
for select
to authenticated
using (
  clerk_org_id = current_clerk_org_id()
);
```

## Workspace RLS

```sql
alter table workspaces enable row level security;

create policy "Users can read workspaces in active org"
on workspaces
for select
to authenticated
using (
  organization_id in (
    select id from app_organizations
    where clerk_org_id = current_clerk_org_id()
  )
);
```

## Agents RLS

```sql
alter table agents enable row level security;

create policy "Users can read agents in active org"
on agents
for select
to authenticated
using (
  workspace_id in (
    select w.id
    from workspaces w
    join app_organizations o on o.id = w.organization_id
    where o.clerk_org_id = current_clerk_org_id()
  )
);
```

## Calls RLS

```sql
alter table calls enable row level security;

create policy "Users can read calls in active org"
on calls
for select
to authenticated
using (
  workspace_id in (
    select w.id
    from workspaces w
    join app_organizations o on o.id = w.organization_id
    where o.clerk_org_id = current_clerk_org_id()
  )
);
```

## Important RLS Note

RLS is a safety layer, not the only authorization system.

You still need backend permission checks for actions like:

- Publishing an agent
- Starting outbound calls
- Creating client workspaces
- Updating billing settings
- Connecting integrations
- Running tools
- Viewing recordings
- Deleting transcripts

---

# 9. Product Database Schema with Supabase

## Agents

```sql
create table agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  industry text,
  agent_type text,
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'published', 'paused', 'archived')),
  active_version_id uuid,
  created_by_clerk_user_id text not null default current_clerk_user_id(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Agent Versions

```sql
create table agent_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  version_number int not null,
  spec_json jsonb not null,
  provider text,
  provider_runtime_id text,
  deployment_status text default 'not_deployed',
  created_by_clerk_user_id text not null default current_clerk_user_id(),
  created_at timestamptz default now(),
  unique(agent_id, version_number)
);
```

## Knowledge Sources

```sql
create table knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  source_type text not null check (source_type in ('pdf', 'csv', 'url', 'text', 'faq', 'docx')),
  title text not null,
  file_url text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  metadata jsonb default '{}',
  created_by_clerk_user_id text not null default current_clerk_user_id(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Knowledge Chunks with pgvector

Use 1536 dimensions for OpenAI `text-embedding-3-small`, or adjust if using another embedding model.

```sql
create extension if not exists vector;

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete cascade,
  source_id uuid references knowledge_sources(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

## Calls

```sql
create table calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  agent_version_id uuid references agent_versions(id) on delete set null,
  provider text,
  provider_call_id text,
  direction text not null check (direction in ('inbound', 'outbound', 'browser_test')),
  from_number text,
  to_number text,
  status text not null default 'created',
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  recording_url text,
  transcript_text text,
  outcome text,
  cost_cents int default 0,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

## Call Events

```sql
create table call_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  call_id uuid not null references calls(id) on delete cascade,
  event_type text not null,
  event_time timestamptz default now(),
  payload jsonb default '{}'
);
```

## Usage Ledger

```sql
create table usage_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete set null,
  call_id uuid references calls(id) on delete set null,
  usage_type text not null check (
    usage_type in (
      'voice_minutes',
      'llm_tokens',
      'recording_storage',
      'phone_number',
      'agent_published',
      'client_workspace'
    )
  ),
  quantity numeric not null,
  unit text not null,
  provider text,
  provider_cost_cents int default 0,
  platform_price_cents int default 0,
  metadata jsonb default '{}',
  recorded_at timestamptz default now()
);
```

## Compliance Tables

```sql
create table contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  full_name text,
  phone text not null,
  email text,
  opt_out boolean default false,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, phone)
);

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  consent_type text not null,
  source text,
  proof_url text,
  consented_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create table dnc_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  phone text not null,
  source text default 'manual',
  created_at timestamptz default now(),
  unique(workspace_id, phone)
);
```

---

# 10. pgvector Search Function

## Match Knowledge Chunks

```sql
create or replace function match_knowledge_chunks(
  query_embedding vector(1536),
  match_workspace_id uuid,
  match_agent_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    kc.id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  where kc.workspace_id = match_workspace_id
    and (kc.agent_id = match_agent_id or kc.agent_id is null)
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
```

## Vector Index

Use HNSW when data grows.

```sql
create index knowledge_chunks_embedding_hnsw
on knowledge_chunks
using hnsw (embedding vector_cosine_ops);
```

Also index tenant filters:

```sql
create index idx_knowledge_chunks_workspace_agent
on knowledge_chunks(workspace_id, agent_id);
```

---

# 11. Clerk Billing System for This Product

## Recommended Usage

Use Clerk Billing for:

- Starter / Pro / Agency subscriptions
- Free plan assignment
- Pricing table
- Organization-level subscriptions
- Plan-based feature gating
- Seat limits where useful

Do not rely only on Clerk Billing for:

- True voice-minute metered billing
- Non-USD billing
- India billing
- Taxes/VAT
- Refund automation
- Complex enterprise invoices

## Billing Source of Truth

```txt
Clerk Billing:
  plan_slug
  subscription_status
  enabled features
  organization seat limits

Supabase:
  voice usage
  included minutes consumed
  provider costs
  platform markup
  client workspace usage
  call-level billing details

Stripe Direct later:
  metered usage billing
  refunds
  taxes/VAT
  advanced invoices
  unsupported countries alternatives
```

## Recommended Plans

### Free

```txt
1 user
1 draft agent
No live phone deployment
10 browser test minutes
No white-label
No outbound
```

### Starter

```txt
1 live agent
1 workspace
100 included voice minutes
Inbound only
Basic analytics
No white-label
```

### Pro

```txt
5 live agents
3 workspaces
500 included voice minutes
Inbound + opt-in outbound
Google Calendar/webhooks
Call recordings
Basic compliance
```

### Agency

```txt
50 live agents
25 client workspaces
2,000 included voice minutes
White-label branding
Client dashboards
Advanced analytics
Usage by client
Seat limit based on Clerk plan
```

## Feature Slugs

Create Clerk Billing features such as:

```txt
agent_publish
inbound_calls
outbound_calls
white_label
client_workspaces
advanced_analytics
call_recordings
google_calendar
webhooks
custom_voice
api_access
```

## Feature Gate Examples

Frontend:

```tsx
import { Protect } from '@clerk/nextjs'

export function WhiteLabelButton() {
  return (
    <Protect feature="white_label" fallback={<UpgradeCard />}>
      <button>Configure White Label</button>
    </Protect>
  )
}
```

Backend:

```ts
import { auth } from '@clerk/nextjs/server'

export async function requireFeature(feature: string) {
  const { has } = await auth()

  if (!has({ feature })) {
    throw new Error('FEATURE_NOT_AVAILABLE_ON_PLAN')
  }
}
```

Use backend checks for all critical actions.

## Usage Ledger Enforcement

Before publishing or starting calls:

```ts
async function checkUsageLimits(orgId: string, action: string) {
  const plan = await getOrgPlanFromClerk(orgId)
  const usage = await getUsageFromSupabase(orgId)

  if (action === 'publish_agent' && usage.publishedAgents >= plan.maxAgents) {
    throw new Error('AGENT_LIMIT_REACHED')
  }

  if (action === 'start_call' && usage.voiceMinutes >= plan.includedMinutes) {
    throw new Error('VOICE_MINUTES_EXCEEDED')
  }
}
```

## Overages Strategy for MVP

Start simple:

```txt
If included minutes exceeded:
  Option A: block calls until upgrade
  Option B: allow prepaid minute packs
  Option C: require manual top-up
```

Do not start with complex real-time metered invoices unless needed.

---

# 12. Clerk Webhook Sync

## Required Webhook Events

Create a Clerk webhook endpoint:

```txt
/api/webhooks/clerk
```

Handle:

```txt
user.created
user.updated
organization.created
organization.updated
organization.deleted
organizationMembership.created
organizationMembership.updated
organizationMembership.deleted
subscription.created
subscription.updated
subscription.deleted
```

Actual event names may vary depending on Clerk Billing webhook payloads. Implement defensively and store raw payloads.

## Webhook Table

```sql
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz default now(),
  unique(provider, provider_event_id)
);
```

## Webhook Processing Rule

```txt
Receive webhook
  ↓
Verify signature
  ↓
Check idempotency
  ↓
Store raw event
  ↓
Process event
  ↓
Update app_users / app_organizations / memberships / plan status
  ↓
Mark processed
```

---

# 13. White-Label with Clerk + Supabase

## Best Model

Clerk Organization:

```txt
Agency account
```

Supabase Workspaces:

```txt
Agency workspace
Client workspace A
Client workspace B
```

White-label settings live in Supabase:

```sql
create table white_label_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  brand_name text,
  logo_url text,
  primary_color text,
  secondary_color text,
  custom_domain text,
  support_email text,
  hide_platform_branding boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Client User Access

For MVP, client users can be invited into the same Clerk Organization with restricted roles and mapped to specific client workspaces in Supabase.

Add:

```sql
create table workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  clerk_user_id text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz default now(),
  unique(workspace_id, clerk_user_id)
);
```

Use backend permission checks for workspace-level access.

---

# 14. Backend/API Structure

## Recommended Next.js App Router Structure

```txt
app/
  (public)/
  (dashboard)/
  api/
    webhooks/
      clerk/
      voice/
      stripe/
    agents/
    calls/
    compliance/
    knowledge/
    integrations/
    billing/

lib/
  clerk/
  supabase/
    client.ts
    server.ts
    admin.ts
  auth/
    require-feature.ts
    require-workspace.ts
  billing/
    usage-ledger.ts
    plans.ts
  compliance/
  voice/
    adapters/
      mock.ts
      vapi.ts
      retell.ts
  rag/
  db/
```

## When to Use Supabase RLS Client

Use for:

- Dashboard reads
- Safe draft updates
- User-owned records
- Simple workspace data

## When to Use Supabase Admin Client

Use for:

- Webhooks
- Provider callbacks
- Internal workers
- Billing writes
- Compliance enforcement
- Agent publish/deploy
- Tool execution

---

# 15. Environment Variables

```env
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Clerk Billing / Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# LLM
OPENAI_API_KEY=

# Voice Providers
VAPI_API_KEY=
VAPI_WEBHOOK_SECRET=
RETELL_API_KEY=
RETELL_WEBHOOK_SECRET=

# Storage
SUPABASE_STORAGE_BUCKET=voiceforge

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Never expose:

```txt
SUPABASE_SERVICE_ROLE_KEY
CLERK_SECRET_KEY
STRIPE_SECRET_KEY
VOICE_PROVIDER_KEYS
```

---

# 16. Build Order

## Phase 1: Auth + Database Foundation

```txt
1. Setup Clerk app
2. Enable Clerk Organizations
3. Enable Clerk Billing
4. Setup Supabase project
5. Enable Clerk as Supabase third-party auth provider
6. Create Supabase schema
7. Create RLS helper functions
8. Create local app_users and app_organizations
9. Add Clerk webhook sync
```

## Phase 2: Product Core

```txt
1. Create workspaces
2. Create agents
3. Create agent_versions
4. Create prompt-to-agent generator
5. Create template system
6. Add knowledge_sources
7. Add pgvector knowledge_chunks
```

## Phase 3: Billing + Feature Gates

```txt
1. Create Clerk plans
2. Create Clerk features
3. Add PricingTable for organization billing
4. Add backend requireFeature()
5. Add usage_ledger
6. Enforce plan limits
```

## Phase 4: Voice System

```txt
1. Create voice adapter interface
2. Add mock provider
3. Add Vapi/Retell provider
4. Add test calls
5. Add inbound deployment
6. Add call logs and transcripts
```

## Phase 5: White-Label + Agency

```txt
1. Create client workspaces
2. Add workspace_memberships
3. Add white_label_settings
4. Add agency dashboard
5. Add client dashboard
```

---

# 17. Critical Rules for LLM/Coding Agent

1. Use Clerk for auth and organization identity.
2. Use Supabase for product data.
3. Use Supabase pgvector for agent knowledge.
4. Use Clerk Billing for subscription plan gates.
5. Use Supabase usage ledger for voice-minute billing.
6. Do not depend only on Clerk Billing for metered voice usage.
7. Use RLS for read/write protection.
8. Use backend permission checks for sensitive actions.
9. Use service role only on the server.
10. Never expose service role or provider secrets to the browser.
11. Store Clerk IDs in Supabase tables.
12. Sync Clerk data via webhooks.
13. Every customer-owned table must include organization_id.
14. Every workspace-owned table must include workspace_id.
15. Every outbound call must pass compliance checks.
16. Every tool call must be logged.
17. Every call must write usage to usage_ledger.
18. Every agent publish must check plan limits.

---

# 18. Recommended Acceptance Criteria

The Clerk + Supabase system is complete when:

- User can sign up using Clerk.
- User can create or join a Clerk Organization.
- Clerk Organization is synced to Supabase.
- User is synced to Supabase.
- Supabase RLS blocks cross-organization access.
- User can create an agency workspace.
- Agency can create client workspaces.
- User can create agents in a workspace.
- User can upload knowledge and store embeddings in pgvector.
- User can subscribe through Clerk Billing PricingTable.
- Backend can gate features using Clerk plan features.
- Usage ledger records voice minutes.
- Calls are blocked when usage limits are exceeded.
- White-label settings are stored per agency/client workspace.
- Service role key is never exposed client-side.
- Clerk webhook events are idempotently processed.

---

# 19. Official References

- Clerk Billing overview: https://clerk.com/docs/guides/billing/overview
- Clerk PricingTable: https://clerk.com/docs/reference/components/billing/pricing-table
- Clerk Billing seat-limit plans: https://clerk.com/docs/guides/billing/seat-limit-plans
- Clerk + Supabase integration: https://clerk.com/docs/guides/development/integrations/databases/supabase
- Clerk session tokens and organization claims: https://clerk.com/docs/guides/sessions/session-tokens
- Supabase pgvector: https://supabase.com/docs/guides/database/extensions/pgvector
- Supabase vector indexes: https://supabase.com/docs/guides/ai/vector-indexes

---

# Final System Decision

Use this exact model:

```txt
Clerk
  = auth, organizations, memberships, roles, feature gates, subscription plans

Supabase
  = product database, RLS, pgvector knowledge base, call data, compliance, usage ledger

Clerk Billing
  = subscription access and plan entitlements

Supabase Usage Ledger
  = voice minutes, provider costs, overage logic, client-level usage

Stripe Direct Later
  = advanced metered billing, refunds, tax/VAT, unsupported Clerk Billing geographies
```

This gives the product a fast MVP path while keeping the architecture strong enough for a serious SaaS platform.
