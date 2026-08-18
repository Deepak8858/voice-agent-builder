import {
  BookOpenText,
  GitFork,
  HelpCircle,
  LifeBuoy,
  MessageSquare,
  PhoneForwarded,
  Play,
  Send,
  Square,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { NodeCardTheme } from './node-card';

export interface NodeMeta {
  type: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Classes for palette entries. */
  palette: string;
  theme: NodeCardTheme;
}

export const NODE_META: Record<string, NodeMeta> = {
  start: {
    type: 'start',
    label: 'Start',
    description: 'Where every call begins',
    icon: Play,
    palette: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    theme: {
      border: 'border-emerald-500',
      bg: 'bg-emerald-50 dark:bg-emerald-950/40',
      icon: 'bg-emerald-500/15 text-emerald-600',
      title: 'text-emerald-600',
      text: 'text-emerald-900 dark:text-emerald-100',
      handle: '!bg-emerald-500',
    },
  },
  speak: {
    type: 'speak',
    label: 'Speak',
    description: 'Agent says something',
    icon: MessageSquare,
    palette: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    theme: {
      border: 'border-blue-400',
      bg: 'bg-blue-50 dark:bg-blue-950/40',
      icon: 'bg-blue-500/15 text-blue-600',
      title: 'text-blue-500',
      text: 'text-blue-900 dark:text-blue-100',
      handle: '!bg-blue-400',
    },
  },
  ask_question: {
    type: 'ask_question',
    label: 'Ask Question',
    description: 'Ask and capture an answer',
    icon: HelpCircle,
    palette: 'bg-violet-500/10 text-violet-600 border-violet-500/20',
    theme: {
      border: 'border-violet-400',
      bg: 'bg-violet-50 dark:bg-violet-950/40',
      icon: 'bg-violet-500/15 text-violet-600',
      title: 'text-violet-500',
      text: 'text-violet-900 dark:text-violet-100',
      handle: '!bg-violet-400',
    },
  },
  condition: {
    type: 'condition',
    label: 'Condition',
    description: 'Branch on true/false',
    icon: GitFork,
    palette: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    theme: {
      border: 'border-amber-400',
      bg: 'bg-amber-50 dark:bg-amber-950/40',
      icon: 'bg-amber-500/15 text-amber-600',
      title: 'text-amber-500',
      text: 'text-amber-900 dark:text-amber-100',
      handle: '!bg-amber-400',
    },
  },
  knowledge_lookup: {
    type: 'knowledge_lookup',
    label: 'Knowledge',
    description: 'Look up knowledge base',
    icon: BookOpenText,
    palette: 'bg-cyan-500/10 text-cyan-700 border-cyan-500/20',
    theme: {
      border: 'border-cyan-400',
      bg: 'bg-cyan-50 dark:bg-cyan-950/40',
      icon: 'bg-cyan-500/15 text-cyan-700',
      title: 'text-cyan-600',
      text: 'text-cyan-900 dark:text-cyan-100',
      handle: '!bg-cyan-400',
    },
  },
  tool_call: {
    type: 'tool_call',
    label: 'Tool Call',
    description: 'Run a connected tool',
    icon: Wrench,
    palette: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
    theme: {
      border: 'border-orange-400',
      bg: 'bg-orange-50 dark:bg-orange-950/40',
      icon: 'bg-orange-500/15 text-orange-600',
      title: 'text-orange-500',
      text: 'text-orange-900 dark:text-orange-100',
      handle: '!bg-orange-400',
    },
  },
  transfer: {
    type: 'transfer',
    label: 'Transfer',
    description: 'Hand off to a human',
    icon: PhoneForwarded,
    palette: 'bg-red-500/10 text-red-600 border-red-500/20',
    theme: {
      border: 'border-red-400',
      bg: 'bg-red-50 dark:bg-red-950/40',
      icon: 'bg-red-500/15 text-red-600',
      title: 'text-red-500',
      text: 'text-red-900 dark:text-red-100',
      handle: '!bg-red-400',
    },
  },
  send_message: {
    type: 'send_message',
    label: 'Send Message',
    description: 'Send an SMS or email',
    icon: Send,
    palette: 'bg-teal-500/10 text-teal-700 border-teal-500/20',
    theme: {
      border: 'border-teal-400',
      bg: 'bg-teal-50 dark:bg-teal-950/40',
      icon: 'bg-teal-500/15 text-teal-700',
      title: 'text-teal-600',
      text: 'text-teal-900 dark:text-teal-100',
      handle: '!bg-teal-400',
    },
  },
  fallback: {
    type: 'fallback',
    label: 'Fallback',
    description: 'Safe response when unsure',
    icon: LifeBuoy,
    palette: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
    theme: {
      border: 'border-slate-400',
      bg: 'bg-slate-50 dark:bg-slate-950/40',
      icon: 'bg-slate-500/15 text-slate-600',
      title: 'text-slate-500',
      text: 'text-slate-900 dark:text-slate-100',
      handle: '!bg-slate-400',
    },
  },
  end: {
    type: 'end',
    label: 'End',
    description: 'Where the call finishes',
    icon: Square,
    palette: 'bg-muted text-muted-foreground border-border',
    theme: {
      border: 'border-border',
      bg: 'bg-muted',
      icon: 'bg-muted-foreground/15 text-muted-foreground',
      title: 'text-muted-foreground',
      text: 'text-foreground',
      handle: '!bg-muted-foreground',
    },
  },
};

export function getNodeMeta(type: string | undefined): NodeMeta {
  return (type && NODE_META[type]) || (NODE_META['end'] as NodeMeta);
}
