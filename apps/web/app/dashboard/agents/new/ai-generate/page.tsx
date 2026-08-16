'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AgentGenSessionSchema,
  AgentSummarySchema,
  type AgentGenSession,
  type KnowledgeSourceSummary,
  type SendGenMessageDto,
  type SessionUser,
} from '@voiceforge/shared';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Send,
  Sparkles,
} from 'lucide-react';
import { AgentCreationModeTabs } from '@/components/agent-creation-mode-tabs';
import { FormModeEditor, type AgentSpecValidationState } from '@/components/form-mode-editor';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';

const MAX_MESSAGE_LENGTH = 4000;
const CRM_PROVIDERS = ['pipedrive', 'hubspot', 'salesforce', 'generic_webhook'] as const;
type CrmProvider = (typeof CRM_PROVIDERS)[number];
type CallDirection = 'inbound' | 'outbound' | 'both';

interface TemplateSummary {
  slug: string;
  name: string;
}

interface ContextDraft {
  templateSlug: string;
  businessName: string;
  timezone: string;
  callDirection: CallDirection;
  crmProviders: CrmProvider[];
  sttModel: string;
  ttsVoice: string;
  knowledgeSourceIds: string[];
}

interface EditedSpecState {
  sourceKey: string;
  spec: unknown;
  isValid: boolean;
}

const DEFAULT_CONTEXT: ContextDraft = {
  templateSlug: '',
  businessName: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  callDirection: 'inbound',
  crmProviders: [],
  sttModel: 'nova-3',
  ttsVoice: 'aura-2-en-us',
  knowledgeSourceIds: [],
};

export default function AiGenerateAgentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { call } = useApi();
  const [message, setMessage] = useState('');
  const [context, setContext] = useState<ContextDraft>(DEFAULT_CONTEXT);
  const [contextOpen, setContextOpen] = useState(true);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [editedSpecState, setEditedSpecState] = useState<EditedSpecState | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const meQuery = useQuery({
    queryKey: ['auth', 'me', 'agent-generation'],
    queryFn: () => call<SessionUser>('/auth/me'),
  });
  const workspaceId = meQuery.data?.active_workspace_id ?? null;

  const activeSessionQuery = useQuery({
    queryKey: ['agent-gen-session', 'active', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const result = await call<{ session: unknown }>(
        `/workspaces/${workspaceId}/agent-gen-sessions/active`,
      );
      return AgentGenSessionSchema.nullable().parse(result.session);
    },
  });

  const sessionId = createdSessionId ?? activeSessionQuery.data?.id ?? null;
  const sessionQuery = useQuery({
    queryKey: ['agent-gen-session', workspaceId, sessionId],
    enabled: Boolean(workspaceId && sessionId),
    queryFn: async () =>
      AgentGenSessionSchema.parse(
        await call<unknown>(`/workspaces/${workspaceId}/agent-gen-sessions/${sessionId}`),
      ),
    refetchInterval: (query) =>
      query.state.data?.status === 'generating' || query.state.data?.status === 'finalizing'
        ? 2000
        : false,
  });
  const session = sessionQuery.data ?? activeSessionQuery.data ?? null;
  const specSourceKey = session ? `${session.id}-${session.updated_at}` : null;
  const activeEditedSpec = editedSpecState?.sourceKey === specSourceKey ? editedSpecState : null;

  const templatesQuery = useQuery({
    queryKey: ['templates', 'agent-generation'],
    queryFn: () => call<{ items: TemplateSummary[] }>('/templates'),
  });
  const knowledgeQuery = useQuery({
    queryKey: ['knowledge-sources', 'workspace', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      call<{ items: KnowledgeSourceSummary[] }>(
        `/workspaces/${workspaceId}/knowledge-sources?scope=workspace`,
      ),
  });

  useEffect(() => {
    if (meQuery.error instanceof Error) {
      toast.error(`Session: ${meQuery.error.message}`);
    }
  }, [meQuery.error]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [session?.messages.length, session?.status]);

  const setSessionData = (next: AgentGenSession) => {
    setCreatedSessionId(next.id);
    queryClient.setQueryData(['agent-gen-session', next.workspace_id, next.id], next);
    queryClient.setQueryData(['agent-gen-session', 'active', next.workspace_id], next);
  };

  const ensureSession = async () => {
    if (!workspaceId) throw new Error('No active workspace. Reload the page and try again.');
    if (session) return session;
    const created = AgentGenSessionSchema.parse(
      await call<unknown>(`/workspaces/${workspaceId}/agent-gen-sessions`, {
        method: 'POST',
      }),
    );
    setSessionData(created);
    return created;
  };

  const sendMutation = useMutation({
    mutationFn: async ({ content, retry = false }: { content: string; retry?: boolean }) => {
      const activeSession = await ensureSession();
      const isFirstMessage = activeSession.messages.length === 0;
      const body: SendGenMessageDto = {
        content,
        ...(retry ? { retry: true } : {}),
        ...(isFirstMessage && !retry ? { context: buildContext(context) } : {}),
      };
      return AgentGenSessionSchema.parse(
        await call<unknown>(
          `/workspaces/${activeSession.workspace_id}/agent-gen-sessions/${activeSession.id}/messages`,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      );
    },
    onSuccess: (next) => {
      setSessionData(next);
      setMessage('');
      setContextOpen(false);
      setEditedSpecState(null);
    },
    onError: (error: Error & { code?: string; details?: unknown }) => {
      if (error.code === 'INVALID_STATUS') {
        void sessionQuery.refetch();
        toast.info('Generation is already running. Reconnected to its progress.');
        return;
      }
      if (error.code === 'RATE_LIMITED') {
        const retryAfter = getRetryAfterSeconds(error.details);
        toast.error(
          retryAfter
            ? `Generation limit reached. Try again in ${formatWait(retryAfter)}.`
            : 'Generation limit reached. Please wait a few minutes and try again.',
        );
        return;
      }
      toast.error(error.message);
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (publish: boolean) => {
      if (!workspaceId || !session) throw new Error('No generation session to finalize.');
      const result = await call<{ session: unknown; agent: unknown }>(
        `/workspaces/${workspaceId}/agent-gen-sessions/${session.id}/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({
            publish,
            ...(activeEditedSpec ? { spec_override: activeEditedSpec.spec } : {}),
          }),
        },
      );
      return {
        session: AgentGenSessionSchema.parse(result.session),
        agent: AgentSummarySchema.parse(result.agent),
      };
    },
    onSuccess: ({ agent }, publish) => {
      toast.success(publish ? 'Agent created and published.' : 'Agent created.');
      router.push(`/dashboard/agents/${agent.id}/builder`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !session) return;
      await call<{ deleted: true }>(`/workspaces/${workspaceId}/agent-gen-sessions/${session.id}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      if (workspaceId && sessionId) {
        queryClient.removeQueries({
          queryKey: ['agent-gen-session', workspaceId, sessionId],
        });
        queryClient.setQueryData(['agent-gen-session', 'active', workspaceId], null);
      }
      setCreatedSessionId(null);
      setMessage('');
      setContext(DEFAULT_CONTEXT);
      setContextOpen(true);
      setEditedSpecState(null);
      toast.success('Started a fresh conversation.');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isGenerating = session?.status === 'generating';
  const isBusy = isGenerating || session?.status === 'finalizing';
  const isCompleted = session?.status === 'completed';
  const isBootstrapping =
    meQuery.isPending || (Boolean(workspaceId) && activeSessionQuery.isPending);
  const canFinalize = Boolean(
    session?.current_spec &&
    session.spec_valid &&
    (session.status === 'awaiting_user' || session.status === 'failed') &&
    (activeEditedSpec?.isValid ?? true),
  );
  const lastUserMessage = useMemo(
    () => [...(session?.messages ?? [])].reverse().find((item) => item.role === 'user'),
    [session?.messages],
  );

  const submitMessage = () => {
    const content = message.trim();
    if (!content || sendMutation.isPending || isBusy || isCompleted) return;
    sendMutation.mutate({ content });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="AI generator"
        title="Build your voice agent in conversation."
        description="Describe the outcome, refine it with the assistant, and edit the generated Agent Spec before creating your agent. Your conversation resumes safely after a refresh."
        actions={
          session ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={deleteMutation.isPending || isBusy}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              Start over
            </Button>
          ) : null
        }
      >
        <AgentCreationModeTabs active="chat" />
      </PageHeader>

      <div className="grid min-h-[720px] gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card className="flex min-h-[680px] flex-col overflow-hidden">
          <CardHeader className="border-b border-border/80 pb-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquareText className="h-4 w-4 text-primary" />
                Agent conversation
              </CardTitle>
              <SessionStatusBadge session={session} />
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <div
              className="ph-no-capture min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5"
              aria-live="polite"
            >
              {isBootstrapping ? (
                <ChatPlaceholder icon={<Loader2 className="h-5 w-5 animate-spin" />}>
                  Restoring your conversation…
                </ChatPlaceholder>
              ) : session?.messages.length ? (
                session.messages.map((item, index) => (
                  <ChatBubble
                    key={`${item.at}-${item.role}-${index}`}
                    role={item.role}
                    content={item.content}
                    at={item.at}
                  />
                ))
              ) : (
                <ChatPlaceholder icon={<Sparkles className="h-5 w-5" />}>
                  Start by describing the calls this agent should handle, the result it should
                  achieve, and when it should involve a human.
                </ChatPlaceholder>
              )}

              {isGenerating ? (
                <div className="flex items-start gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-border bg-muted/50 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      Shaping your Agent Spec…
                    </div>
                  </div>
                </div>
              ) : null}

              {session?.status === 'failed' ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm font-medium text-destructive">Generation failed</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {session.last_error ?? 'The generation could not be completed.'}
                  </p>
                  {lastUserMessage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 gap-2"
                      disabled={sendMutation.isPending}
                      onClick={() =>
                        sendMutation.mutate({ content: lastUserMessage.content, retry: true })
                      }
                    >
                      {sendMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      Retry generation
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div ref={threadEndRef} />
            </div>

            <div className="border-t border-border/80 bg-card p-4">
              <ContextDrawer
                open={contextOpen}
                onOpenChange={setContextOpen}
                context={context}
                onChange={setContext}
                disabled={Boolean(session?.messages.length)}
                templates={templatesQuery.data?.items ?? []}
                templatesPending={templatesQuery.isPending}
                knowledgeSources={knowledgeQuery.data?.items ?? []}
                knowledgePending={knowledgeQuery.isPending}
              />

              <div className="ph-no-capture mt-3 rounded-xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30">
                <Textarea
                  aria-label="Message the agent generator"
                  value={message}
                  maxLength={MAX_MESSAGE_LENGTH}
                  rows={3}
                  disabled={isBootstrapping || isBusy || isCompleted || sendMutation.isPending}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    session?.messages.length
                      ? 'Ask for a change, add a requirement, or clarify the workflow…'
                      : 'Describe the voice agent you want to build…'
                  }
                  className="min-h-24 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <div className="flex items-center justify-between gap-3 px-1 pb-1">
                  <span className="text-xs text-muted-foreground">
                    Enter to send · Shift+Enter for a new line
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {message.length}/{MAX_MESSAGE_LENGTH}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Send message"
                      disabled={
                        !message.trim() ||
                        isBootstrapping ||
                        isBusy ||
                        isCompleted ||
                        sendMutation.isPending
                      }
                      onClick={submitMessage}
                    >
                      {sendMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-[680px] flex-col overflow-hidden">
          <CardHeader className="border-b border-border/80 pb-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="h-4 w-4 text-primary" />
                Agent Spec preview
              </CardTitle>
              {session?.spec_valid ? (
                <Badge variant="secondary" className="gap-1">
                  <Check className="h-3 w-3" />
                  Valid spec
                </Badge>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="ph-no-capture min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {session?.current_spec ? (
              <SpecPreview
                key={specSourceKey}
                spec={session.current_spec}
                onEdited={(spec, validation) => {
                  setEditedSpecState({
                    sourceKey: `${session.id}-${session.updated_at}`,
                    spec,
                    isValid: validation.isValid,
                  });
                }}
              />
            ) : (
              <div className="flex min-h-[460px] items-center justify-center">
                <div className="max-w-sm text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-muted/50 text-muted-foreground">
                    {isGenerating ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Bot className="h-5 w-5" />
                    )}
                  </div>
                  <h2 className="mt-4 text-sm font-medium">
                    {isGenerating
                      ? 'Generating your first spec'
                      : 'Your Agent Spec will appear here'}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Continue the conversation to refine behavior, voice, compliance, handoff, and
                    analytics settings.
                  </p>
                </div>
              </div>
            )}
          </CardContent>

          {session?.current_spec && session.spec_valid && !isBusy && !isCompleted ? (
            <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/80 bg-card/95 p-4 backdrop-blur">
              <Button
                type="button"
                variant="outline"
                disabled={!canFinalize || finalizeMutation.isPending}
                onClick={() => finalizeMutation.mutate(false)}
              >
                Create agent
              </Button>
              <Button
                type="button"
                className="gap-2"
                disabled={!canFinalize || finalizeMutation.isPending}
                onClick={() => finalizeMutation.mutate(true)}
              >
                {finalizeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Create & publish
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  content,
  at,
}: {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex items-start gap-2 ${isUser ? 'justify-end' : ''}`}>
      {!isUser ? (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      ) : null}
      <div className={`max-w-[85%] ${isUser ? 'text-right' : ''}`}>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-sm leading-6 ${
            isUser
              ? 'rounded-tr-md bg-primary text-primary-foreground'
              : 'rounded-tl-md border border-border bg-muted/50 text-foreground'
          }`}
        >
          {content}
        </div>
        <time className="mt-1 block px-1 text-[11px] text-muted-foreground" dateTime={at}>
          {formatMessageTime(at)}
        </time>
      </div>
    </div>
  );
}

function ChatPlaceholder({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center">
      <div className="max-w-xs text-center text-sm leading-6 text-muted-foreground">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-muted/50 text-primary">
          {icon}
        </div>
        {children}
      </div>
    </div>
  );
}

function SessionStatusBadge({ session }: { session: AgentGenSession | null }) {
  if (!session) return <Badge variant="outline">New conversation</Badge>;
  if (session.status === 'generating') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Generating
      </Badge>
    );
  }
  if (session.status === 'finalizing') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Creating agent
      </Badge>
    );
  }
  if (session.status === 'completed') return <Badge variant="secondary">Completed</Badge>;
  if (session.status === 'failed') return <Badge variant="destructive">Needs retry</Badge>;
  return <Badge variant="outline">Ready for your input</Badge>;
}

function ContextDrawer({
  open,
  onOpenChange,
  context,
  onChange,
  disabled,
  templates,
  templatesPending,
  knowledgeSources,
  knowledgePending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: ContextDraft;
  onChange: (context: ContextDraft) => void;
  disabled: boolean;
  templates: TemplateSummary[];
  templatesPending: boolean;
  knowledgeSources: KnowledgeSourceSummary[];
  knowledgePending: boolean;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-full justify-between px-2">
          <span className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Generation context
            {disabled ? <Badge variant="outline">Sent with first message</Badge> : null}
          </span>
          {!disabled ? <span className="text-xs text-muted-foreground">Optional</span> : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <fieldset
          disabled={disabled}
          className="mt-2 space-y-4 rounded-xl border border-border bg-muted/20 p-4 disabled:opacity-60"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="generation-template" className="text-xs">
                Template
              </Label>
              <select
                id="generation-template"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={context.templateSlug}
                disabled={disabled || templatesPending}
                onChange={(event) => onChange({ ...context, templateSlug: event.target.value })}
              >
                <option value="">Auto-match</option>
                {templates.map((template) => (
                  <option key={template.slug} value={template.slug}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="generation-business" className="text-xs">
                Business name
              </Label>
              <Input
                id="generation-business"
                className="mt-1 h-9"
                value={context.businessName}
                maxLength={200}
                onChange={(event) => onChange({ ...context, businessName: event.target.value })}
                placeholder="Smile Dental Clinic"
              />
            </div>
            <div>
              <Label htmlFor="generation-timezone" className="text-xs">
                Timezone
              </Label>
              <Input
                id="generation-timezone"
                className="mt-1 h-9"
                value={context.timezone}
                maxLength={64}
                onChange={(event) => onChange({ ...context, timezone: event.target.value })}
                placeholder="America/New_York"
              />
            </div>
            <div>
              <Label htmlFor="generation-direction" className="text-xs">
                Call direction
              </Label>
              <select
                id="generation-direction"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={context.callDirection}
                onChange={(event) =>
                  onChange({ ...context, callDirection: event.target.value as CallDirection })
                }
              >
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
                <option value="both">Inbound & outbound</option>
              </select>
            </div>
          </div>

          <div>
            <Label className="text-xs">CRM providers</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {CRM_PROVIDERS.map((provider) => {
                const selected = context.crmProviders.includes(provider);
                return (
                  <button
                    key={provider}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      onChange({
                        ...context,
                        crmProviders: selected
                          ? context.crmProviders.filter((item) => item !== provider)
                          : [...context.crmProviders, provider],
                      })
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      selected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {provider.replaceAll('_', ' ')}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="generation-stt" className="text-xs">
                Speech-to-text
              </Label>
              <select
                id="generation-stt"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={context.sttModel}
                onChange={(event) => onChange({ ...context, sttModel: event.target.value })}
              >
                <option value="nova-3">Nova-3</option>
                <option value="nova-2">Nova-2</option>
                <option value="base">Base</option>
              </select>
            </div>
            <div>
              <Label htmlFor="generation-tts" className="text-xs">
                Text-to-speech voice
              </Label>
              <select
                id="generation-tts"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={context.ttsVoice}
                onChange={(event) => onChange({ ...context, ttsVoice: event.target.value })}
              >
                <option value="aura-2-en-us">Aura-2 US English</option>
                <option value="aura-2-en-au">Aura-2 Australian English</option>
                <option value="aura-2-en-gb">Aura-2 British English</option>
              </select>
            </div>
          </div>

          <div>
            <Label className="text-xs">Workspace knowledge</Label>
            {knowledgePending ? (
              <p className="mt-2 text-xs text-muted-foreground">Loading knowledge sources…</p>
            ) : knowledgeSources.length ? (
              <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-lg border border-border bg-background p-3">
                {knowledgeSources.map((source) => (
                  <label key={source.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-border"
                      checked={context.knowledgeSourceIds.includes(source.id)}
                      onChange={() =>
                        onChange({
                          ...context,
                          knowledgeSourceIds: context.knowledgeSourceIds.includes(source.id)
                            ? context.knowledgeSourceIds.filter((id) => id !== source.id)
                            : [...context.knowledgeSourceIds, source.id],
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{source.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {source.source_type} · {source.chunk_count} chunks
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No workspace knowledge sources yet.
              </p>
            )}
          </div>
        </fieldset>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SpecPreview({
  spec: initialSpec,
  onEdited,
}: {
  spec: unknown;
  onEdited: (spec: unknown, validation: AgentSpecValidationState) => void;
}) {
  const [spec, setSpec] = useState(initialSpec);
  const [validation, setValidation] = useState<AgentSpecValidationState>({
    isValid: true,
    issues: [],
    parsedSpec: null,
  });
  const summary = asRecord(spec);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Name" value={getString(summary.name) || 'Untitled agent'} />
        <SummaryCard label="Industry" value={getString(summary.industry) || 'Not set'} />
        <SummaryCard
          label="Agent type"
          value={(getString(summary.agent_type) || 'Not set').replaceAll('_', ' ')}
        />
      </div>
      <Collapsible defaultOpen>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="w-full justify-between px-2">
            <span>Edit generated spec</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <FormModeEditor
            spec={spec}
            onChange={(next) => {
              setSpec(next);
              onEdited(next, validation);
            }}
            defaultMode="form"
            onValidationChange={(nextValidation) => {
              setValidation(nextValidation);
              if (spec !== initialSpec) onEdited(spec, nextValidation);
            }}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/25 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-medium capitalize" title={value}>
        {value}
      </p>
    </div>
  );
}

function buildContext(context: ContextDraft): SendGenMessageDto['context'] {
  return {
    ...(context.templateSlug ? { template_slug: context.templateSlug } : {}),
    ...(context.businessName.trim() ? { business_name: context.businessName.trim() } : {}),
    ...(context.timezone.trim() ? { timezone: context.timezone.trim() } : {}),
    call_direction: context.callDirection,
    ...(context.crmProviders.length ? { crm_providers: context.crmProviders } : {}),
    voice_config: { stt_model: context.sttModel, tts_voice: context.ttsVoice },
    ...(context.knowledgeSourceIds.length
      ? { knowledge_source_ids: context.knowledgeSourceIds }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getRetryAfterSeconds(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null;
  const value = (details as Record<string, unknown>).retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
