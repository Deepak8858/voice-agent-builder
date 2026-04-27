import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';

/**
 * Pluggable auth provider. Phase 0 uses a MockAuthService backed by cookies;
 * Clerk adapter can be dropped in later without changing callers.
 */
export abstract class AuthService {
  abstract signup(input: SignupInput, res: Response): Promise<SessionUser>;
  abstract login(input: LoginInput, res: Response): Promise<SessionUser>;
  abstract logout(req: Request, res: Response): Promise<void>;
  abstract getSessionUser(req: Request): Promise<SessionUser | null>;
}

export interface SignupInput {
  email: string;
  password?: string; // optional for magic-link / SSO providers
  name?: string;
  organization_name?: string;
}

export interface LoginInput {
  email: string;
  password?: string;
}
