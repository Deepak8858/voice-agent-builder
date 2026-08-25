import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, output } from 'zod';
import { ValidationError } from './errors';

/**
 * Usage:
 *   @UsePipes(new ZodValidationPipe(CreateAgentDtoSchema))
 * or per-arg:
 *   @Body(new ZodValidationPipe(CreateAgentDtoSchema)) dto: CreateAgentDto
 *
 * Generic over the schema rather than over a single `T`, because a schema's
 * input and output types differ whenever it applies `.default()` or a
 * transform. `ZodSchema<T>` collapsed the two, so a schema with a default
 * produced a pipe whose `transform` was typed to return the *input* shape -
 * with the defaulted field still optional, even though the parse has by then
 * filled it in.
 */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny>
  implements PipeTransform<unknown, output<S>>
{
  constructor(private readonly schema: S) {}

  transform(value: unknown, _metadata: ArgumentMetadata): output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError('Request validation failed.', {
        issues: result.error.flatten(),
      });
    }
    return result.data;
  }
}
