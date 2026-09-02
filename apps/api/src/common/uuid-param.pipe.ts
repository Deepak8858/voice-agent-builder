import { Injectable, PipeTransform } from '@nestjs/common';
import type { AppError } from './errors';

// Any value Postgres accepts for a `uuid` column. Version and variant bits are
// not checked, so a real id is never rejected.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejects a non-UUID id before it reaches a Postgres `uuid` column, where it
 * would throw Prisma `P2023` and surface as a 500. The caller supplies the
 * not-found error, so a malformed id returns the same 404 as a missing row.
 *
 * An absent value is left untouched: an optional `@Query` param arrives as
 * `undefined`, and the caller reads that as "no filter" rather than a bad id.
 *
 * Usage:
 *   @Param('callId', new UuidParamPipe((id) => new CallNotFoundError(id))) callId: string
 *   @Query('agent_id', new UuidParamPipe((id) => new AgentNotFoundError(id))) agentId?: string
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<string | undefined, string | undefined> {
  constructor(private readonly notFound: (id: string) => AppError) {}

  transform(value: string | undefined): string | undefined {
    if (value === undefined || value === null) return value;
    if (!UUID_PATTERN.test(value)) throw this.notFound(value);
    return value;
  }
}
