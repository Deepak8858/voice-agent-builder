'use client';

import { create } from 'zustand';
import type { AgentSpec, GenerateAgentResult } from '@voiceforge/shared';

interface AgentDraftState {
  prompt: string;
  templateSlug: string | null;
  businessName: string;
  timezone: string;
  knowledgeSourceIds: string[];
  generated: GenerateAgentResult | null;
  draftSpec: AgentSpec | null;
  setPrompt: (p: string) => void;
  setTemplate: (slug: string | null) => void;
  setBusinessName: (n: string) => void;
  setTimezone: (tz: string) => void;
  setKnowledgeSourceIds: (ids: string[]) => void;
  toggleKnowledgeSourceId: (id: string) => void;
  setGenerated: (r: GenerateAgentResult | null) => void;
  setDraftSpec: (s: AgentSpec | null) => void;
  reset: () => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set) => ({
  prompt: '',
  templateSlug: null,
  businessName: '',
  timezone: 'America/Los_Angeles',
  knowledgeSourceIds: [],
  generated: null,
  draftSpec: null,
  setPrompt: (prompt) => set({ prompt }),
  setTemplate: (templateSlug) => set({ templateSlug }),
  setBusinessName: (businessName) => set({ businessName }),
  setTimezone: (timezone) => set({ timezone }),
  setKnowledgeSourceIds: (knowledgeSourceIds) => set({ knowledgeSourceIds }),
  toggleKnowledgeSourceId: (id) =>
    set((s) => ({
      knowledgeSourceIds: s.knowledgeSourceIds.includes(id)
        ? s.knowledgeSourceIds.filter((v) => v !== id)
        : [...s.knowledgeSourceIds, id],
    })),
  setGenerated: (generated) => set({ generated, draftSpec: generated?.spec ?? null }),
  setDraftSpec: (draftSpec) => set({ draftSpec }),
  reset: () =>
    set({
      prompt: '',
      templateSlug: null,
      businessName: '',
      timezone: 'America/Los_Angeles',
      knowledgeSourceIds: [],
      generated: null,
      draftSpec: null,
    }),
}));
