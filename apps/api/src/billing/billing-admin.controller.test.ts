import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { ValidationError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { env } from '../config/env';
import { BillingAdminController } from './billing-admin.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const KEY = 'test-internal-api-key-with-32-chars';

function makeController() {
  const reconciliation = {
    clearBalanceReview: vi.fn(async () => ({
      cleared: true,
      previousStatus: 'review',
      previousReviewReason: 'stale_call_with_debits',
    })),
  };
  return {
    reconciliation,
    controller: new BillingAdminController(reconciliation as never),
  };
}

/** The pipes Nest would apply to the handler's arguments, in declaration order. */
function argPipes(): ZodValidationPipe<never>[] {
  const args: Record<string, { index: number; pipes?: unknown[] }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, BillingAdminController, 'clearBalanceReview') ?? {};
  return Object.values(args)
    .sort((a, b) => a.index - b.index)
    .flatMap((arg) => (arg.pipes ?? []) as ZodValidationPipe<never>[]);
}

function contextFor(headers: Record<string, string>) {
  const req = { headers, method: 'POST', path: `/admin/billing/orgs/${ORG}/clear-balance-review` };
  return {
    getHandler: () =>
      (BillingAdminController.prototype as unknown as Record<string, unknown>)
        .clearBalanceReview,
    getClass: () => BillingAdminController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('BillingAdminController.clearBalanceReview', () => {
  beforeEach(() => {
    Object.assign(env, { INTERNAL_API_KEY: KEY });
  });

  it('delegates the organization and the named operator to the service', async () => {
    const { controller, reconciliation } = makeController();

    const result = await controller.clearBalanceReview(ORG, { clearedBy: 'ops@voiceforge.ai' });

    expect(reconciliation.clearBalanceReview).toHaveBeenCalledWith(ORG, 'ops@voiceforge.ai');
    expect(result).toEqual({
      cleared: true,
      previousStatus: 'review',
      previousReviewReason: 'stale_call_with_debits',
    });
  });

  /**
   * The whole point of the route living here rather than on BillingController:
   * a tenant that can clear its own `blocked` status defeats the partial-refund
   * protection that set it. @InternalOnly() is the only decorator that refuses
   * a user-carrying request, and the Next.js proxy attaches the internal key to
   * whatever path a signed-in user asks for — so authentication alone would
   * leave this open to every tenant user. Driven through the REAL guard with a
   * real Reflector against the real class, so removing the decorator fails here.
   */
  it('refuses a user-bearer request even though it carries the internal key', async () => {
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(new Reflector(), authService as never);

    await expect(
      guard.canActivate(
        contextFor({ 'x-internal-key': KEY, authorization: 'Bearer verified-token' }),
      ),
    ).rejects.toThrow();
    expect(authService.getSessionUser).not.toHaveBeenCalled();
  });

  it('admits the operator holding the bare internal key', async () => {
    const guard = new InternalAuthGuard(new Reflector(), { getSessionUser: vi.fn() } as never);

    await expect(guard.canActivate(contextFor({ 'x-internal-key': KEY }))).resolves.toBe(true);
  });

  it('rejects an orgId that is not a uuid before it reaches Prisma', () => {
    const [orgIdPipe] = argPipes();

    expect(() => orgIdPipe.transform('not-a-uuid', {} as never)).toThrow(ValidationError);
    expect(orgIdPipe.transform(ORG, {} as never)).toBe(ORG);
  });

  it('requires a non-empty clearedBy so the audit entry always names someone', () => {
    const [, bodyPipe] = argPipes();

    expect(() => bodyPipe.transform({}, {} as never)).toThrow(ValidationError);
    expect(() => bodyPipe.transform({ clearedBy: '   ' }, {} as never)).toThrow(ValidationError);
    expect(bodyPipe.transform({ clearedBy: 'ops@voiceforge.ai' }, {} as never)).toEqual({
      clearedBy: 'ops@voiceforge.ai',
    });
  });
});
