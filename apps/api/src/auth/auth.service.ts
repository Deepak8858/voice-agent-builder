import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';

/**
 * Auth provider interface. ClerkAuthService is the sole production
 * implementation. The frontend uses Clerk's hosted UI for sign-up/sign-in,
 * and the API verifies Bearer tokens on every request.
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
