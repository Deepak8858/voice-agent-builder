import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReconciliationService } from './reconciliation.service';

const ClearBalanceReviewSchema = z.object({
  /**
   * Who is clearing it, for the audit record. An @InternalOnly() route has no
   * user session to read an actor from — InternalAuthGuard refuses any request
   * carrying one — so the operator names themselves, the same trust model the
   * rest of the `admin/*` surface already runs on.
   */
  clearedBy: z.string().trim().min(1).max(200),
});

/**
 * Operator recovery for a balance that is stuck out of `active`.
 *
 * This is deliberately NOT on `BillingController`: that controller is mounted
 * under `workspaces/:workspaceId` and reachable by a tenant's own owner/admin,
 * and a tenant that can clear its own `blocked` status defeats the partial-
 * refund protection that set it. `@RequiredRole` cannot express what this route
 * needs either — every role it can name is held by a tenant member, and
 * `RoleGuard` refuses outright any route keyed by `:orgId` (see
 * FOREIGN_TENANT_PARAMS in `role.guard.ts`), because it resolves workspace
 * memberships and not organizations. @InternalOnly() is the codebase's existing
 * operator-only primitive and the only decorator that refuses a user-carrying
 * request, which is exactly the requirement: the Next.js proxy attaches the
 * internal key to whatever path a signed-in user asks for, so authentication
 * alone would leave this open to every tenant user.
 */
@InternalOnly()
@Controller('admin/billing')
export class BillingAdminController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('orgs/:orgId/clear-balance-review')
  async clearBalanceReview(
    // Validated here so a malformed id is a 400 rather than a raw Prisma error
    // on a uuid column.
    @Param('orgId', new ZodValidationPipe(z.string().uuid())) orgId: string,
    @Body(new ZodValidationPipe(ClearBalanceReviewSchema))
    body: z.infer<typeof ClearBalanceReviewSchema>,
  ): Promise<{
    cleared: boolean;
    previousStatus: string | null;
    previousReviewReason: string | null;
  }> {
    return this.reconciliation.clearBalanceReview(orgId, body.clearedBy);
  }
}
