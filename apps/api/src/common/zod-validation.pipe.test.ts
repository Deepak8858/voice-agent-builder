import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';
import { ValidationError } from './errors';

const schema = z.object({ email: z.string().email(), name: z.string().min(1) });

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns parsed data on valid input', () => {
    expect(pipe.transform({ email: 'a@b.com', name: 'Ada' }, {} as never)).toEqual({
      email: 'a@b.com',
      name: 'Ada',
    });
  });

  it('throws ValidationError on invalid input', () => {
    try {
      pipe.transform({ email: 'not-an-email', name: '' }, {} as never);
      throw new Error('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).errorCode).toBe('VALIDATION_ERROR');
    }
  });
});
