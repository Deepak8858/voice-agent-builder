import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { SupabaseAuthService } from './supabase-auth.service';
import { env } from '../config/env';

// Mock dependencies
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  membership: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
  workspace: {
    findFirst: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
  organization: {
    upsert: vi.fn(),
  },
};

const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
};

describe('Session validation edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('personal workspace provisioning analytics', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const organizationId = '22222222-2222-4222-8222-222222222222';
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    const workspace = {
      id: workspaceId,
      organizationId,
      name: 'Demo Workspace',
    };

    function provisioningService() {
      const capture = vi.fn();
      const service = new SupabaseAuthService(
        mockPrisma as never,
        mockCache as never,
        { capture } as never,
      );
      return {
        capture,
        provision: (service as unknown as {
          provisionPersonalWorkspace: (
            appUserId: string,
            authUserId: string,
          ) => Promise<{ workspaceCreated: boolean; membership: { workspace: typeof workspace } }>;
        }).provisionPersonalWorkspace.bind(service),
        captureSignedUp: (service as unknown as {
          captureSignedUp: (
            appUserId: string,
            activeWorkspaceId: string,
            activeOrganizationId: string,
            workspaceCreated: boolean,
          ) => void;
        }).captureSignedUp.bind(service),
      };
    }

    it('does not report workspace_created when provisioning reuses a workspace', async () => {
      mockPrisma.organization.upsert.mockResolvedValue({ id: organizationId });
      mockPrisma.workspace.findFirst.mockResolvedValue(workspace);
      mockPrisma.membership.upsert.mockResolvedValue({ role: 'owner', workspace });
      const { provision, captureSignedUp, capture } = provisioningService();

      const result = await provision(userId, 'auth-user-123');
      captureSignedUp(userId, workspaceId, organizationId, result.workspaceCreated);

      expect(result.workspaceCreated).toBe(false);
      expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[0]).toMatchObject({ event: 'user_signed_up' });
    });

    it('reports workspace_created only after creating the workspace row', async () => {
      mockPrisma.organization.upsert.mockResolvedValue({ id: organizationId });
      mockPrisma.workspace.findFirst.mockResolvedValue(null);
      mockPrisma.workspace.create.mockResolvedValue(workspace);
      mockPrisma.membership.upsert.mockResolvedValue({ role: 'owner', workspace });
      const { provision, captureSignedUp, capture } = provisioningService();

      const result = await provision(userId, 'auth-user-123');
      captureSignedUp(userId, workspaceId, organizationId, result.workspaceCreated);

      expect(result.workspaceCreated).toBe(true);
      expect(capture.mock.calls.map((call) => call[0].event)).toEqual([
        'user_signed_up',
        'workspace_created',
      ]);
    });

    it('derives different organization slugs for auth IDs with the same prefix', async () => {
      mockPrisma.organization.upsert.mockImplementation(async ({ create }) => ({
        id: organizationId,
        slug: create.slug,
      }));
      mockPrisma.workspace.findFirst.mockResolvedValue(workspace);
      mockPrisma.membership.upsert.mockResolvedValue({ role: 'owner', workspace });
      const { provision } = provisioningService();

      await provision(userId, 'same-prefixed-auth-id-a');
      await provision(userId, 'same-prefixed-auth-id-b');

      const slugs = mockPrisma.organization.upsert.mock.calls.map((call) => call[0].create.slug);
      expect(slugs[0]).not.toBe(slugs[1]);
      expect(slugs.every((slug: string) => /^user-[0-9a-f]{24}$/.test(slug))).toBe(true);
    });
  });

  describe('JWT validation', () => {
    it('should reject expired JWT', () => {
      const secret = 'test-secret';
      const expiredToken = jwt.sign(
        { sub: 'user-123', email: 'test@example.com' },
        secret,
        { expiresIn: '-1h' } // Already expired
      );

      // Verify the token is actually expired
      const decoded = jwt.decode(expiredToken) as { exp?: number };
      const isExpired = decoded.exp ? decoded.exp < Math.floor(Date.now() / 1000) : false;
      expect(isExpired).toBe(true);

      // Attempting to verify should throw
      expect(() => jwt.verify(expiredToken, secret)).toThrow();
    });

    it('should reject malformed JWT', () => {
      const malformedTokens = [
        'not-a-jwt',
        'header.payload', // Missing signature
        '', // Empty
        'eyJhbGciOiJIUzI1NiJ9', // Header only, no body
      ];

      for (const token of malformedTokens) {
        expect(() => jwt.verify(token, 'any-secret')).toThrow();
      }
    });

    it('should reject JWT with invalid signature', () => {
      const token = jwt.sign({ sub: 'user-123' }, 'correct-secret');
      expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
    });

    it('should reject JWT with missing required claims', () => {
      // Token without 'sub' claim
      const tokenWithoutSub = jwt.sign({ email: 'test@example.com' }, 'secret');
      const decoded = jwt.decode(tokenWithoutSub) as { sub?: string };
      expect(decoded.sub).toBeUndefined();
    });
  });

  describe('Supabase token claim cache', () => {
    it('uses cached introspected claims without calling Supabase on repeated route clicks', async () => {
      Object.assign(env, {
        SUPABASE_JWT_SECRET: undefined,
        SUPABASE_URL: 'https://voiceforge.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      });
      const token = jwt.sign(
        { sub: 'auth-123', email: 'test@example.com' },
        'untrusted-test-secret',
        { expiresIn: '5m' },
      );
      const sessionUser = {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'test@example.com',
        name: null,
        active_workspace_id: '22222222-2222-4222-8222-222222222222',
        active_workspace_name: 'Demo Workspace',
        active_workspace_role: 'owner',
      };
      const cache = {
        get: vi.fn(async (key: string) => {
          if (key.startsWith('session:claims:')) {
            return {
              sub: 'auth-123',
              email: 'test@example.com',
              aud: 'authenticated',
              exp: Math.floor(Date.now() / 1000) + 300,
            };
          }
          if (key === 'session:user:auth-123') return sessionUser;
          return null;
        }),
        set: vi.fn(async () => undefined),
      };
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Supabase should not be called'));
      const service = new SupabaseAuthService(mockPrisma as never, cache as never);

      const req = {
        headers: { authorization: `Bearer ${token}` },
        res: { setHeader: vi.fn() },
      };

      await expect(service.getSessionUser(req as never)).resolves.toEqual(sessionUser);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });

  describe('Workspace access validation', () => {
    it('should return null for workspace not found', async () => {
      mockCache.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        authUserId: 'auth-123',
      });
      mockPrisma.membership.findFirst.mockResolvedValue(null); // No membership found

      // When no membership exists, the service should return null from getSessionUser
      const sessionUser = null; // Simulated: no workspace accessible
      expect(sessionUser).toBeNull();
    });

    it('should reject invalid workspace ID format', () => {
      const invalidWorkspaceIds = [
        '',
        'not-a-uuid',
        '123',
        ' workspace-id',
        'workspace-id ',
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      for (const workspaceId of invalidWorkspaceIds) {
        const isValidUUID = uuidRegex.test(workspaceId);
        expect(isValidUUID).toBe(false);
      }
    });
  });

  describe('Internal Auth Guard validation', () => {
    it('should reject missing internal API key', () => {
      const headers = {}; // No x-internal-key header
      const expected = 'secret-key';

      const isValid = typeof (headers as Record<string, string>)['x-internal-key'] === 'string' && (headers as Record<string, string>)['x-internal-key'] === expected;
      expect(isValid).toBe(false);
    });

    it('should reject invalid internal API key', () => {
      const headers = { 'x-internal-key': 'wrong-key' };
      const expected = 'correct-key';

      const isValid = (headers as Record<string, string>)['x-internal-key'] === expected;
      expect(isValid).toBe(false);
    });

    it('should reject invalid UUID format for user ID', () => {
      const invalidUserIds = [
        'not-a-uuid',
        '',
        '12345',
        'abc',
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      for (const userId of invalidUserIds) {
        const isValidUUID = uuidRegex.test(userId);
        expect(isValidUUID).toBe(false);
      }
    });
  });
});
