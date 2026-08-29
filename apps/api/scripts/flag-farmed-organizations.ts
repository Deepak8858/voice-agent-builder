import './load-env';
import { PrismaClient } from '@prisma/client';

/**
 * Flags free-tier organizations that one identity minted to farm free credit.
 *
 * Background: until the onboarding route derived the organization slug from the
 * Supabase user id, one authenticated identity could POST `/api/onboarding`
 * repeatedly and get a fresh organization each time. The free monthly grant is
 * keyed per organization (`freeMonthlyGrantKey(organizationId, monthKey)`), so
 * every extra organization draws its own allowance, forever — the sweep in
 * `src/workers/free-credit-grant.worker.ts` enumerates organization rows, not
 * identities, and re-runs on every deploy. Capping creation stops new farms; it
 * does nothing about the ones already in the table. This script is that step.
 *
 * Remediation = flagging, never deletion. Setting `organizations.status` to
 * `credit_hold` takes the row out of the sweep's `where: { status: 'active' }`
 * filter, which is the only place in the codebase that reads
 * `Organization.status`. Reversing an operator's mistake is one UPDATE back to
 * `'active'`; no customer data is touched.
 *
 * Usage (dry run — reports only, mutates nothing):
 *   npx tsx scripts/flag-farmed-organizations.ts
 * Apply:
 *   npx tsx scripts/flag-farmed-organizations.ts --apply
 * Reverse one org:
 *   UPDATE organizations SET status = 'active' WHERE id = '...';
 */

/**
 * Status that removes an organization from the free monthly credit sweep.
 *
 * Load-bearing: it must be anything other than `'active'`, because
 * `FreeCreditGrantWorker.sweep()` selects `{ status: 'active' }`. Pinned by a
 * test in `src/workers/free-credit-grant.worker.test.ts`.
 */
export const FREE_CREDIT_HOLD_STATUS = 'credit_hold';

export interface OrganizationFacts {
  id: string;
  ownerUserId: string;
  slug: string;
  name: string;
  status: string;
  createdAt: Date;
  /** Ever attached to a Stripe subscription — a real, billable customer. */
  hasStripeSubscription: boolean;
  /** Ever bought a minute pack. */
  hasPurchasedCredits: boolean;
  /** Somebody other than the owner is a member — a real team, not a farm. */
  hasOtherMembers: boolean;
  /** Agents + calls. Used only to decide which duplicate the owner really uses. */
  activityScore: number;
}

export interface FarmSelection {
  farmed: OrganizationFacts[];
  spared: Array<{ organization: OrganizationFacts; reason: string }>;
}

/**
 * Picks the organizations to put on hold.
 *
 * Criterion — an organization is "farmed" when ALL of these hold:
 *  1. its slug was NOT minted by a capped provisioning path (see
 *     `isCappedSlug`): those are one-per-identity by construction, so they
 *     cannot be farmed;
 *  2. its owner holds two or more such non-capped organizations;
 *  3. it is not the one of them the owner actually uses (most agents + calls,
 *     oldest on a tie) — that one is always kept;
 *  4. it has no Stripe subscription, never bought minutes, and has no member
 *     besides the owner;
 *  5. it is still `active`, i.e. still drawing the monthly grant.
 *
 * Why a legitimate customer cannot match: after the cap, one signup produces at
 * most one non-capped organization (plus the `user-<hash>` personal one), and (2)
 * needs two. So no single-org user, and no user who onboarded once before the cap,
 * is reachable at all. Beyond that, (3) keeps whichever duplicate holds the work,
 * and (4) keeps anything a human ever paid for or shared. What remains is a
 * duplicate that never paid, never bought credit, was never shared, and is not
 * where the owner's agents or calls live.
 */
export function selectFarmedOrganizations(
  organizations: OrganizationFacts[],
): FarmSelection {
  const farmed: FarmSelection['farmed'] = [];
  const spared: FarmSelection['spared'] = [];

  const byOwner = new Map<string, OrganizationFacts[]>();
  for (const organization of organizations) {
    // Capped-path organizations are exempt outright, and are not counted towards
    // the owner's duplicate total either.
    if (isCappedSlug(organization.slug)) continue;
    const group = byOwner.get(organization.ownerUserId) ?? [];
    group.push(organization);
    byOwner.set(organization.ownerUserId, group);
  }

  // An owner with a single non-capped organization flags nothing: that one is
  // always the organization kept below.
  for (const group of byOwner.values()) {
    // Keep the organization the owner actually works in, not merely the oldest:
    // the auto-provisioned personal organization is usually older than the one a
    // pre-cap signup created through onboarding.
    const kept = [...group].sort(
      (a, b) =>
        b.activityScore - a.activityScore ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )[0]!;

    for (const organization of group) {
      if (organization.id === kept.id) continue;
      const reason = sparingReason(organization);
      if (reason) spared.push({ organization, reason });
      else farmed.push(organization);
    }
  }

  return { farmed, spared };
}

/**
 * Minted by a capped provisioning path, so it is one-per-identity by design.
 *
 * Matched on the exact slug shape rather than the `user-` prefix. A pre-cap
 * onboarding slug was `${slugify(orgName)}-${suffix}`, so an organization
 * somebody named "User Portal" also starts with `user-`; treating that as capped
 * would exempt it from flagging *and* drop it from its owner's duplicate count,
 * which is how a farm of "User …" organizations would escape this script
 * entirely.
 *
 * The two capped shapes, both derived in apps/web/app/api/onboarding/route.ts
 * and apps/api/src/auth/supabase-auth.service.ts: the hash slug (24 hex) and the
 * pre-hash legacy slug (the first 8 characters of a uuid, always hex — the first
 * dash sits at index 8). An organization named exactly "User" collides with the
 * legacy shape and stays exempt; the ambiguity is unavoidable from the slug
 * alone and erring towards sparing is the safe direction.
 */
function isCappedSlug(slug: string): boolean {
  return /^user-(?:[0-9a-f]{24}|[0-9a-f]{8})$/.test(slug);
}

function sparingReason(organization: OrganizationFacts): string | null {
  if (organization.hasStripeSubscription) return 'has a Stripe subscription';
  if (organization.hasPurchasedCredits) return 'purchased minutes';
  if (organization.hasOtherMembers) return 'has members besides the owner';
  if (organization.status !== 'active') return `status is already '${organization.status}'`;
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  console.log(
    `[flag-farmed-orgs] ${apply ? 'APPLY' : 'DRY RUN'} — host:`,
    new URL(process.env.DATABASE_URL!).host,
  );

  const owners = await prisma.organization.groupBy({
    by: ['ownerUserId'],
    _count: { _all: true },
    having: { ownerUserId: { _count: { gt: 1 } } },
  });
  if (owners.length === 0) {
    console.log('[flag-farmed-orgs] no owner holds more than one organization — nothing to do');
    await prisma.$disconnect();
    return;
  }
  console.log(`[flag-farmed-orgs] owners with more than one organization: ${owners.length}`);

  const rows = await prisma.organization.findMany({
    where: { ownerUserId: { in: owners.map((owner) => owner.ownerUserId) } },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      createdAt: true,
      ownerUserId: true,
      subscriptions: { select: { stripeSubscriptionId: true }, take: 1 },
      billingCreditBuckets: {
        where: { sourceType: 'purchased' },
        select: { id: true },
        take: 1,
      },
      _count: { select: { agents: true, calls: true } },
    },
    orderBy: [{ ownerUserId: 'asc' }, { createdAt: 'asc' }],
  });

  // Members are looked up in one pass rather than nested per organization: the
  // membership rows of a farmed organization are exactly one (the owner), so the
  // result set stays small even on a big tenant table.
  const memberships = await prisma.membership.findMany({
    where: { workspace: { organizationId: { in: rows.map((row) => row.id) } } },
    select: { userId: true, workspace: { select: { organizationId: true } } },
  });
  const membersByOrg = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const organizationId = membership.workspace.organizationId;
    const members = membersByOrg.get(organizationId) ?? new Set<string>();
    members.add(membership.userId);
    membersByOrg.set(organizationId, members);
  }

  const facts: OrganizationFacts[] = rows.map((row) => ({
    id: row.id,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    hasStripeSubscription: row.subscriptions.some(
      (subscription) => subscription.stripeSubscriptionId !== null,
    ),
    hasPurchasedCredits: row.billingCreditBuckets.length > 0,
    hasOtherMembers: [...(membersByOrg.get(row.id) ?? [])].some(
      (userId) => userId !== row.ownerUserId,
    ),
    activityScore: row._count.agents + row._count.calls,
  }));

  const { farmed, spared } = selectFarmedOrganizations(facts);

  console.log(`[flag-farmed-orgs] spared duplicates: ${spared.length}`);
  for (const entry of spared) {
    console.log(`  - ${entry.organization.id}  ${entry.organization.slug}  (${entry.reason})`);
  }
  console.log(`[flag-farmed-orgs] farmed candidates: ${farmed.length}`);
  for (const organization of farmed) {
    console.log(
      `  ! ${organization.id}  owner=${organization.ownerUserId}  ` +
        `${organization.slug}  created=${organization.createdAt.toISOString()}`,
    );
  }

  if (!apply) {
    console.log(
      '[flag-farmed-orgs] DRY RUN — nothing written. Re-run with --apply to set ' +
        `status='${FREE_CREDIT_HOLD_STATUS}' on the ${farmed.length} organization(s) above.`,
    );
  } else if (farmed.length > 0) {
    const result = await prisma.organization.updateMany({
      where: { id: { in: farmed.map((organization) => organization.id) }, status: 'active' },
      data: { status: FREE_CREDIT_HOLD_STATUS },
    });
    console.log(
      `[flag-farmed-orgs] set status='${FREE_CREDIT_HOLD_STATUS}' on ${result.count} organization(s). ` +
        'No organization, workspace, or credit row was deleted.',
    );
  }

  await prisma.$disconnect();
}

// Only run when executed directly, so the selection logic above can be imported
// by its test. `require.main` is unavailable under the ESM test transform.
if (process.argv[1]?.includes('flag-farmed-organizations')) {
  main().catch((err) => {
    console.error('[flag-farmed-orgs] error:', err);
    process.exit(1);
  });
}
