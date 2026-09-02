import { describe, expect, it } from 'vitest';
import { UuidParamPipe } from './uuid-param.pipe';
import { CallNotFoundError } from './errors';

const VALID_UUID = '44444444-4444-4444-4444-444444444444';

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe((id) => new CallNotFoundError(id));

  it('returns the value unchanged when it is a UUID', () => {
    expect(pipe.transform(VALID_UUID)).toBe(VALID_UUID);
  });

  it('throws the supplied not-found error for a non-UUID value', () => {
    // The reported crash: an id such as a literal word reaches Prisma and
    // throws P2023. The pipe stops it at the boundary with a 404 instead.
    expect(() => pipe.transform('booking')).toThrow(CallNotFoundError);
  });

  it('rejects a value with the wrong segment lengths', () => {
    expect(() => pipe.transform('4444-4444-4444')).toThrow(CallNotFoundError);
  });

  it('passes an absent value through so an optional query param means "no filter"', () => {
    // An optional @Query param arrives as undefined; the pipe must not turn
    // "no id" into a 404. Present but malformed ids are still rejected above.
    expect(pipe.transform(undefined)).toBeUndefined();
  });
});
