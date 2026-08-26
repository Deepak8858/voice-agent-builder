import { describe, expect, it, vi } from 'vitest';
import { createFakePrisma } from '../security/tenant-fake-prisma';
import { AgentOrchestratorService } from '../orchestrator/orchestrator.service';
import { PhoneNumbersService } from '../phone-numbers/phone-numbers.service';

/**
 * "All critical actions must create audit logs" (AGENTS.md rule 6).
 *
 * These three mutations had no audit record: publishing puts an agent on live
 * calls, and assigning or releasing a number changes who owns a phone line and
 * where inbound calls are routed. Without a record there is no way to answer
 * "who pointed this number at that agent" after the fact - and for release, the
 * row itself is deleted, so the audit entry is the only surviving trace.
 *
 * Each test also asserts the *negative* case, because an audit log written
 * before the scoped write succeeds is worse than none: it records mutations
 * that never happened and would make a refused cross-tenant attempt look like
 * a completed action.
 */

const WORKSPACE_ID = 'ws-aaaaaaaa';
const OTHER_WORKSPACE_ID = 'ws-bbbbbbbb';
const ACTOR_ID = 'user-aaaaaaaa';

const auditStub = () => ({ log: vi.fn(async () => undefined) });

describe('audit: agent publish', () => {
  function makeService() {
    const prisma = createFakePrisma({
      agent: [
        { id: 'agent-a', workspaceId: WORKSPACE_ID, status: 'draft', versions: [] },
        { id: 'agent-b', workspaceId: OTHER_WORKSPACE_ID, status: 'draft', versions: [] },
      ],
    });
    const queue = { enqueue: vi.fn(async () => undefined) };
    const audit = auditStub();
    return {
      audit,
      service: new AgentOrchestratorService(prisma as never, queue as never, audit as never),
    };
  }

  it('records the workspace, actor and agent on a successful publish', async () => {
    const { audit, service } = makeService();

    await service.publish(WORKSPACE_ID, 'agent-a', ACTOR_ID);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorUserId: ACTOR_ID,
        resourceType: 'agent',
        resourceId: 'agent-a',
      }),
    );
  });

  it('writes no audit entry when the agent belongs to another workspace', async () => {
    const { audit, service } = makeService();

    await expect(service.publish(WORKSPACE_ID, 'agent-b', ACTOR_ID)).rejects.toThrow();

    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('audit: phone number assignment and release', () => {
  function makeService() {
    const prisma = createFakePrisma({
      twilioPhoneNumber: [
        {
          id: 'num-a',
          workspaceId: WORKSPACE_ID,
          agentId: null,
          type: 'byo',
          twilioSid: null,
          phoneNumber: '+15550001',
        },
        {
          id: 'num-b',
          workspaceId: OTHER_WORKSPACE_ID,
          agentId: null,
          type: 'byo',
          twilioSid: null,
          phoneNumber: '+15550002',
        },
      ],
      agent: [
        { id: 'agent-a', workspaceId: WORKSPACE_ID, name: 'A' },
        { id: 'agent-b', workspaceId: OTHER_WORKSPACE_ID, name: 'B' },
      ],
    });
    const audit = auditStub();
    return { prisma, audit, service: new PhoneNumbersService(prisma as never, audit as never) };
  }

  it('records a successful assignment with the acting user', async () => {
    const { audit, service } = makeService();

    await service.assignToAgent(WORKSPACE_ID, 'num-a', 'agent-a', ACTOR_ID);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorUserId: ACTOR_ID,
        action: 'phone_number.assign',
        resourceType: 'twilio_phone_number',
        resourceId: 'num-a',
        metadata: { agent_id: 'agent-a' },
      }),
    );
  });

  it('writes no audit entry when the number belongs to another workspace', async () => {
    const { audit, service } = makeService();

    await expect(service.assignToAgent(WORKSPACE_ID, 'num-b', 'agent-a', ACTOR_ID)).rejects.toThrow();

    expect(audit.log).not.toHaveBeenCalled();
  });

  /**
   * Release deletes the row, so the audit metadata is the only place the
   * number itself survives. Capturing it before the delete is the point.
   */
  it('records a successful release including the number that was given up', async () => {
    const { audit, service } = makeService();
    await service.assignToAgent(WORKSPACE_ID, 'num-a', 'agent-a', ACTOR_ID);
    audit.log.mockClear();

    await service.release(WORKSPACE_ID, 'num-a', ACTOR_ID);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorUserId: ACTOR_ID,
        action: 'phone_number.release',
        resourceType: 'twilio_phone_number',
        resourceId: 'num-a',
        metadata: expect.objectContaining({
          phone_number: '+15550001',
          previous_agent_id: 'agent-a',
        }),
      }),
    );
  });

  it('writes no audit entry when releasing a number owned by another workspace', async () => {
    const { prisma, audit, service } = makeService();

    await service.release(WORKSPACE_ID, 'num-b', ACTOR_ID);

    expect(audit.log).not.toHaveBeenCalled();
    expect(prisma.rowsOf('twilioPhoneNumber').map((r) => r['id'])).toContain('num-b');
  });

  /**
   * The controller passes `user?.id ?? null`. `AuditService` accepts a null
   * actor (see AuditPayload), so a missing session must still produce a record
   * rather than throwing or silently skipping the log.
   */
  it('still records the mutation when the acting user is unavailable', async () => {
    const { audit, service } = makeService();

    await service.assignToAgent(WORKSPACE_ID, 'num-a', 'agent-a', null);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'phone_number.assign', actorUserId: null }),
    );
  });
});
