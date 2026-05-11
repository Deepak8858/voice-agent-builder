'use client';

import { create } from 'zustand';
import type { AgentSpec } from '@voiceforge/shared';

export interface GenerationStatus {
  agent_id: string;
  status: string;
  steps: {
    spec_generation: { status: string };
    doc_ingest: { status: string; progress: number; total: number };
    crm_setup: { status: string; providers: string[] };
    phone_number: { status: string; number?: string };
    publish: { status: string };
  };
  agent_preview: unknown;
  created_at: string;
  updated_at: string;
}

export interface GenerationResult {
  agent_id?: string;
  status_url?: string;
  spec?: unknown;
  suggested_name?: string;
  rationale?: string;
  matched_template_slug?: string;
}

interface AgentDraftState {
  prompt: string;
  templateSlug: string | null;
  businessName: string;
  timezone: string;
  knowledgeSourceIds: string[];
  crmProviders: string[];
  callDirection: 'inbound' | 'outbound' | 'both';
  voiceConfig: { stt_model?: string; tts_voice?: string } | null;
  generated: GenerationResult | null;
  status: GenerationStatus | null;
  isPolling: boolean;
  draftSpec: AgentSpec | null;
  setPrompt: (p: string) => void;
  setTemplate: (slug: string | null) => void;
  setBusinessName: (n: string) => void;
  setTimezone: (tz: string) => void;
  setKnowledgeSourceIds: (ids: string[]) => void;
  setCrmProviders: (providers: string[]) => void;
  setCallDirection: (dir: 'inbound' | 'outbound' | 'both') => void;
  setVoiceConfig: (config: { stt_model?: string; tts_voice?: string } | null) => void;
  toggleKnowledgeSourceId: (id: string) => void;
  setGenerated: (r: GenerationResult | null) => void;
  setStatus: (s: GenerationStatus | null) => void;
  setIsPolling: (v: boolean) => void;
  setDraftSpec: (s: AgentSpec | null) => void;
  reset: () => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set) => ({
  prompt: '',
  templateSlug: null,
  businessName: '',
  timezone: 'America/Los_Angeles',
  knowledgeSourceIds: [],
  crmProviders: [],
  callDirection: 'both',
  voiceConfig: null,
  generated: null,
  status: null,
  isPolling: false,
  draftSpec: null,
  setPrompt: (prompt) => set({ prompt }),
  setTemplate: (templateSlug) => set({ templateSlug }),
  setBusinessName: (businessName) => set({ businessName }),
  setTimezone: (timezone) => set({ timezone }),
  setKnowledgeSourceIds: (knowledgeSourceIds) => set({ knowledgeSourceIds }),
  setCrmProviders: (crmProviders) => set({ crmProviders }),
  setCallDirection: (callDirection) => set({ callDirection }),
  setVoiceConfig: (voiceConfig) => set({ voiceConfig }),
  toggleKnowledgeSourceId: (id) =>
    set((s) => ({
      knowledgeSourceIds: s.knowledgeSourceIds.includes(id)
        ? s.knowledgeSourceIds.filter((v) => v !== id)
        : [...s.knowledgeSourceIds, id],
    })),
  setGenerated: (generated) => set({ generated }),
  setStatus: (status) => set({ status }),
  setIsPolling: (isPolling) => set({ isPolling }),
  setDraftSpec: (draftSpec) => set({ draftSpec }),
  reset: () =>
    set({
      prompt: '',
      templateSlug: null,
      businessName: '',
      timezone: 'America/Los_Angeles',
      knowledgeSourceIds: [],
      crmProviders: [],
      callDirection: 'both',
      voiceConfig: null,
      generated: null,
      status: null,
      isPolling: false,
      draftSpec: null,
    }),
}));
