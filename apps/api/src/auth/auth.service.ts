export interface LoginInput {
  email: string;
  password: string;
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

export abstract class AuthService {
  abstract signup(input: SignupInput, res: import('express').Response): Promise<import('@voiceforge/shared').SessionUser>;
  abstract login(input: LoginInput, res: import('express').Response): Promise<import('@voiceforge/shared').SessionUser>;
  abstract logout(req: import('express').Request, res: import('express').Response): Promise<void>;
  abstract getSessionUser(req: import('express').Request): Promise<import('@voiceforge/shared').SessionUser | null>;
}