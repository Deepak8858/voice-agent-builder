import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINUTE_PACK, PLAN_CATALOG, getPlanEntitlements } from '@voiceforge/shared';

/**
 * Price drift pin for `docs/16_BILLING.md`.
 *
 * The doc claimed $49 / $149 / $499 and "10 trial minutes" long after the catalog
 * moved to $99 / $299 / $999 with a recurring monthly Free grant and a $39 pack.
 * That is not a cosmetic gap: the doc is what a human quotes a customer and what
 * the next agent treats as the commercial contract, and nothing failed while it
 * was wrong.
 *
 * So the numbers are PARSED out of the doc and compared with the catalog rather
 * than restated here — restating them would just add a third copy to keep in
 * sync. A repricing in `packages/shared/src/billing/catalog.ts` now fails this
 * test until the doc moves with it, and a new plan with no documented line fails
 * it too.
 */
const DOC_PATH = path.resolve(__dirname, '../../../../docs/16_BILLING.md');

/** Normalized: the doc is CRLF on Windows checkouts and LF in CI. */
const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * `from ` is optional and deliberately not captured: Enterprise is sales-assisted,
 * so its documented price is a floor rather than a quotable fixed number. The
 * numeric floor is still the catalog's `monthlyPriceUsd` and is still compared,
 * so the prefix changes how the price reads to a human without letting the
 * number drift.
 */
const PLAN_LINE =
  /^(\w+): (?:from )?\$([\d,]+)\/month, ([\d,]+) agents?, ([\d,]+) minutes\/month, ([\d,]+) concurrent calls?/gm;

const PACK_LINE =
  /^Minute pack: \$([\d,]+) for ([\d,]+) extra minutes, expires ([\d,]+) days after purchase\.$/m;

const num = (raw: string): number => Number(raw.replace(/,/g, ''));

type DocumentedPlan = Record<'monthlyPriceUsd' | 'agents' | 'includedMinutes' | 'concurrentCalls', number>;

const documented: Record<string, DocumentedPlan> = {};
for (const m of doc.matchAll(PLAN_LINE)) {
  documented[m[1] as string] = {
    monthlyPriceUsd: num(m[2] as string),
    agents: num(m[3] as string),
    includedMinutes: num(m[4] as string),
    concurrentCalls: num(m[5] as string),
  };
}

const catalog: Record<string, DocumentedPlan> = {};
for (const plan of PLAN_CATALOG) {
  const entitlements = getPlanEntitlements(plan.id);
  catalog[plan.name] = {
    monthlyPriceUsd: plan.monthlyPriceUsd,
    agents: entitlements.agents,
    includedMinutes: entitlements.includedMinutes,
    concurrentCalls: entitlements.concurrentCalls,
  };
}

describe('16_BILLING.md plan table', () => {
  it('parses a plan line per catalog plan, so a reworded section cannot pass vacuously', () => {
    // Without this, dropping the section or changing its wording would leave an
    // empty parse comparing equal to an empty expectation.
    expect(Object.keys(documented).sort()).toEqual(Object.keys(catalog).sort());
    expect(Object.keys(documented).length).toBeGreaterThan(3);
  });

  it('documents the price, agents, included minutes and concurrency of every plan', () => {
    expect(documented).toEqual(catalog);
  });

  it('documents the minute pack as it is sold', () => {
    const match = PACK_LINE.exec(doc);
    expect(match, 'the "Minute pack:" line is missing or reworded').not.toBeNull();
    expect({
      priceUsd: num(match?.[1] ?? ''),
      minutes: num(match?.[2] ?? ''),
      expiresAfterDays: num(match?.[3] ?? ''),
    }).toEqual({
      priceUsd: MINUTE_PACK.priceUsd,
      minutes: MINUTE_PACK.minutes,
      expiresAfterDays: MINUTE_PACK.expiresAfterDays,
    });
  });
});
