import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  VOICE_STANDARD_PIPELINE_ENABLED: true,
}));

vi.mock('../config/env', () => ({ env: envState }));

import { PipelineRouterService } from './pipeline-router.service';

describe('PipelineRouterService', () => {
  const router = new PipelineRouterService();

  beforeEach(() => {
    envState.VOICE_STANDARD_PIPELINE_ENABLED = true;
  });

  it('keeps free-plan calls on the in-house pipeline', () => {
    expect(router.route('free', randomUUID())).toEqual({
      pipeline: 'standard',
      reason: 'plan_standard_only',
    });
  });

  it.each(['growth', 'enterprise'] as const)('keeps %s calls on realtime', (plan) => {
    expect(router.route(plan, randomUUID())).toEqual({
      pipeline: 'realtime',
      reason: 'plan_realtime_only',
    });
  });

  /**
   * The split must be a property of the call, not of when the question is asked.
   * A retry, a webhook, and reconciliation all re-derive it and must agree with
   * the value persisted on the call row.
   */
  it('returns the same pipeline every time for one starter call', () => {
    const callId = 'c3f4a9a2-0f8b-4a51-9a25-2b8de6d1a111';
    const first = router.route('starter', callId);

    for (let i = 0; i < 20; i += 1) {
      expect(router.route('starter', callId)).toEqual(first);
    }
  });

  it('splits starter traffic close to evenly across many calls', () => {
    let realtime = 0;
    const total = 4_000;
    for (let i = 0; i < total; i += 1) {
      if (router.route('starter', `call-${i}`).pipeline === 'realtime') realtime += 1;
    }

    // 50/50 with a generous band: the assertion guards against a hash that
    // collapses to one side, not against ordinary sampling noise.
    const share = (realtime / total) * 100;
    expect(share).toBeGreaterThan(45);
    expect(share).toBeLessThan(55);
  });

  it('reports the split decision so an audit can explain it', () => {
    expect(router.route('starter', randomUUID()).reason).toBe('plan_split_hash');
  });

  describe('when the in-house pipeline is disabled', () => {
    beforeEach(() => {
      envState.VOICE_STANDARD_PIPELINE_ENABLED = false;
    });

    it('serves split plans entirely on realtime rather than failing calls', () => {
      expect(router.route('starter', randomUUID())).toEqual({
        pipeline: 'realtime',
        reason: 'standard_pipeline_disabled',
      });
    });

    /**
     * Free has no realtime entitlement, so it must not be silently upgraded to
     * the runtime it does not pay for. The route stays `standard` and the reason
     * tells the caller to refuse the call instead.
     */
    it('never upgrades a free call to realtime', () => {
      expect(router.route('free', randomUUID())).toEqual({
        pipeline: 'standard',
        reason: 'standard_pipeline_disabled',
      });
      expect(router.standardPipelineEnabled()).toBe(false);
    });
  });

  describe('isAllowed', () => {
    it('refuses realtime for the free plan', () => {
      expect(router.isAllowed('free', 'realtime')).toBe(false);
      expect(router.isAllowed('free', 'standard')).toBe(true);
    });

    it('allows both pipelines on a split plan', () => {
      expect(router.isAllowed('starter', 'realtime')).toBe(true);
      expect(router.isAllowed('starter', 'standard')).toBe(true);
    });

    it('refuses the in-house pipeline for realtime-only plans', () => {
      expect(router.isAllowed('growth', 'standard')).toBe(false);
      expect(router.isAllowed('enterprise', 'standard')).toBe(false);
    });
  });
});
