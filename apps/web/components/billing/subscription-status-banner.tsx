import 'server-only';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { apiFetch, ApiCallError } from '@/lib/api';
import { CHECKOUT_UNAVAILABLE_MESSAGE, CHECKOUT_UNAVAILABLE_TITLE } from '@/lib/billing-copy';
import type { BillingStatusDto, SessionUser, SubscriptionDto, SubscriptionStatus } from '@voiceforge/shared';

const PROBLEM_STATUSES = [
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
] as const satisfies ReadonlyArray<SubscriptionStatus>;

type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

interface StatusCopy {
  title: string;
  description: string;
  cta: string;
}

const COPY_BY_STATUS: Record<ProblemStatus, StatusCopy> = {
  past_due: {
    title: 'Payment is past due',
    description:
      'Your last invoice failed. Update your payment method to keep your paid features active.',
    cta: 'Update billing',
  },
  unpaid: {
    title: 'Subscription unpaid',
    description:
      'Stripe could not collect payment after multiple retries. Update billing to restore access.',
    cta: 'Update billing',
  },
  incomplete: {
    title: 'Finish setting up your subscription',
    description:
      'Stripe is still waiting to confirm the first payment. Open the customer portal to finish checkout.',
    cta: 'Open billing portal',
  },
  incomplete_expired: {
    title: 'Subscription setup expired',
    description:
      'Your previous checkout session expired before payment completed. Start a fresh checkout to continue.',
    cta: 'Choose a plan',
  },
};

function isProblemStatus(status: SubscriptionStatus): status is ProblemStatus {
  return (PROBLEM_STATUSES as ReadonlyArray<SubscriptionStatus>).includes(status);
}

/**
 * Renders a dismissible-looking dashboard-wide banner when the active
 * workspace's Stripe subscription is in a state that needs the customer's
 * attention. The banner is server-rendered so it stays correct even before
 * client-side React Query hydrates the billing panel.
 */
export async function SubscriptionStatusBanner() {
  let me: SessionUser | null = null;
  try {
    me = await apiFetch<SessionUser>('/auth/me');
  } catch (err) {
    if (err instanceof ApiCallError) return null;
    throw err;
  }
  const workspaceId = me?.active_workspace_id;
  if (!workspaceId) return null;

  let billingStatus: BillingStatusDto | null = null;
  try {
    billingStatus = await apiFetch<BillingStatusDto>(
      `/workspaces/${workspaceId}/billing/status`,
    );
  } catch (err) {
    if (!(err instanceof ApiCallError)) throw err;
  }
  if (billingStatus?.liveCheckoutEnabled === false) {
    return (
      <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="min-w-0">
              <p className="font-medium leading-5">{CHECKOUT_UNAVAILABLE_TITLE}</p>
              <p className="mt-0.5 text-xs leading-5 text-amber-800/90 dark:text-amber-100/80">
                {CHECKOUT_UNAVAILABLE_MESSAGE}
              </p>
            </div>
          </div>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center justify-center rounded-md border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100 dark:hover:bg-amber-900/70"
          >
            View balance
          </Link>
        </div>
      </div>
    );
  }

  let sub: SubscriptionDto | null = null;
  try {
    sub = await apiFetch<SubscriptionDto | null>(
      `/workspaces/${workspaceId}/billing/subscription`,
    );
  } catch (err) {
    if (err instanceof ApiCallError) return null;
    throw err;
  }
  if (!sub) return null;

  const status = sub.status;
  if (!isProblemStatus(status)) return null;
  const copy = COPY_BY_STATUS[status];

  const href =
    status === 'incomplete_expired' ? '/pricing' : '/dashboard/billing';

  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="min-w-0">
            <p className="font-medium leading-5">{copy.title}</p>
            <p className="mt-0.5 text-xs leading-5 text-amber-800/90 dark:text-amber-100/80">
              {copy.description}
            </p>
          </div>
        </div>
        <Link
          href={href}
          className="inline-flex items-center justify-center rounded-md border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100 dark:hover:bg-amber-900/70"
        >
          {copy.cta}
        </Link>
      </div>
    </div>
  );
}
