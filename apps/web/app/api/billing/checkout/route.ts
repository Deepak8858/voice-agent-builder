import { NextResponse } from 'next/server';
import { apiFetch, ApiCallError } from '@/lib/api';
import { buildDemoCheckoutFallback, isDemoBillingMode } from '@/lib/billing-mode';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  CheckoutPlanSchema,
  type CheckoutPlan,
  type SessionUser,
} from '@voiceforge/shared';

/**
 * Server-side bridge from the marketing pricing page (and post-signup
 * bouncer) to the workspace-scoped Stripe Checkout endpoint on the NestJS
 * API. We re-authenticate the Supabase session, look up the user's active
 * workspace via /auth/me, and only then ask the API to mint a Checkout URL.
 *
 * This route is intentionally tiny:
 *   - the frontend never sees the Stripe secret key
 *   - the user can only checkout for a workspace they belong to (WorkspaceGuard
 *     re-checks membership server-side)
 *   - plan IDs are validated by Zod before we forward the request
 */
function isTrustedCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'checkout.stripe.com' || u.hostname.endsWith('.stripe.com'))
    );
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'You must be signed in to start checkout.' },
      { status: 401 },
    );
  }

  let body: { plan?: CheckoutPlan; successPath?: string; cancelPath?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CheckoutPlanSchema.safeParse(body.plan);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Unknown plan.' }, { status: 400 });
  }

  if (isDemoBillingMode()) {
    return NextResponse.json(buildDemoCheckoutFallback(parsed.data));
  }

  let me: SessionUser;
  try {
    me = await apiFetch<SessionUser>('/auth/me');
  } catch (err) {
    const status = err instanceof ApiCallError ? err.status : 500;
    return NextResponse.json(
      { error: 'Unable to load your account. Please try again.' },
      { status },
    );
  }

  const workspaceId = me.active_workspace_id;
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'You need an active workspace before upgrading.' },
      { status: 409 },
    );
  }

  try {
    const session = await apiFetch<{ url: string }>(
      `/workspaces/${workspaceId}/billing/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({
          plan: parsed.data,
          successPath: body.successPath ?? '/checkout/success',
          cancelPath: body.cancelPath ?? '/checkout/cancel',
        }),
      },
    );
    if (!session?.url || !isTrustedCheckoutUrl(session.url)) {
      return NextResponse.json(
        { error: 'Stripe returned an unexpected checkout URL.' },
        { status: 502 },
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.code === 'BILLING_UNAVAILABLE' && /demo/i.test(err.message)) {
        return NextResponse.json(buildDemoCheckoutFallback(parsed.data));
      }
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: 'Failed to start checkout. Please try again.' },
      { status: 500 },
    );
  }
}
