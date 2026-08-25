import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestratorController } from './orchestrator.controller';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import type { SessionUser } from '@voiceforge/shared';

function serviceStub() {
  return {
    startGeneration: vi.fn(async () => ({ agentId: 'agent-1' })),
    getStatus: vi.fn(async () => ({ status: 'ready' })),
    publish: vi.fn(async () => undefined),
  };
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const CALLER: SessionUser = {
  id: USER_ID,
  email: 'caller@example.com',
  name: null,
  active_workspace_id: WORKSPACE_ID,
  active_workspace_role: 'owner',
  active_workspace_name: 'Own Workspace',
};

const NO_WORKSPACE: SessionUser = { ...CALLER, active_workspace_id: null };

describe('AgentOrchestratorController', () => {
  /**
   * The tenant used to be derived as
   * `req.workspace?.id ?? req.user?.workspaceId ?? req.user?.id ?? ''`.
   * `req.workspace` is never assigned anywhere and `SessionUser` has no
   * `workspaceId`, so it collapsed to the caller's *user id*. These assertions
   * pin the workspace id specifically, and would fail if the user-id fallback
   * came back.
   */
  it('scopes generation to the session workspace, not the user id', async () => {
    const orchestrator = serviceStub();
    const controller = new AgentOrchestratorController(orchestrator as never);
    const dto = { prompt: 'a dental receptionist' };

    await controller.startGeneration(CALLER, dto as never);

    expect(orchestrator.startGeneration).toHaveBeenCalledWith(WORKSPACE_ID, USER_ID, dto);
  });

  it('scopes status reads to the session workspace', async () => {
    const orchestrator = serviceStub();
    const controller = new AgentOrchestratorController(orchestrator as never);

    await controller.getStatus(CALLER, 'agent-1');

    expect(orchestrator.getStatus).toHaveBeenCalledWith(WORKSPACE_ID, 'agent-1');
  });

  it('scopes publish to the session workspace', async () => {
    const orchestrator = serviceStub();
    const controller = new AgentOrchestratorController(orchestrator as never);

    await expect(controller.publish(CALLER, 'agent-1')).resolves.toEqual({ success: true });

    expect(orchestrator.publish).toHaveBeenCalledWith(WORKSPACE_ID, 'agent-1', USER_ID);
  });

  // The old derivation ended in `?? ''`, which produced a query that matched
  // nothing while still returning 200. Failing closed is the observable
  // difference.
  it('refuses every route when the session has no active workspace', async () => {
    const orchestrator = serviceStub();
    const controller = new AgentOrchestratorController(orchestrator as never);

    await expect(
      controller.startGeneration(NO_WORKSPACE, { prompt: 'x' } as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(controller.getStatus(NO_WORKSPACE, 'agent-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(controller.publish(NO_WORKSPACE, 'agent-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    expect(orchestrator.startGeneration).not.toHaveBeenCalled();
    expect(orchestrator.getStatus).not.toHaveBeenCalled();
    expect(orchestrator.publish).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const orchestrator = serviceStub();
    const controller = new AgentOrchestratorController(orchestrator as never);

    await expect(controller.getStatus(undefined, 'agent-1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(orchestrator.getStatus).not.toHaveBeenCalled();
  });
});
