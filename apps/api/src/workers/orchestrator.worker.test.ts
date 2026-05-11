import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Job } from 'bullmq';
import { OrchestratorWorker } from './orchestrator.worker';

const mockPrisma = {
  agent: {
    update: vi.fn(),
  },
  agentVersion: {
    create: vi.fn(),
  },
  twilioPhoneNumber: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
};

const mockLlm = {
  name: 'github',
  generate: vi.fn(),
};

const mockRouting = {
  createRule: vi.fn(),
};

const mockQueue = {
  getConnection: vi.fn().mockReturnValue({}),
};

describe('OrchestratorWorker', () => {
  let worker: OrchestratorWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new OrchestratorWorker(
      mockQueue as any,
      mockPrisma as any,
      mockLlm as any,
      mockRouting as any,
    );
  });

  describe('handleGenerate', () => {
    it('calls LLM generate and creates version', async () => {
      mockLlm.generate.mockResolvedValue({
        spec: { name: 'Dental Bot', industry: 'Healthcare', agent_type: 'inbound_receptionist' },
        suggested_name: 'Dental Bot',
        rationale: 'test',
        matched_template_slug: 'receptionist',
      });
      mockPrisma.agentVersion.create.mockResolvedValue({ id: 'ver-1' });

      const job = { name: 'generate', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        prompt: 'Build dental clinic agent',
        crm_providers: ['pipedrive'],
        call_direction: 'inbound',
      }} as Job<any>;

      await worker.processor(job);

      expect(mockLlm.generate).toHaveBeenCalledWith({ prompt: 'Build dental clinic agent', template_slug: undefined });
      expect(mockPrisma.agentVersion.create).toHaveBeenCalled();
    });

    it('creates CRM routing rules for each provider', async () => {
      mockLlm.generate.mockResolvedValue({ spec: { name: 'Test', industry: 'General', agent_type: 'inbound_receptionist' } });
      mockPrisma.agentVersion.create.mockResolvedValue({ id: 'ver-1' });

      const job = { name: 'generate', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        prompt: 'Test',
        crm_providers: ['hubspot', 'salesforce'],
        call_direction: 'both',
      }} as Job<any>;

      await worker.processor(job);

      expect(mockRouting.createRule).toHaveBeenCalledTimes(2);
      expect(mockRouting.createRule).toHaveBeenNthCalledWith(1, 'ws-1', {
        keyword: 'default',
        provider: 'hubspot',
        action: 'primary',
        agent_id: 'agent-1',
      });
      expect(mockRouting.createRule).toHaveBeenNthCalledWith(2, 'ws-1', {
        keyword: 'default',
        provider: 'salesforce',
        action: 'primary',
        agent_id: 'agent-1',
      });
    });

    it('updates agent status through generation pipeline', async () => {
      mockLlm.generate.mockResolvedValue({ spec: { name: 'Test' } });
      mockPrisma.agentVersion.create.mockResolvedValue({ id: 'ver-1' });

      const job = { name: 'generate', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        prompt: 'Test',
        crm_providers: [],
        call_direction: 'both',
      }} as Job<any>;

      await worker.processor(job);

      expect(mockPrisma.agent.update).toHaveBeenCalledTimes(3);
      expect(mockPrisma.agent.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'agent-1' },
        data: { status: 'draft_generating' },
      });
      expect(mockPrisma.agent.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'agent-1' },
        data: expect.objectContaining({ status: 'draft_docs_ready' }),
      });
      expect(mockPrisma.agent.update).toHaveBeenNthCalledWith(3, {
        where: { id: 'agent-1' },
        data: { status: 'draft_crm_ready' },
      });
    });

    it('marks agent failed on error', async () => {
      mockLlm.generate.mockRejectedValue(new Error('LLM error'));

      const job = { name: 'generate', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        prompt: 'Test',
        crm_providers: [],
        call_direction: 'both',
      }} as Job<any>;

      await expect(worker.processor(job)).rejects.toThrow('LLM error');
      expect(mockPrisma.agent.update).toHaveBeenLastCalledWith({
        where: { id: 'agent-1' },
        data: { status: 'failed' },
      });
    });
  });

  describe('handlePublish', () => {
    it('publishes agent and creates audit log', async () => {
      const job = { name: 'publish', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
      }} as Job<any>;

      await worker.processor(job);

      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { status: 'published' },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          actorUserId: 'user-1',
          action: 'agent.published',
          resourceType: 'agent',
          resourceId: 'agent-1',
        },
      });
    });

    it('assigns unassigned phone number to agent', async () => {
      mockPrisma.twilioPhoneNumber.findFirst.mockResolvedValueOnce({
        id: 'num-1',
        phoneNumber: '+15551234567',
        agentId: null,
        status: 'active',
      });
      mockPrisma.twilioPhoneNumber.update.mockResolvedValue({ id: 'num-1' });

      const job = { name: 'publish', data: {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
      }} as Job<any>;

      await worker.processor(job);

      expect(mockPrisma.twilioPhoneNumber.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', agentId: null, status: 'active' },
      });
      expect(mockPrisma.twilioPhoneNumber.update).toHaveBeenCalledWith({
        where: { id: 'num-1' },
        data: { agentId: 'agent-1' },
      });
    });
  });
});