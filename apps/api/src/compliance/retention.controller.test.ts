import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RetentionController } from './retention.controller';
import { IS_INTERNAL_ONLY_KEY } from '../common/decorators/internal-only.decorator';

function makeController() {
  const retention = {
    sweepExpiredCalls: vi.fn(async () => ({ deleted: 3, remaining: 1 })),
    sweepStaleTelephonyWebhookEvents: vi.fn(async () => 2),
  };
  return { retention, controller: new RetentionController(retention as never) };
}

describe('RetentionController.sweep', () => {
  /**
   * Parity pin: the manual trigger must cover everything the nightly worker
   * covers. Before this test the operator path swept calls only, so the
   * telephony webhook payloads — the rows with no callId to reach them by —
   * aged out on schedule but never on demand.
   */
  it('runs both sweeps and reports both counts', async () => {
    const { retention, controller } = makeController();

    const result = await controller.sweep();

    expect(retention.sweepExpiredCalls).toHaveBeenCalledTimes(1);
    expect(retention.sweepStaleTelephonyWebhookEvents).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 3, remaining: 1, telephonyWebhookEventsDeleted: 2 });
  });

  it('stays @InternalOnly, so a signed-in tenant user cannot fire a platform-wide sweep', () => {
    expect(Reflect.getMetadata(IS_INTERNAL_ONLY_KEY, RetentionController)).toBe(true);
  });
});
