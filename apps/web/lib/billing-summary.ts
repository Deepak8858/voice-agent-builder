import type { PlanType, SubscriptionStatus } from '@voiceforge/shared';

/**
 * Shape returned by `GET /workspaces/:workspaceId/billing/summary`.
 *
 * The endpoint is organization-scoped even though it is reached through a
 * workspace path: balances belong to the organization, so opening the panel
 * from any workspace shows the same totals.
 *
 * Declared locally rather than in `@voiceforge/shared` because the API-side
 * implementation of this endpoint lands separately; the panel degrades to a
 * "not available yet" state until it does.
 */
export interface BillingSummaryDto {
  organizationId: string;
  catalogVersion: string;
  plan: PlanType;
  status: SubscriptionStatus;
  includedSeconds: number;
  purchasedSeconds: number;
  reservedSeconds: number;
  expiringSeconds: number;
  lifetimeBrowserTestSecondsRemaining: number;
  /** True when the subscription is in a state that permits buying packs. */
  topUpAvailable: boolean;
}

export interface BalanceBucket {
  label: string;
  seconds: number;
  hint: string;
}

/** Whole minutes, rounded down: partial minutes cannot be spent on a call. */
export function secondsToMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds / 60);
}

export function formatBalance(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = secondsToMinutes(safe);
  if (minutes === 0) return `${safe} sec`;
  return `${minutes.toLocaleString('en-US')} min`;
}

export function toBalanceBuckets(summary: BillingSummaryDto): BalanceBucket[] {
  return [
    {
      label: 'Included',
      seconds: summary.includedSeconds,
      hint: 'Resets at the start of each billing period. Does not roll over.',
    },
    {
      label: 'Purchased',
      seconds: summary.purchasedSeconds,
      hint: 'Prepaid packs, consumed after included minutes.',
    },
    {
      label: 'Reserved by active calls',
      seconds: summary.reservedSeconds,
      hint: 'Held while calls are connected and released when they end.',
    },
    {
      label: 'Expiring in 30 days',
      seconds: summary.expiringSeconds,
      hint: 'Purchased minutes that expire within the next 30 days.',
    },
  ];
}
