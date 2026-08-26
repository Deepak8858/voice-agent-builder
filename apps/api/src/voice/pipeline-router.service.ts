import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PlanType, VoicePipeline } from '@voiceforge/shared';
import { getPlanEntitlements, isPipelineAllowed } from '@voiceforge/shared';
import { env } from '../config/env';

export interface PipelineRoute {
  pipeline: VoicePipeline;
  /**
   * Why this pipeline was chosen. Persisted alongside the decision so a
   * surprising route (a starter call on realtime, a free call refused) can be
   * explained months later without re-deriving the hash.
   */
  reason:
    | 'plan_realtime_only'
    | 'plan_standard_only'
    | 'plan_split_hash'
    | 'standard_pipeline_disabled';
}

/**
 * Decides which runtime pipeline a call uses.
 *
 * The mix is commercial policy and lives in the shared catalog; this service
 * only turns a plan plus a call identity into one deterministic answer. Routing
 * is decided once per call and persisted on `Call.pipeline`, so a retry, a
 * webhook, and a reconciliation run all agree on what actually ran.
 */
@Injectable()
export class PipelineRouterService {
  /**
   * `callId` must be the identity the decision is stored against. Any stable
   * per-call string works; the split only needs to be uniform and reproducible.
   */
  route(plan: PlanType, callId: string): PipelineRoute {
    const mix = getPlanEntitlements(plan).pipelineMix;

    if (mix.standard === 0) return { pipeline: 'realtime', reason: 'plan_realtime_only' };

    // A plan with no realtime share may never be routed to realtime, even when
    // the in-house pipeline is turned off: that would hand the most expensive
    // runtime to the tier that does not pay for it. Such a call is refused
    // upstream instead, so the decision here stays truthful.
    if (mix.realtime === 0) {
      if (!this.standardPipelineEnabled()) {
        return { pipeline: 'standard', reason: 'standard_pipeline_disabled' };
      }
      return { pipeline: 'standard', reason: 'plan_standard_only' };
    }

    if (!this.standardPipelineEnabled()) {
      // A split plan has bought realtime capability as well, so serving its
      // calls entirely on realtime while the in-house pipeline is unavailable
      // costs margin but never breaks a call.
      return { pipeline: 'realtime', reason: 'standard_pipeline_disabled' };
    }

    // Deterministic per-call split. Comparing against the realtime share means
    // the same callId always lands on the same pipeline, and changing the mix in
    // the catalog moves the boundary without needing new code.
    const bucket = this.bucketOf(callId);
    return {
      pipeline: bucket < mix.realtime ? 'realtime' : 'standard',
      reason: 'plan_split_hash',
    };
  }

  /**
   * Server-side enforcement of the mix. Routing already respects it, but a
   * caller may present a pipeline chosen elsewhere (a resumed call, a
   * hand-crafted dispatch), and a free organization must never reach realtime.
   */
  isAllowed(plan: PlanType, pipeline: VoicePipeline): boolean {
    return isPipelineAllowed(plan, pipeline);
  }

  /**
   * Whether the in-house pipeline can currently serve calls. When it is off,
   * plans that depend on it have no runtime at all, which callers must surface
   * as a refusal rather than silently upgrading them to realtime.
   */
  standardPipelineEnabled(): boolean {
    return env.VOICE_STANDARD_PIPELINE_ENABLED;
  }

  /**
   * Uniform 0–99 bucket derived from the call identity. SHA-256 is used for its
   * even distribution over short, sequential-ish inputs like UUIDs, not for any
   * security property.
   */
  private bucketOf(callId: string): number {
    const digest = createHash('sha256').update(callId).digest();
    // 32 bits of the digest, reduced mod 100. The modulo bias across 2^32
    // values is far below the resolution of a percentage split.
    return digest.readUInt32BE(0) % 100;
  }
}
