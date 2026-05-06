import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Skip the InternalAuthGuard. Use on health, metrics, and provider
 * webhooks (which authenticate themselves via signatures).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
