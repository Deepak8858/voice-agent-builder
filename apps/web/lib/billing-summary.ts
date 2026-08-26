import type { BillingSummaryDto } from '@voiceforge/shared';

export type { BillingSummaryDto } from '@voiceforge/shared';

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
