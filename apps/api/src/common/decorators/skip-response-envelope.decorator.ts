import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_ENVELOPE_KEY = Symbol('SKIP_RESPONSE_ENVELOPE');

/** Preserve a route's native response shape instead of applying the API envelope. */
export const SkipResponseEnvelope = () => SetMetadata(SKIP_RESPONSE_ENVELOPE_KEY, true);
