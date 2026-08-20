import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@voiceforge/shared';
import { AgentGenController } from './agent-gen.controller';

const WS = 'ws-1';
const SESSION_ID = 'session-1';

const USER: SessionUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  active_workspace_id: WS,
  active_workspace_name: 'Test Workspace',
  active_workspace_role: 'owner',
};

const SESSION_SNAPSHOT = {
  id: SESSION_ID,
  workspace_id: WS,
  status: 'awaiting_user' as const,
  messages: [],
  current_spec: null,
  spec_valid: false,
  agent_id: null,
  last_error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function makeController() {
  const sessions = {
    createSession: vi.fn().mockResolvedValue(SESSION_SNAPSHOT),
    getActiveSession: vi.fn().mockResolvedValue(SESSION_SNAPSHOT),
    getSession: vi.fn().mockResolvedValue(SESSION_SNAPSHOT),
    sendMessage: vi.fn().mockResolvedValue({ ...SESSION_SNAPSHOT, status: 'generating' }),
    finalize: vi.fn().mockResolvedValue({ session: { ...SESSION_SNAPSHOT, status: 'completed' }, agent: { id: 'agent-1' } }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new AgentGenController(sessions as never),
    sessions,
  };
}

describe('AgentGenController', () => {
  it('create() resumes/creates a session scoped to the workspace and current user', async () => {
    const { controller, sessions } = makeController();

    const result = await controller.create(WS, USER);

    expect(sessions.createSession).toHaveBeenCalledWith(WS, USER.id);
    expect(result).toEqual(SESSION_SNAPSHOT);
  });

  it('active() wraps the active session in a { session } envelope', async () => {
    const { controller, sessions } = makeController();

    const result = await controller.active(WS, USER);

    expect(sessions.getActiveSession).toHaveBeenCalledWith(WS, USER.id);
    expect(result).toEqual({ session: SESSION_SNAPSHOT });
  });

  it('active() returns { session: null } when there is no active session', async () => {
    const { controller, sessions } = makeController();
    sessions.getActiveSession.mockResolvedValue(null);

    const result = await controller.active(WS, USER);

    expect(result).toEqual({ session: null });
  });

  it('get() fetches a session scoped to workspace, user, and sessionId', async () => {
    const { controller, sessions } = makeController();

    const result = await controller.get(WS, SESSION_ID, USER);

    expect(sessions.getSession).toHaveBeenCalledWith(WS, USER.id, SESSION_ID);
    expect(result).toEqual(SESSION_SNAPSHOT);
  });

  it('sendMessage() forwards the dto to the service and returns the updated session', async () => {
    const { controller, sessions } = makeController();
    const dto = { content: 'Build me a dental receptionist' };

    const result = await controller.sendMessage(WS, SESSION_ID, dto, USER);

    expect(sessions.sendMessage).toHaveBeenCalledWith(WS, USER.id, SESSION_ID, dto);
    expect(result.status).toBe('generating');
  });

  it('sendMessage() propagates errors raised by the service (e.g. 409 busy)', async () => {
    const { controller, sessions } = makeController();
    const error = new Error('busy');
    sessions.sendMessage.mockRejectedValue(error);

    await expect(
      controller.sendMessage(WS, SESSION_ID, { content: 'hi' }, USER),
    ).rejects.toThrow('busy');
  });

  it('finalize() forwards the dto and returns { session, agent }', async () => {
    const { controller, sessions } = makeController();
    const dto = { publish: true };

    const result = await controller.finalize(WS, SESSION_ID, dto, USER);

    expect(sessions.finalize).toHaveBeenCalledWith(WS, USER.id, SESSION_ID, dto);
    expect(result.agent).toEqual({ id: 'agent-1' });
    expect(result.session.status).toBe('completed');
  });

  it('remove() deletes the session and returns a deleted acknowledgement', async () => {
    const { controller, sessions } = makeController();

    const result = await controller.remove(WS, SESSION_ID, USER);

    expect(sessions.deleteSession).toHaveBeenCalledWith(WS, USER.id, SESSION_ID);
    expect(result).toEqual({ deleted: true });
  });

  it('remove() does not swallow errors from a failed deletion (e.g. not found)', async () => {
    const { controller, sessions } = makeController();
    sessions.deleteSession.mockRejectedValue(new Error('not found'));

    await expect(controller.remove(WS, SESSION_ID, USER)).rejects.toThrow('not found');
  });
});