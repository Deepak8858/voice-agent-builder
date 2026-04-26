import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { ValidationError } from './errors';

/**
 * Usage:
 *   @UsePipes(new ZodValidationPipe(CreateAgentDtoSchema))
 * or per-arg:
 *   @Body(new ZodValidationPipe(CreateAgentDtoSchema)) dto: CreateAgentDto
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError('Request validation failed.', {
        issues: result.error.flatten(),
      });
    }
    return result.data;
  }
}
