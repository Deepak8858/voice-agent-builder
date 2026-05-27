'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentSummary, SessionUser, ToolDetail, ToolType } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';
import { CalendarDays, Contact, MessageSquare, Plug, Save, Ticket, Webhook, X } from 'lucide-react';

const DEFAULT_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "phone": { "type": "string" },
    "appointment_at": { "type": "string" }
  },
  "required": ["name", "phone"]
}`;

const DEFAULT_HEADERS = '{}';

type ToolPreset = {
  id: string;
  label: string;
  description: string;
  icon: typeof Plug;
  toolType: ToolType;
  name: string;
  url: string;
  method: string;
  schema: string;
};

const TOOL_PRESETS: ToolPreset[] = [
  {
    id: 'booking_webhook',
    label: 'Booking webhook',
    description: 'Create or update an appointment in an external scheduler.',
    icon: CalendarDays,
    toolType: 'webhook',
    name: 'create_booking',
    url: 'https://example.com/api/bookings',
    method: 'POST',
    schema: `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "phone": { "type": "string" },
    "appointment_at": { "type": "string" },
    "reason": { "type": "string" }
  },
  "required": ["name", "phone", "appointment_at"]
}`,
  },
  {
    id: 'crm_contact',
    label: 'CRM contact',
    description: 'Send a qualified caller or lead into HubSpot, Salesforce, Pipedrive, or a CRM webhook.',
    icon: Contact,
    toolType: 'webhook',
    name: 'create_crm_contact',
    url: 'https://example.com/api/crm/contacts',
    method: 'POST',
    schema: `{
  "type": "object",
  "properties": {
    "full_name": { "type": "string" },
    "phone": { "type": "string" },
    "email": { "type": "string" },
    "company": { "type": "string" },
    "notes": { "type": "string" }
  },
  "required": ["full_name"]
}`,
  },
  {
    id: 'support_ticket',
    label: 'Support ticket',
    description: 'Open a ticket after the call captures the issue and urgency.',
    icon: Ticket,
    toolType: 'webhook',
    name: 'create_support_ticket',
    url: 'https://example.com/api/tickets',
    method: 'POST',
    schema: `{
  "type": "object",
  "properties": {
    "customer_name": { "type": "string" },
    "phone": { "type": "string" },
    "issue": { "type": "string" },
    "urgency": { "type": "string", "enum": ["low", "normal", "high"] }
  },
  "required": ["customer_name", "issue"]
}`,
  },
  {
    id: 'sms_follow_up',
    label: 'SMS follow-up',
    description: 'Trigger a text confirmation or reminder through Twilio, Zapier, Make, or your own endpoint.',
    icon: MessageSquare,
    toolType: 'webhook',
    name: 'send_follow_up_sms',
    url: 'https://example.com/api/messages/sms',
    method: 'POST',
    schema: `{
  "type": "object",
  "properties": {
    "phone": { "type": "string" },
    "message": { "type": "string" },
    "template": { "type": "string" }
  },
  "required": ["phone", "message"]
}`,
  },
  {
    id: 'google_calendar',
    label: 'Google Calendar',
    description: 'Use the built-in calendar executor for availability checks and event creation.',
    icon: CalendarDays,
    toolType: 'google_calendar',
    name: 'google_calendar_booking',
    url: '',
    method: 'POST',
    schema: `{
  "type": "object",
  "properties": {
    "operation": { "type": "string", "enum": ["find_free_slot", "create_event", "list_events"] },
    "summary": { "type": "string" },
    "start_iso": { "type": "string" },
    "end_iso": { "type": "string" },
    "time_zone": { "type": "string" },
    "duration_minutes": { "type": "integer" },
    "attendees": { "type": "array" },
    "description": { "type": "string" }
  },
  "required": ["operation"]
}`,
  },
  {
    id: 'generic_webhook',
    label: 'Generic webhook',
    description: 'A signed HTTP tool for any custom integration.',
    icon: Webhook,
    toolType: 'webhook',
    name: 'custom_webhook',
    url: 'https://example.com/webhook',
    method: 'POST',
    schema: DEFAULT_INPUT_SCHEMA,
  },
];

function tryParseJson(label: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${(err as Error).message}`);
  }
}

export default function NewToolPage() {
  const router = useRouter();
  const { call } = useApi();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState('create_booking');
  const [description, setDescription] = useState('Creates a booking via partner CRM webhook.');
  const [toolType, setToolType] = useState<ToolType>('webhook');
  const [agentId, setAgentId] = useState('');
  const [url, setUrl] = useState('https://example.com/webhook');
  const [method, setMethod] = useState('POST');
  const [hmacSecret, setHmacSecret] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [headersText, setHeadersText] = useState(DEFAULT_HEADERS);
  const [schemaText, setSchemaText] = useState(DEFAULT_INPUT_SCHEMA);
  const [calendarId, setCalendarId] = useState('primary');
  const [refreshToken, setRefreshToken] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');

  function applyPreset(preset: ToolPreset) {
    setToolType(preset.toolType);
    setName(preset.name);
    setDescription(preset.description);
    setUrl(preset.url);
    setMethod(preset.method);
    setSchemaText(preset.schema);
  }

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => toast.error(`Session: ${err.message}`));
  }, [call]);

  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => call<{ items: AgentSummary[] }>(`/workspaces/${workspaceId}/agents`),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace');
      const headers = toolType === 'google_calendar' ? {} : tryParseJson('Headers', headersText);
      const inputSchema = tryParseJson('Input schema', schemaText);
      const config = toolType === 'google_calendar'
        ? {
          refresh_token: refreshToken,
          client_id: googleClientId || undefined,
          client_secret: googleClientSecret || undefined,
          calendar_id: calendarId || 'primary',
        }
        : {
          url,
          method,
          headers,
          hmac_secret: hmacSecret || undefined,
          timeout_ms: timeoutMs,
        };
      return call<ToolDetail>(`/workspaces/${workspaceId}/tools`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          tool_type: toolType,
          agent_id: agentId || null,
          config,
          input_schema: inputSchema,
          enabled: true,
        }),
      });
    },
    onSuccess: (tool) => {
      toast.success('Tool created.');
      router.push(`/dashboard/integrations/${tool.id}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">New tool</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Webhook tool. Agent calls signed HTTP request with JSON args. HMAC signature lives
          in <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">X-VoiceForge-Signature</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            Starter tools
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {TOOL_PRESETS.map((preset) => {
              const Icon = preset.icon;
              const active = preset.name === name && preset.toolType === toolType;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`rounded-md border p-3 text-left transition hover:border-primary hover:bg-accent ${
                    active ? 'border-primary bg-accent' : 'border-border bg-background'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="h-4 w-4 text-primary" />
                    {preset.label}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {preset.description}
                  </span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              Basics
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label htmlFor="name">Name (snake_case)</Label>
              <Input
                id="name"
                className="mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="create_booking"
              />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                className="mt-1.5"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div>
              <Label>Attach to agent (optional)</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">Workspace-wide</option>
                {agentsQuery.data?.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Tool kind</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={toolType}
                onChange={(e) => {
                  const next = e.target.value as ToolType;
                  setToolType(next);
                  if (next === 'http_get') setMethod('GET');
                  if (next === 'http_post') setMethod('POST');
                }}
              >
                <option value="webhook">Signed webhook</option>
                <option value="http_post">HTTP POST</option>
                <option value="http_get">HTTP GET</option>
                <option value="google_calendar">Google Calendar</option>
              </select>
            </div>
          </CardContent>
        </Card>

        {toolType === 'google_calendar' ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-primary" />
                Calendar connection
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="calendar_id">Calendar ID</Label>
                <Input
                  id="calendar_id"
                  className="mt-1.5"
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                  placeholder="primary"
                />
              </div>
              <div>
                <Label htmlFor="refresh_token">Refresh token</Label>
                <Input
                  id="refresh_token"
                  className="mt-1.5"
                  type="password"
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <Label htmlFor="google_client_id">Client ID (optional)</Label>
                  <Input
                    id="google_client_id"
                    className="mt-1.5"
                    value={googleClientId}
                    onChange={(e) => setGoogleClientId(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="google_client_secret">Client secret (optional)</Label>
                  <Input
                    id="google_client_secret"
                    className="mt-1.5"
                    type="password"
                    value={googleClientSecret}
                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-4 w-4 text-primary" />
                HTTP request
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="url">URL</Label>
                <Input
                  id="url"
                  className="mt-1.5"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-api.example.com/hook"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Method</Label>
                  <select
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option>POST</option>
                    <option>PUT</option>
                    <option>PATCH</option>
                    <option>GET</option>
                    <option>DELETE</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="timeout">Timeout (ms)</Label>
                  <Input
                    id="timeout"
                    className="mt-1.5"
                    type="number"
                    min={100}
                    max={30_000}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value))}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="hmac">HMAC secret (optional)</Label>
                <Input
                  id="hmac"
                  className="mt-1.5"
                  type="password"
                  value={hmacSecret}
                  onChange={(e) => setHmacSecret(e.target.value)}
                  placeholder="Leave empty to skip signing"
                />
              </div>
              <div>
                <Label htmlFor="headers">Extra headers (JSON)</Label>
                <Textarea
                  id="headers"
                  className="mt-1.5 font-mono text-xs"
                  rows={3}
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Input schema (JSON Schema subset)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Subset supported: <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">type: object</code> with{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">properties</code> +{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">required</code>. Each property may set{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">type</code> (string, number,
              integer, boolean, array, object) and <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">enum</code>.
            </p>
            <Textarea
              rows={12}
              className="font-mono text-xs"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !workspaceId || (toolType === 'google_calendar' && !refreshToken)}
          className="gap-2"
        >
          <Save className="h-4 w-4" />
          {create.isPending ? 'Creating…' : 'Create tool'}
        </Button>
        <Button variant="outline" onClick={() => router.push('/dashboard/integrations')} className="gap-2">
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
