'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentSummary, SessionUser, ToolDetail } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

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
  const [agentId, setAgentId] = useState('');
  const [url, setUrl] = useState('https://example.com/webhook');
  const [method, setMethod] = useState('POST');
  const [hmacSecret, setHmacSecret] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [headersText, setHeadersText] = useState(DEFAULT_HEADERS);
  const [schemaText, setSchemaText] = useState(DEFAULT_INPUT_SCHEMA);

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
      const headers = tryParseJson('Headers', headersText);
      const inputSchema = tryParseJson('Input schema', schemaText);
      return call<ToolDetail>(`/workspaces/${workspaceId}/tools`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          tool_type: 'webhook',
          agent_id: agentId || null,
          config: {
            url,
            method,
            headers,
            hmac_secret: hmacSecret || undefined,
            timeout_ms: timeoutMs,
          },
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
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          New tool
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Webhook tool. Agent calls signed HTTP request with JSON args. HMAC signature lives
          in <code>X-VoiceForge-Signature</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <CardTitle>Basics</CardTitle>
          <div>
            <Label htmlFor="name">Name (snake_case)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="create_booking"
            />
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label>Attach to agent (optional)</Label>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Workspace-wide</option>
              {agentsQuery.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <CardTitle>HTTP request</CardTitle>
          <div>
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-api.example.com/hook"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Method</Label>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
                <option>GET</option>
                <option>DELETE</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="timeout">Timeout (ms)</Label>
              <Input
                id="timeout"
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
              rows={3}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </Card>

        <Card className="flex flex-col gap-3 lg:col-span-2">
          <CardTitle>Input schema (JSON Schema subset)</CardTitle>
          <p className="text-xs text-zinc-500">
            Subset supported: <code>type: object</code> with <code>properties</code> +
            <code>required</code>. Each property may set <code>type</code> (string, number,
            integer, boolean, array, object) and <code>enum</code>.
          </p>
          <Textarea
            rows={12}
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            className="font-mono text-xs"
          />
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => create.mutate()} disabled={create.isPending || !workspaceId}>
          {create.isPending ? 'Creating…' : 'Create tool'}
        </Button>
        <Button variant="ghost" onClick={() => router.push('/dashboard/integrations')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
